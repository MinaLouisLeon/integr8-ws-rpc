import { runOperation } from './operation.js';
import { RpcError } from './rpcError.js';

/** Validate only the boundary needed for upstream async iterators; no item inference is erased. */
export function isAsyncIterator(value: unknown): value is AsyncIterableIterator<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'next' in value &&
    typeof value.next === 'function' &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === 'function'
  );
}

interface LifetimeOptions {
  readonly signal?: AbortSignal;
  readonly lifetime?: AbortSignal;
  readonly beforeNext?: () => void;
  readonly onItem?: () => void;
  readonly onAbort?: (error: RpcError) => void;
  readonly onFinish?: () => void;
}

/**
 * Keep caller/session abort linked until iterator completion. Proxy retains the original generic
 * surface and item/event metadata; cooperative return is observed without waiting forever on user code.
 */
export function retainIterator<T>(value: T, options: LifetimeOptions): T {
  if (!isAsyncIterator(value)) return value;
  const iterator = value;
  const controller = new AbortController();
  let finished = false;
  function finish(): void {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener('abort', onCaller);
    options.lifetime?.removeEventListener('abort', onLifetime);
    options.onFinish?.();
  }
  function stop(error: RpcError): void {
    if (finished) return;
    controller.abort(error);
    try {
      options.onAbort?.(error);
    } catch {
      /* cleanup must complete */
    } finally {
      finish();
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {});
      } catch {
        /* cleanup only */
      }
    }
  }
  function onCaller(): void {
    stop(new RpcError('CANCELLED'));
  }
  function onLifetime(): void {
    const reason: unknown = options.lifetime?.reason;
    stop(reason instanceof RpcError ? reason : new RpcError('DISCONNECTED'));
  }
  options.signal?.addEventListener('abort', onCaller, { once: true });
  options.lifetime?.addEventListener('abort', onLifetime, { once: true });
  if (options.signal?.aborted) onCaller();
  else if (options.lifetime?.aborted) onLifetime();
  const proxy = new Proxy(value, {
    get(target, property) {
      if (property === Symbol.asyncIterator) return () => proxy;
      if (property === 'next')
        return (...args: unknown[]) =>
          runOperation(
            async () => {
              if (controller.signal.aborted) throw controller.signal.reason;
              if (finished) return { done: true, value: undefined };
              try {
                options.beforeNext?.();
                const result: unknown = await Reflect.apply(iterator.next, iterator, args);
                if (typeof result !== 'object' || result === null)
                  throw new RpcError('INVALID_MESSAGE');
                const done = 'done' in result && Boolean(result.done);
                if (done) finish();
                else options.onItem?.();
                return { done, value: 'value' in result ? result.value : undefined };
              } catch (error) {
                finish();
                throw error;
              }
            },
            { lifetime: controller.signal },
          );
      if (property === 'return' || property === 'throw')
        return async (...args: unknown[]) => {
          finish();
          const method = iterator[property];
          if (typeof method === 'function') return Reflect.apply(method, iterator, args);
          if (property === 'throw') throw args[0];
          return { done: true, value: args[0] };
        };
      const member: unknown = Reflect.get(target, property, target);
      return typeof member === 'function' ? member.bind(target) : member;
    },
  });
  return proxy;
}
