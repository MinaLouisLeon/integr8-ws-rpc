import { RpcError, type RpcErrorCode } from './rpcError.js';

/** Internal clock seam; returning a cancellation function avoids platform-specific timer types. */
export interface Scheduler {
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

/** No timer is created until schedule is called. */
export const systemScheduler: Scheduler = {
  now: (): number => Date.now(),
  schedule: (callback, delayMs): (() => void) => {
    const timer = setTimeout(callback, delayMs);
    return (): void => clearTimeout(timer);
  },
};

interface OperationOptions {
  readonly signal?: AbortSignal;
  /** Only package-owned signals may supply a trusted RpcError reason. */
  readonly lifetime?: AbortSignal;
  readonly timeoutMs?: number;
  readonly timeoutCode?: RpcErrorCode;
  readonly scheduler?: Scheduler;
}

/** Reject timer values that would overflow host timers or become immediate busy loops. */
export function validateTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RpcError('INVALID_OPTION');
  }
  return timeoutMs;
}

/**
 * Compose caller cancellation, a package-owned lifetime and an optional deadline.
 * Original application errors are preserved; late results remain observed but are never delivered.
 */
export function runOperation<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  options: OperationOptions = {},
): Promise<T> {
  if (options.timeoutMs !== undefined) {
    validateTimeout(options.timeoutMs);
  }
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let cancelTimer: (() => void) | undefined;

    function cleanup(): void {
      cancelTimer?.();
      options.signal?.removeEventListener('abort', onCallerAbort);
      options.lifetime?.removeEventListener('abort', onLifetimeAbort);
    }

    function fail(error: RpcError): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      controller.abort(error);
      reject(error);
    }

    function onCallerAbort(): void {
      fail(new RpcError('CANCELLED'));
    }

    function onLifetimeAbort(): void {
      const reason: unknown = options.lifetime?.reason;
      fail(reason instanceof RpcError ? reason : new RpcError('DISCONNECTED'));
    }

    if (options.lifetime?.aborted) {
      onLifetimeAbort();
      return;
    }
    if (options.signal?.aborted) {
      onCallerAbort();
      return;
    }
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    options.lifetime?.addEventListener('abort', onLifetimeAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      cancelTimer = (options.scheduler ?? systemScheduler).schedule(
        () => fail(new RpcError(options.timeoutCode ?? 'TIMEOUT')),
        options.timeoutMs,
      );
    }
    function complete(value: T): void {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(value);
      }
    }
    function rejectApplication(error: unknown): void {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    }
    try {
      // Attach both handlers even if the operation aborts synchronously during invocation.
      Promise.resolve(operation(controller.signal)).then(complete, rejectApplication);
    } catch (error) {
      rejectApplication(error);
    }
  });
}
