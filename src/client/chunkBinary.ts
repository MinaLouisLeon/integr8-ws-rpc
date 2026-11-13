import { runOperation } from '../core/operation.js';
import { RpcError } from '../core/rpcError.js';

/** @inline */
interface BinaryProgress {
  readonly producedBytes: number;
  readonly totalBytes: number;
  readonly done: boolean;
}
/** @inline */
interface BinaryOptions {
  readonly maxBytes: number;
  readonly chunkBytes?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Readonly<BinaryProgress>) => void | PromiseLike<void>;
}
type ChunkResult = IteratorResult<Uint8Array, undefined>;

/**
 * Pull bounded, independent byte copies from a Blob or byte view. maxBytes is an explicit input
 * budget; chunkBytes defaults to 64 KiB. Progress means locally produced bytes, not wire delivery
 * or acknowledgement. Input/retained chunks and encoded-message overhead remain caller concerns.
 * Abort/return stops local delivery even when a platform read or progress callback is uncooperative.
 */
export function chunkBinary(
  source: Blob | Uint8Array,
  options: BinaryOptions,
): AsyncIterableIterator<Uint8Array> {
  let input: Blob | Uint8Array | undefined = source;
  let total: number;
  let chunkBytes: number;
  let signal: AbortSignal | undefined;
  let progress: BinaryOptions['onProgress'];
  let budget: number;
  try {
    if (!(source instanceof Blob) && !(source instanceof Uint8Array))
      throw new RpcError('INVALID_OPTION');
    if (typeof options !== 'object' || options === null) throw new RpcError('INVALID_OPTION');
    budget = options.maxBytes;
    chunkBytes = options.chunkBytes === undefined ? 65_536 : options.chunkBytes;
    signal = options.signal;
    progress = options.onProgress;
    total = source instanceof Blob ? source.size : source.byteLength;
    if (
      !Number.isSafeInteger(budget) ||
      budget < 0 ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 1 ||
      chunkBytes > 1_048_576 ||
      (progress !== undefined && typeof progress !== 'function') ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    )
      throw new RpcError('INVALID_OPTION');
  } catch {
    throw new RpcError('INVALID_OPTION');
  }
  if (total > budget) throw new RpcError('PAYLOAD_TOO_LARGE');
  const controller = new AbortController();
  let state: 'active' | 'completed' | 'returned' | 'failed' | 'cancelled' = 'active';
  let offset = 0;
  let started = false;
  // Serialize only requested pulls, not produced byte chunks. Nothing is read ahead of demand.
  let tail: Promise<void> = Promise.resolve();
  const done = (): ChunkResult => ({ done: true, value: undefined });
  function detach(): void {
    signal?.removeEventListener('abort', abort);
  }
  function release(): void {
    detach();
    input = undefined;
    progress = undefined;
  }
  function abort(): void {
    if (state !== 'active' && state !== 'completed') return;
    if (state === 'active') state = 'cancelled';
    controller.abort(new RpcError('CANCELLED'));
    release();
  }
  function assertActive(): void {
    if (controller.signal.aborted) throw new RpcError('CANCELLED');
  }
  async function notify(producedBytes: number, complete: boolean): Promise<void> {
    const callback = progress;
    if (!callback) return;
    await runOperation(
      () =>
        Promise.resolve(
          callback(
            Object.freeze({
              producedBytes,
              totalBytes: total,
              done: complete,
            }),
          ),
        ),
      { lifetime: controller.signal },
    );
  }
  async function pull(): Promise<ChunkResult> {
    if (state !== 'active') return done();
    try {
      assertActive();
      if (!started) {
        started = true;
        await notify(0, false);
        assertActive();
      }
      if (offset === total) {
        // EOF is committed before its completion notification; a later external abort cannot
        // retroactively undo local EOF. Callback exceptions still propagate to this final pull.
        state = 'completed';
        input = undefined;
        try {
          await notify(total, true);
        } finally {
          release();
        }
        return done();
      }
      const end = Math.min(total, offset + chunkBytes);
      const current = input;
      let bytes: Uint8Array;
      try {
        if (current instanceof Uint8Array) {
          bytes = new Uint8Array(
            new Uint8Array(current.buffer, current.byteOffset + offset, end - offset),
          );
        } else if (current instanceof Blob) {
          const buffer = await runOperation(() => current.slice(offset, end).arrayBuffer(), {
            lifetime: controller.signal,
          });
          assertActive();
          const view = new Uint8Array(buffer);
          if (view.byteLength !== end - offset) throw new RpcError('INTERNAL');
          bytes = new Uint8Array(view);
        } else {
          throw new RpcError('CANCELLED');
        }
      } catch {
        assertActive();
        throw new RpcError('INTERNAL');
      }
      assertActive();
      await notify(end, false);
      assertActive();
      offset = end;
      return { done: false, value: bytes };
    } catch (error) {
      if (state === 'active') state = 'failed';
      release();
      throw error;
    }
  }
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const iterator: AsyncIterableIterator<Uint8Array> = {
    [Symbol.asyncIterator]: (): AsyncIterableIterator<Uint8Array> => iterator,
    next: (): Promise<ChunkResult> => {
      if (state === 'cancelled') return Promise.reject(new RpcError('CANCELLED'));
      if (state !== 'active') return Promise.resolve(done());
      const pending = runOperation(
        () => {
          const requested = tail.then(pull);
          tail = requested.then(
            () => {},
            () => {},
          );
          return requested;
        },
        { lifetime: controller.signal },
      );
      return pending.catch((error: unknown) => {
        // Aborting an uncooperative completion observer releases its wait without undoing EOF.
        if (state === 'completed' && controller.signal.aborted) return done();
        throw error;
      });
    },
    return: (): Promise<ChunkResult> => {
      if (state === 'active') state = 'returned';
      controller.abort(new RpcError('CANCELLED'));
      release();
      return Promise.resolve(done());
    },
    throw: (error?: unknown): Promise<ChunkResult> => {
      if (state === 'active') state = 'failed';
      controller.abort(new RpcError('CANCELLED'));
      release();
      return Promise.reject(error);
    },
  };
  return iterator;
}
