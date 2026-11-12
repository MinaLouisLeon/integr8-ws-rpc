import type { createORPCClient } from '@orpc/client';
import type { ConnectionSnapshot, RpcClientOptions } from '../core/connectionTypes.js';
import { normalizeLimits } from '../core/limits.js';
import { runOperation, systemScheduler, validateTimeout } from '../core/operation.js';
import { RpcError, type RpcErrorCode } from '../core/rpcError.js';
import { createUnaryConnection } from './connection.js';

type UpstreamClient = ReturnType<typeof createORPCClient>;
/** @inline */
interface Observer<T> {
  readonly next: (value: T) => void | PromiseLike<void>;
  readonly error: (error: unknown) => void;
  readonly complete: () => void;
  readonly gap?: (event: Readonly<{ sessionId: string; epoch: number }>) => void;
}
/** @inline */
interface Subscription {
  unsubscribe(): Promise<void>;
}
/**
 * Typed client lifecycle. Calls are never queued or replayed, including during reconnect.
 * @inline
 */
export interface RpcClient<TClient extends UpstreamClient> {
  readonly client: TClient;
  connect(): Promise<void>;
  close(): Promise<void>;
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
  subscribeStream<T>(
    open: (
      client: TClient,
      signal: AbortSignal,
    ) => AsyncIterable<T> | PromiseLike<AsyncIterable<T>>,
    observer: Observer<T>,
    options?: Readonly<{ resubscribe?: boolean }>,
  ): Subscription;
}
interface Managed {
  readonly resubscribe: boolean;
  opened: boolean;
  cancelled: boolean;
  controller: AbortController | undefined;
  task: Promise<void> | undefined;
  start(epoch: number): void;
  stop(): Promise<void>;
  lost(error: RpcError): void;
}

/**
 * Create an import-safe, lazy oRPC client. One lifecycle owner controls retries, heartbeat and
 * opt-in managed stream resubscription; applications reconcile uncertain mutation outcomes.
 */
export function createRpcClient<TClient extends UpstreamClient>(
  source: RpcClientOptions,
): RpcClient<TClient> {
  if (typeof source !== 'object' || source === null) throw new RpcError('INVALID_OPTION');
  const limits = normalizeLimits(source);
  const reconnect = source.reconnect ?? true;
  const retryLimit = source.retryLimit ?? 10;
  const baseDelay = validateTimeout(source.backoffBaseMs ?? 500);
  const maxDelay = validateTimeout(source.backoffMaxMs ?? 30_000);
  const heartbeatInterval = validateTimeout(source.heartbeatIntervalMs ?? 15_000);
  validateTimeout(source.heartbeatTimeoutMs ?? 10_000);
  if (
    typeof reconnect !== 'boolean' ||
    !Number.isSafeInteger(retryLimit) ||
    retryLimit < 0 ||
    retryLimit > 1000 ||
    baseDelay > maxDelay
  )
    throw new RpcError('INVALID_OPTION');
  const base = createUnaryConnection<TClient>({ ...source, ...limits, reconnect: false });
  const listeners = new Set<(snapshot: ConnectionSnapshot) => void>();
  const subscriptions = new Set<Managed>();
  const lifetime = new AbortController();
  let snapshot = base.getSnapshot();
  let closed = false;
  let cycle: Promise<void> | undefined;
  let retries = 0;
  let epoch = 0;
  let ready = false;
  let cancelHeartbeat: (() => void) | undefined;
  let closing: Promise<void> | undefined;

  function publish(value: ConnectionSnapshot): void {
    snapshot = Object.freeze(value);
    for (const listener of [...listeners]) {
      if (snapshot !== value) break;
      if (!listeners.has(listener)) continue;
      try {
        void Promise.resolve(listener(value)).catch(() => {});
      } catch {
        /* observer isolation */
      }
    }
  }
  function terminal(code: RpcErrorCode): boolean {
    return [
      'AUTH_FAILED',
      'AUTH_EXPIRED',
      'PROTOCOL_MISMATCH',
      'INVALID_OPTION',
      'CLOSED',
    ].includes(code);
  }
  function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        cancel();
        lifetime.signal.removeEventListener('abort', abort);
        reject(new RpcError('CLOSED'));
      };
      const cancel = systemScheduler.schedule(() => {
        lifetime.signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      lifetime.signal.addEventListener('abort', abort, { once: true });
      if (lifetime.signal.aborted) abort();
    });
  }
  function heartbeat(forEpoch: number, delayMs = heartbeatInterval): void {
    cancelHeartbeat?.();
    if (closed || !ready || forEpoch !== epoch) return;
    cancelHeartbeat = systemScheduler.schedule(() => {
      cancelHeartbeat = undefined;
      if (closed || !ready || forEpoch !== epoch) return;
      const started = Date.now();
      void base.ping().then(
        () => {
          if (!closed && ready && epoch === forEpoch) {
            heartbeat(forEpoch, Math.max(0, heartbeatInterval - (Date.now() - started)));
          }
        },
        () => {
          if (!closed && epoch === forEpoch) base.disconnect('DISCONNECTED');
        },
      );
    }, delayMs);
  }
  const unsubscribeState = base.subscribe((next) => {
    const wasReady = ready;
    ready = next.state === 'ready';
    if (next.state === 'ready') {
      epoch += 1;
      retries = 0;
      publish(next);
      heartbeat(epoch);
      for (const subscription of [...subscriptions]) subscription.start(epoch);
    } else if (next.state === 'error') {
      cancelHeartbeat?.();
      cancelHeartbeat = undefined;
      const code = next.lastErrorCode ?? 'DISCONNECTED';
      for (const subscription of [...subscriptions]) subscription.lost(new RpcError(code));
      if (
        !closed &&
        wasReady &&
        reconnect &&
        retryLimit > 0 &&
        (!terminal(code) || code === 'AUTH_EXPIRED')
      ) {
        publish({ state: 'reconnecting', attempt: next.attempt, lastErrorCode: code });
        const previous = cycle;
        const restart = (): void => {
          if (!closed && !ready) void connect(true).catch(() => {});
        };
        if (previous) void previous.then(restart, () => {});
        else restart();
      } else if (!cycle || wasReady) publish(next);
    } else {
      publish(
        next.state === 'connecting' && retries > 0
          ? { state: 'reconnecting', attempt: next.attempt }
          : next,
      );
    }
  });

  function connect(fromLoss = false): Promise<void> {
    if (closed) return Promise.reject(new RpcError('CLOSED'));
    if (ready) return Promise.resolve();
    if (cycle) return cycle;
    retries = fromLoss ? 1 : 0;
    const promise = Promise.resolve().then(async () => {
      if (fromLoss) await delay(Math.floor(Math.random() * Math.min(maxDelay, baseDelay)));
      for (;;) {
        if (closed) throw new RpcError('CLOSED');
        try {
          await base.connect();
          return;
        } catch (error) {
          const failure = error instanceof RpcError ? error : new RpcError('INTERNAL');
          if (closed || !reconnect || terminal(failure.code) || retries >= retryLimit) {
            if (!closed)
              publish({
                state: 'error',
                attempt: base.getSnapshot().attempt,
                lastErrorCode: failure.code,
              });
            throw failure;
          }
          retries += 1;
          publish({
            state: 'reconnecting',
            attempt: base.getSnapshot().attempt,
            lastErrorCode: failure.code,
          });
          const ceiling = Math.min(maxDelay, baseDelay * 2 ** Math.min(retries - 1, 52));
          await delay(Math.floor(Math.random() * ceiling));
        }
      }
    });
    cycle = promise;
    const clear = (): void => {
      if (cycle === promise) cycle = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  }

  function subscribeStream<T>(
    open: (
      client: TClient,
      signal: AbortSignal,
    ) => AsyncIterable<T> | PromiseLike<AsyncIterable<T>>,
    observer: Observer<T>,
    options: Readonly<{ resubscribe?: boolean }> = {},
  ): Subscription {
    if (closed) throw new RpcError('CLOSED');
    if (subscriptions.size >= limits.maxSubscriptions) throw new RpcError('LIMIT_EXCEEDED');
    if (
      typeof open !== 'function' ||
      !observer ||
      typeof observer.next !== 'function' ||
      typeof observer.error !== 'function' ||
      typeof observer.complete !== 'function' ||
      (observer.gap !== undefined && typeof observer.gap !== 'function') ||
      !options ||
      (options.resubscribe !== undefined && typeof options.resubscribe !== 'boolean')
    ) {
      throw new RpcError('INVALID_OPTION');
    }
    function notify(callback: (() => void) | undefined): void {
      try {
        void Promise.resolve(callback?.()).catch(() => {});
      } catch {
        /* observer isolation */
      }
    }
    const managed: Managed = {
      resubscribe: options.resubscribe ?? false,
      opened: false,
      cancelled: false,
      controller: undefined,
      task: undefined,
      start: (forEpoch): void => {
        if (managed.cancelled || (managed.opened && !managed.resubscribe)) return;
        const previous = managed.task;
        const controller = new AbortController();
        managed.controller = controller;
        const hadOpened = managed.opened;
        managed.task = Promise.resolve(previous).then(async () => {
          if (
            managed.cancelled ||
            closed ||
            !ready ||
            epoch !== forEpoch ||
            controller.signal.aborted
          )
            return;
          if (hadOpened && snapshot.state === 'ready') {
            const sessionId = snapshot.sessionId;
            notify(() => observer.gap?.({ sessionId, epoch: forEpoch }));
          }
          managed.opened = true;
          let iterator: AsyncIterator<T> | undefined;
          try {
            const iterable = await runOperation(
              () => {
                const opened = Promise.resolve(open(base.client, controller.signal));
                void opened
                  .then(
                    (value) => {
                      if (controller.signal.aborted) {
                        void Promise.resolve(value[Symbol.asyncIterator]().return?.()).catch(
                          () => {},
                        );
                      }
                    },
                    () => {},
                  )
                  .catch(() => {});
                return opened;
              },
              { lifetime: controller.signal },
            );
            iterator = iterable[Symbol.asyncIterator]();
            while (!managed.cancelled && !controller.signal.aborted && epoch === forEpoch) {
              const result = await runOperation(
                () =>
                  Promise.resolve(iterator?.next()).then((value) => {
                    if (!value) throw new RpcError('INTERNAL');
                    return value;
                  }),
                { lifetime: controller.signal },
              );
              if (result.done) {
                managed.cancelled = true;
                subscriptions.delete(managed);
                notify(observer.complete);
                return;
              }
              await runOperation(() => Promise.resolve(observer.next(result.value)), {
                lifetime: controller.signal,
              });
            }
          } catch (error) {
            if (!managed.cancelled && (!controller.signal.aborted || !managed.resubscribe)) {
              managed.cancelled = true;
              subscriptions.delete(managed);
              notify(() => observer.error(error));
            }
          } finally {
            try {
              void Promise.resolve(iterator?.return?.()).catch(() => {});
            } catch {
              /* cooperative */
            }
          }
        });
      },
      stop: async (): Promise<void> => {
        managed.cancelled = true;
        subscriptions.delete(managed);
        managed.controller?.abort(new RpcError('CANCELLED'));
        await managed.task;
      },
      lost: (error): void => {
        if (!managed.opened) return;
        managed.controller?.abort(error);
        if (!managed.resubscribe) {
          managed.cancelled = true;
          subscriptions.delete(managed);
          notify(() => observer.error(error));
        }
      },
    };
    subscriptions.add(managed);
    if (ready) managed.start(epoch);
    return Object.freeze({ unsubscribe: managed.stop });
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    ready = false;
    cancelHeartbeat?.();
    cancelHeartbeat = undefined;
    lifetime.abort(new RpcError('CLOSED'));
    const stopping = [...subscriptions].map((subscription) => subscription.stop());
    let start = (): void => {};
    const promise = new Promise<void>((resolve, reject) => {
      start = (): void => {
        void base
          .close()
          .then(async () => {
            await Promise.all(stopping);
            unsubscribeState();
            listeners.clear();
          })
          .then(resolve, reject);
      };
    });
    closing = promise;
    start();
    return promise;
  }
  return Object.freeze({
    client: base.client,
    connect,
    close,
    subscribeStream,
    getSnapshot: (): ConnectionSnapshot => snapshot,
    subscribe: (listener: (state: ConnectionSnapshot) => void): (() => void) => {
      if (!closed) listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  });
}
