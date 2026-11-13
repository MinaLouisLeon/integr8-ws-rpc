import { describe, expect, it, vi } from 'vitest';
import { RpcError } from '../core/rpcError.js';
import { chunkBinary } from './chunkBinary.js';

describe('chunkBinary', () => {
  it('validates the whole input budget before any Blob read or progress notification', () => {
    const blob = new Blob(['oversized']);
    const read = vi.spyOn(blob, 'slice');
    const progress = vi.fn();
    expect(() => chunkBinary(blob, { maxBytes: 1, onProgress: progress })).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    for (const chunkBytes of [0, -1, NaN, Infinity, 1.5, 1048577]) {
      expect(() => chunkBinary(blob, { maxBytes: 100, chunkBytes })).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTION' }),
      );
    }
  });

  it('chunks only the input view and yields independent copies with local monotonic progress', async () => {
    const bytes = new Uint8Array([99, 1, 2, 3, 4, 5, 99]);
    const seen: Array<{ producedBytes: number; totalBytes: number; done: boolean }> = [];
    const source = chunkBinary(bytes.subarray(1, 6), {
      maxBytes: 5,
      chunkBytes: 2,
      onProgress: (event) => {
        expect(Object.isFrozen(event)).toBe(true);
        seen.push(event);
      },
    });
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) chunks.push(chunk);
    expect(chunks.map((value) => [...value])).toEqual([[1, 2], [3, 4], [5]]);
    if (chunks[0]) chunks[0][0] = 88;
    expect(bytes[1]).toBe(1);
    expect(seen.map((event) => [event.producedBytes, event.done])).toEqual([
      [0, false],
      [2, false],
      [4, false],
      [5, false],
      [5, true],
    ]);
  });

  it('completes zero-byte input without yielding an empty chunk', async () => {
    const progress: boolean[] = [];
    const iterator = chunkBinary(new Uint8Array(), {
      maxBytes: 0,
      onProgress: (value) => {
        progress.push(value.done);
      },
    });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(progress).toEqual([false, true]);
  });

  it('does not let an overridden subarray method expand a bounded copy', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const method = vi.spyOn(source, 'subarray').mockImplementation(() => source);
    const chunks = chunkBinary(source, { maxBytes: 3, chunkBytes: 1 });
    const sizes: number[] = [];
    for await (const chunk of chunks) sizes.push(chunk.byteLength);
    expect(sizes).toEqual([1, 1, 1]);
    expect(method).not.toHaveBeenCalled();
  });

  it('normalizes option getter failures without retaining their causes', () => {
    const options = {
      get maxBytes(): number {
        throw new RpcError('AUTH_FAILED', { cause: 'fake-secret' });
      },
    };
    try {
      chunkBinary(new Uint8Array([1]), options);
      throw new Error('Expected invalid options.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_OPTION' });
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('serializes demanded pulls without prefetch and uses the 64 KiB default', async () => {
    const iterator = chunkBinary(new Uint8Array(65_537), { maxBytes: 65_537 });
    const first = iterator.next();
    const second = iterator.next();
    expect((await first).value?.byteLength).toBe(65_536);
    expect((await second).value?.byteLength).toBe(1);
    expect((await iterator.next()).done).toBe(true);
  });

  it('does not emit completion on early return or abort during an observer', async () => {
    const progress: boolean[] = [];
    const iterator = chunkBinary(new Uint8Array([1]), {
      maxBytes: 1,
      onProgress: (event) => {
        progress.push(event.done);
      },
    });
    await iterator.next();
    await iterator.return?.();
    expect(progress).toEqual([false, false]);
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const cancelled = chunkBinary(new Uint8Array([1]), {
      maxBytes: 1,
      signal: controller.signal,
      onProgress: () => {
        entered.resolve();
        return late.promise;
      },
    });
    const pending = cancelled.next();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await entered.promise;
    controller.abort('fake-secret');
    await rejected;
    late.reject(new Error('Late callback failure.'));
    await Promise.resolve();
  });

  it('never reads ahead and waits for progress before yielding', async () => {
    const progress = Promise.withResolvers<void>();
    const blob = new Blob(['abcd']);
    const read = vi.spyOn(blob, 'slice');
    const iterator = chunkBinary(blob, {
      maxBytes: 4,
      chunkBytes: 2,
      onProgress: (value) => (value.producedBytes === 2 ? progress.promise : undefined),
    });
    expect(read).not.toHaveBeenCalled();
    const first = iterator.next();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    progress.resolve();
    expect([...((await first).value ?? [])]).toEqual([97, 98]);
    expect(read).toHaveBeenCalledTimes(1);
    await iterator.return?.();
  });

  it('pre-aborts safely and interrupts a noncooperative progress callback on return', async () => {
    const controller = new AbortController();
    controller.abort('fake-secret');
    const cancelled = chunkBinary(new Uint8Array([1]), { maxBytes: 1, signal: controller.signal });
    await expect(cancelled.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    const entered = Promise.withResolvers<void>();
    const iterator = chunkBinary(new Uint8Array([1]), {
      maxBytes: 1,
      onProgress: () => {
        entered.resolve();
        return new Promise<void>(() => {});
      },
    });
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await entered.promise;
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined });
    await rejected;
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('suppresses a late Blob result after abort and releases the caller listener', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const read = Promise.withResolvers<ArrayBuffer>();
    const entered = Promise.withResolvers<void>();
    const blob = new Blob(['x']);
    vi.spyOn(blob, 'slice').mockReturnValue(
      Object.assign(new Blob(['x']), {
        arrayBuffer: () => {
          entered.resolve();
          return read.promise;
        },
      }),
    );
    const done: boolean[] = [];
    const iterator = chunkBinary(blob, {
      maxBytes: 1,
      signal: controller.signal,
      onProgress: (value) => {
        done.push(value.done);
      },
    });
    const pending = iterator.next();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await entered.promise;
    controller.abort('fake-secret');
    await rejected;
    read.resolve(new Uint8Array([1]).buffer);
    await Promise.resolve();
    expect(done).not.toContain(true);
    expect(remove).toHaveBeenCalled();
  });

  it('preserves progress failures while sanitizing source-read failures', async () => {
    const error = new Error('Application callback failure.');
    const failed = chunkBinary(new Uint8Array([1]), {
      maxBytes: 1,
      onProgress: () => {
        throw error;
      },
    });
    await expect(failed.next()).rejects.toBe(error);
    const blob = new Blob(['x']);
    vi.spyOn(blob, 'slice').mockImplementation(() => {
      throw new Error('fake-secret');
    });
    const iterator = chunkBinary(blob, { maxBytes: 1 });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('releases a completion-observer wait on abort after local EOF was committed', async () => {
    const controller = new AbortController();
    const complete = Promise.withResolvers<void>();
    const iterator = chunkBinary(new Uint8Array(), {
      maxBytes: 0,
      signal: controller.signal,
      onProgress: (event) => {
        if (!event.done) return;
        complete.resolve();
        return new Promise<void>(() => {});
      },
    });
    const pending = iterator.next();
    await complete.promise;
    controller.abort();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });
});
