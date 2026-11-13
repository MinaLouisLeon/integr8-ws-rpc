import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOperation } from './operation.js';
import { RpcError } from './rpcError.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('operation lifetime', () => {
  it('does not invoke an operation whose caller has already cancelled', async () => {
    const controller = new AbortController();
    controller.abort('fake-secret');
    let invoked = false;
    await expect(
      runOperation(
        async () => {
          invoked = true;
        },
        {
          signal: controller.signal,
          timeoutMs: 100,
        },
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(invoked).toBe(false);
  });

  it('aborts the handler on deadline and ignores its late completion', async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<string>();
    let handlerSignal: AbortSignal | undefined;
    const result = runOperation(
      (signal) => {
        handlerSignal = signal;
        return pending.promise;
      },
      { timeoutMs: 10 },
    );
    const rejected = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(handlerSignal?.aborted).toBe(true);
    pending.resolve('late');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes application failures through by identity and releases its timer', async () => {
    vi.useFakeTimers();
    const error = { code: 'PRODUCT_ERROR', data: { id: 7 } };
    await expect(
      runOperation(
        async () => {
          throw error;
        },
        { timeoutMs: 100 },
      ),
    ).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes caller and lifetime listeners after successful completion', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const lifetime = new AbortController();
    const callerRemove = vi.spyOn(caller.signal, 'removeEventListener');
    const lifetimeRemove = vi.spyOn(lifetime.signal, 'removeEventListener');
    await expect(
      runOperation(async () => 7, {
        signal: caller.signal,
        lifetime: lifetime.signal,
        timeoutMs: 100,
      }),
    ).resolves.toBe(7);
    expect(callerRemove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(lifetimeRemove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the owned session failure but sanitizes caller cancellation reasons', async () => {
    const lifetime = new AbortController();
    const result = runOperation(() => new Promise<void>(() => {}), { lifetime: lifetime.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    lifetime.abort(new RpcError('AUTH_EXPIRED'));
    await rejected;
    const caller = new AbortController();
    const cancelled = runOperation(() => new Promise<void>(() => {}), { signal: caller.signal });
    const cancelledCheck = expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    caller.abort(new Error('fake-secret'));
    await cancelledCheck;
  });
});
