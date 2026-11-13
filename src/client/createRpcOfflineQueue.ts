import type { ConnectionSnapshot } from '../core/connectionTypes.js';
import {
  byteLength,
  commandBytes,
  copyBytes,
  type DeliveryBudgets,
  type DeliveryCommand,
  type DeliveryReceipt,
  expiry,
  readDeliveryOptions,
  readReceipt,
  validateBudgets,
  validateKey,
} from '../core/delivery.js';
import {
  runOperation,
  type Scheduler,
  systemScheduler,
  validateTimeout,
} from '../core/operation.js';
import { isRpcErrorCode, RpcError, type RpcErrorCode } from '../core/rpcError.js';

/** @inline */
interface QueueConnection<TClient extends object> {
  readonly client: TClient;
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
}
/** @inline */
interface QueueOptions<TClient extends object, TInput, TResult> extends DeliveryBudgets {
  readonly connection: QueueConnection<TClient>;
  readonly maxAgeMs: number;
  readonly attemptTimeoutMs: number;
  readonly encode: (input: TInput) => Uint8Array;
  readonly decode: (bytes: Uint8Array) => TInput;
  readonly decodeResult: (bytes: Uint8Array) => TResult;
  /** input is a fresh decoded copy for local validation; command.payload contains encoded bytes. */
  readonly deliver: (
    client: TClient,
    command: DeliveryCommand,
    signal: AbortSignal,
    input: TInput,
  ) => DeliveryReceipt | PromiseLike<DeliveryReceipt>;
  readonly reconcile: (
    client: TClient,
    key: string,
    signal: AbortSignal,
  ) => DeliveryReceipt | PromiseLike<DeliveryReceipt>;
}
/** @inline */
interface TicketSnapshot {
  readonly key: string;
  readonly expiresAt: number;
  readonly state: 'queued' | 'dispatching' | 'uncertain';
  readonly lastErrorCode?: RpcErrorCode;
}
/** Credential/payload-free local queue state. @inline */
interface QueueSnapshot {
  readonly closed: boolean;
  readonly queued: number;
  readonly dispatching: number;
  readonly uncertain: number;
  readonly retainedBytes: number;
  readonly tickets: readonly TicketSnapshot[];
}
/** @inline */
interface DeliveryTicket<TResult> {
  readonly key: string;
  readonly result: Promise<TResult>;
  /** Local cancellation; an invoked mutation may still complete on the server. */
  cancel(): void;
}
/** Explicit in-memory command ownership; connection lifecycle remains with the caller. @inline */
export interface RpcOfflineQueue<TInput, TResult> {
  enqueue(
    input: TInput,
    options: Readonly<{ key: string; signal?: AbortSignal }>,
  ): DeliveryTicket<TResult>;
  /** Read-only lookup for an uncertain ticket; never resubmits the command. */
  reconcile(key: string): Promise<void>;
  getSnapshot(): QueueSnapshot;
  subscribe(listener: (snapshot: QueueSnapshot) => void): () => void;
  close(): Promise<void>;
}
interface Pending<TResult> {
  readonly command: DeliveryCommand;
  readonly bytes: number;
  readonly resolve: (value: TResult) => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
  state: TicketSnapshot['state'];
  invoked: boolean;
  lastEpoch: number;
  lastErrorCode: RpcErrorCode | undefined;
  controller: AbortController | undefined;
  lookup:
    | Readonly<{ promise: Promise<void>; resolve(): void; reject(error: unknown): void }>
    | undefined;
  activeLookup: Pending<TResult>['lookup'];
}

/**
 * Explicit bounded offline submission for one typed command family. Borrow an existing connection;
 * call connect yourself. Uncertain work is reconciled, never automatically resubmitted. Queues are
 * process-local, preserve no state after close/reload, and must not span authenticated identities.
 * @inlineType QueueOptions
 * @inlineType QueueConnection
 * @inlineType DeliveryBudgets
 * @inlineType DeliveryCommand
 * @inlineType DeliveryReceipt
 */
export function createRpcOfflineQueue<TClient extends object, TInput, TResult>(
  source: QueueOptions<TClient, TInput, TResult>,
): RpcOfflineQueue<TInput, TResult> {
  return createOfflineQueue(source, systemScheduler);
}

/** @internal Scheduler injection is not part of a package entry point. */
export function createOfflineQueue<TClient extends object, TInput, TResult>(
  source: QueueOptions<TClient, TInput, TResult>,
  scheduler: Scheduler,
): RpcOfflineQueue<TInput, TResult> {
  const {
    limits,
    maxAgeMs,
    attemptTimeoutMs,
    connection,
    encode,
    decode,
    decodeResult,
    deliver,
    lookupReceipt,
  } = readDeliveryOptions(() => {
    const limits = validateBudgets(source);
    const maxAgeMs = validateTimeout(source.maxAgeMs);
    const attemptTimeoutMs = validateTimeout(source.attemptTimeoutMs);
    const { connection, encode, decode, decodeResult, deliver, reconcile: lookupReceipt } = source;
    if (
      !connection?.client ||
      typeof connection.getSnapshot !== 'function' ||
      typeof connection.subscribe !== 'function' ||
      [encode, decode, decodeResult, deliver, lookupReceipt].some(
        (callback) => typeof callback !== 'function',
      )
    ) {
      throw new RpcError('INVALID_OPTION');
    }
    return {
      limits,
      maxAgeMs,
      attemptTimeoutMs,
      connection,
      encode,
      decode,
      decodeResult,
      deliver,
      lookupReceipt,
    };
  });
  const pending = new Map<string, Pending<TResult>>();
  const observers = new Set<(value: QueueSnapshot) => void>();
  let state = connection.getSnapshot();
  let epoch = state.state === 'ready' ? 1 : 0;
  let retainedBytes = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let working = false;
  let callbackBusy = false;
  let scheduled = false;
  let cancelExpiry: (() => void) | undefined;
  let expiryGeneration = 0;
  let detachState = (): void => {};
  let snapshot = buildSnapshot();

  function buildSnapshot(): QueueSnapshot {
    const tickets = [...pending.values()].map(
      (entry): TicketSnapshot =>
        Object.freeze({
          key: entry.command.key,
          expiresAt: entry.command.expiresAt,
          state: entry.state,
          ...(entry.lastErrorCode === undefined ? {} : { lastErrorCode: entry.lastErrorCode }),
        }),
    );
    return Object.freeze({
      closed,
      retainedBytes,
      queued: tickets.filter((ticket) => ticket.state === 'queued').length,
      dispatching: tickets.filter((ticket) => ticket.state === 'dispatching').length,
      uncertain: tickets.filter((ticket) => ticket.state === 'uncertain').length,
      tickets: Object.freeze(tickets),
    });
  }
  function publish(): void {
    snapshot = buildSnapshot();
    const committed = snapshot;
    for (const observer of [...observers]) {
      if (snapshot !== committed) break;
      if (!observers.has(observer)) continue;
      try {
        void Promise.resolve(observer(committed)).catch(() => {});
      } catch {
        /* observer isolation */
      }
    }
  }
  function live(entry: Pending<TResult>): boolean {
    return !closed && pending.get(entry.command.key) === entry;
  }
  function armExpiry(): void {
    const generation = ++expiryGeneration;
    cancelExpiry?.();
    cancelExpiry = undefined;
    if (closed || pending.size === 0) return;
    const nearest = Math.min(...[...pending.values()].map((entry) => entry.command.expiresAt));
    cancelExpiry = scheduler.schedule(
      () => {
        if (closed || generation !== expiryGeneration) return;
        cancelExpiry = undefined;
        for (const entry of [...pending.values()]) {
          if (entry.command.expiresAt <= scheduler.now()) {
            finish(entry, undefined, new RpcError(entry.invoked ? 'OUTCOME_UNKNOWN' : 'TIMEOUT'));
          }
        }
        armExpiry();
        kick();
      },
      Math.max(0, Math.min(2_147_483_647, nearest - scheduler.now())),
    );
  }
  function finish(
    entry: Pending<TResult>,
    value?: Readonly<{ result: TResult }>,
    error?: unknown,
  ): void {
    if (pending.get(entry.command.key) !== entry) return;
    pending.delete(entry.command.key);
    retainedBytes -= entry.bytes;
    entry.detach();
    const controller = entry.controller;
    entry.controller = undefined;
    entry.lookup?.reject(error ?? new RpcError('CANCELLED'));
    entry.lookup = undefined;
    if (!value) entry.activeLookup?.reject(error ?? new RpcError('CANCELLED'));
    // Remove ownership before abort observers can reenter enqueue/close.
    controller?.abort(new RpcError('CANCELLED'));
    if (value) entry.resolve(value.result);
    else entry.reject(error);
    armExpiry();
    if (!closed) publish();
    kick();
  }
  function terminal(code: RpcErrorCode | undefined): boolean {
    return code === 'AUTH_FAILED' || code === 'PROTOCOL_MISMATCH' || code === 'INVALID_OPTION';
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve();
    detachState();
    cancelExpiry?.();
    cancelExpiry = undefined;
    for (const entry of [...pending.values()]) {
      finish(entry, undefined, new RpcError(entry.invoked ? 'OUTCOME_UNKNOWN' : 'CLOSED'));
    }
    publish();
    observers.clear();
    return closing;
  }
  function onState(next: ConnectionSnapshot): void {
    if (closed) return;
    const wasReady = state.state === 'ready';
    const previousSession = state.sessionId;
    state = next;
    if (next.state === 'closed') {
      void close();
      return;
    }
    if (terminal(next.lastErrorCode)) {
      for (const entry of [...pending.values()]) {
        finish(
          entry,
          undefined,
          new RpcError(entry.invoked ? 'OUTCOME_UNKNOWN' : (next.lastErrorCode ?? 'INTERNAL')),
        );
      }
    }
    if (next.state !== 'ready' || (wasReady && previousSession !== next.sessionId)) {
      for (const entry of pending.values()) {
        entry.controller?.abort(new RpcError('DISCONNECTED'));
      }
    }
    if (next.state === 'ready' && (!wasReady || previousSession !== next.sessionId)) epoch += 1;
    kick();
  }
  function kick(): void {
    if (closed || working || callbackBusy || scheduled || state.state !== 'ready') return;
    scheduled = true;
    void Promise.resolve()
      .then(async () => {
        scheduled = false;
        if (closed || working || callbackBusy || state.state !== 'ready') return;
        const entry =
          [...pending.values()].find((value) => value.state === 'queued') ??
          [...pending.values()].find(
            (value) =>
              value.state === 'uncertain' &&
              (value.lookup !== undefined || value.lastEpoch < epoch),
          );
        if (!entry) return;
        working = true;
        try {
          await attempt(entry);
        } finally {
          working = false;
          kick();
        }
      })
      .catch(() => {
        /* attempts observe callback failures at their own boundary */
      });
  }
  async function attempt(entry: Pending<TResult>): Promise<void> {
    if (!live(entry)) return;
    if (entry.command.expiresAt <= scheduler.now()) {
      finish(entry, undefined, new RpcError(entry.invoked ? 'OUTCOME_UNKNOWN' : 'TIMEOUT'));
      return;
    }
    const querying = entry.state === 'uncertain';
    const forEpoch = epoch;
    entry.lastEpoch = forEpoch;
    const request = querying ? entry.lookup : undefined;
    entry.lookup = undefined;
    entry.activeLookup = request;
    const controller = new AbortController();
    entry.controller = controller;
    if (!querying) entry.state = 'dispatching';
    publish();
    try {
      const raw = await runOperation(
        (signal) => {
          if (!live(entry) || state.state !== 'ready' || epoch !== forEpoch || signal.aborted) {
            throw new RpcError('DISCONNECTED');
          }
          if (querying)
            return invoke(() => lookupReceipt(connection.client, entry.command.key, signal));
          const input = decode(copyBytes(entry.command.payload, 'INTERNAL'));
          if (!live(entry) || state.state !== 'ready' || epoch !== forEpoch || signal.aborted) {
            throw new RpcError('DISCONNECTED');
          }
          const command = Object.freeze({
            ...entry.command,
            payload: copyBytes(entry.command.payload, 'INTERNAL'),
          });
          entry.invoked = true;
          return invoke(() => deliver(connection.client, command, signal, input));
        },
        { lifetime: controller.signal, timeoutMs: attemptTimeoutMs, scheduler },
      );
      if (!live(entry) || epoch !== forEpoch || controller.signal.aborted) return;
      if (entry.command.expiresAt <= scheduler.now()) {
        finish(entry, undefined, new RpcError('OUTCOME_UNKNOWN'));
        return;
      }
      const receipt = readReceipt(raw);
      if (
        receipt.key !== entry.command.key ||
        (receipt.state !== 'missing' && receipt.expiresAt !== entry.command.expiresAt)
      ) {
        throw new RpcError('INVALID_MESSAGE');
      }
      if (receipt.state === 'completed') {
        if (byteLength(receipt.result, 'INVALID_MESSAGE') > limits.maxEntryBytes) {
          throw new RpcError('PAYLOAD_TOO_LARGE');
        }
        const result = decodeResult(copyBytes(receipt.result, 'INVALID_MESSAGE'));
        if (live(entry) && epoch === forEpoch && !controller.signal.aborted) {
          if (entry.command.expiresAt <= scheduler.now()) {
            finish(entry, undefined, new RpcError('OUTCOME_UNKNOWN'));
          } else finish(entry, { result });
        }
      } else {
        entry.state = 'uncertain';
        entry.lastErrorCode = 'OUTCOME_UNKNOWN';
        publish();
      }
      request?.resolve();
    } catch (error) {
      request?.reject(error);
      if (!live(entry)) return;
      const code = error instanceof RpcError && isRpcErrorCode(error.code) ? error.code : undefined;
      const uncertain =
        code !== undefined &&
        ['DISCONNECTED', 'OUTCOME_UNKNOWN', 'TIMEOUT', 'CANCELLED', 'AUTH_EXPIRED'].includes(code);
      if (
        querying &&
        !(code !== undefined && ['INVALID_MESSAGE', 'PAYLOAD_TOO_LARGE'].includes(code))
      ) {
        entry.lastErrorCode = code ?? 'INTERNAL';
      } else if (uncertain && entry.invoked) {
        entry.state = 'uncertain';
        entry.lastErrorCode = 'OUTCOME_UNKNOWN';
      } else if (
        !entry.invoked &&
        uncertain &&
        (state.state !== 'ready' || epoch !== forEpoch || controller.signal.aborted)
      ) {
        entry.state = 'queued';
      } else {
        finish(entry, undefined, error);
        return;
      }
      publish();
    } finally {
      if (entry.controller === controller) entry.controller = undefined;
      if (entry.activeLookup === request) entry.activeLookup = undefined;
      controller.abort(new RpcError('CANCELLED'));
    }
  }
  function invoke(
    operation: () => DeliveryReceipt | PromiseLike<DeliveryReceipt>,
  ): Promise<DeliveryReceipt> {
    callbackBusy = true;
    let task: Promise<DeliveryReceipt>;
    try {
      task = Promise.resolve(operation());
    } catch (error) {
      task = Promise.reject(error);
    }
    const released = (): void => {
      callbackBusy = false;
      kick();
    };
    void task.then(released, released);
    return task;
  }
  function enqueue(
    input: TInput,
    options: Readonly<{ key: string; signal?: AbortSignal }>,
  ): DeliveryTicket<TResult> {
    if (closed || state.state === 'closed') throw new RpcError('CLOSED');
    if (terminal(state.lastErrorCode)) throw new RpcError(state.lastErrorCode ?? 'INTERNAL');
    if (!options) throw new RpcError('INVALID_OPTION');
    const { signal } = options;
    const key = validateKey(options.key);
    if (
      signal &&
      (typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function')
    ) {
      throw new RpcError('INVALID_OPTION');
    }
    if (signal?.aborted) throw new RpcError('CANCELLED');
    if (pending.has(key)) throw new RpcError('INVALID_OPTION');
    const encoded = encode(input);
    if (byteLength(encoded, 'INVALID_OPTION') > limits.maxEntryBytes) {
      throw new RpcError('PAYLOAD_TOO_LARGE');
    }
    const bytes = commandBytes(key, encoded);
    // User codecs may reenter: repeat ownership/capacity checks after they return.
    if (closed) throw new RpcError('CLOSED');
    if (terminal(state.lastErrorCode)) throw new RpcError(state.lastErrorCode ?? 'INTERNAL');
    if (signal?.aborted) throw new RpcError('CANCELLED');
    if (pending.has(key)) throw new RpcError('INVALID_OPTION');
    if (pending.size >= limits.maxEntries || bytes > limits.maxBytes - retainedBytes) {
      throw new RpcError('LIMIT_EXCEEDED');
    }
    const command = Object.freeze({
      key,
      expiresAt: expiry(scheduler.now(), maxAgeMs),
      payload: copyBytes(encoded, 'INVALID_OPTION'),
    });
    let resolveResult: (value: TResult) => void = () => {};
    let rejectResult: (error: unknown) => void = () => {};
    const result = new Promise<TResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    void result.catch(() => {});
    const cancel = (): void => finish(entry, undefined, new RpcError('CANCELLED'));
    const entry: Pending<TResult> = {
      command,
      bytes,
      resolve: resolveResult,
      reject: rejectResult,
      detach: (): void => signal?.removeEventListener('abort', cancel),
      invoked: false,
      state: 'queued',
      lastEpoch: epoch,
      lastErrorCode: undefined,
      controller: undefined,
      lookup: undefined,
      activeLookup: undefined,
    };
    pending.set(key, entry);
    retainedBytes += bytes;
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    armExpiry();
    publish();
    kick();
    return Object.freeze({ key, result, cancel });
  }
  function reconcile(key: string): Promise<void> {
    if (closed) return Promise.reject(new RpcError('CLOSED'));
    validateKey(key);
    const entry = pending.get(key);
    if (entry?.state !== 'uncertain') return Promise.reject(new RpcError('INVALID_OPTION'));
    if (state.state !== 'ready') return Promise.reject(new RpcError('DISCONNECTED'));
    if (entry.activeLookup) return entry.activeLookup.promise;
    if (entry.lookup) return entry.lookup.promise;
    let resolveLookup = (): void => {};
    let rejectLookup: (error: unknown) => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolveLookup = resolve;
      rejectLookup = reject;
    });
    void promise.catch(() => {});
    entry.lookup = { promise, resolve: resolveLookup, reject: rejectLookup };
    kick();
    return promise;
  }
  detachState = connection.subscribe(onState);
  if (typeof detachState !== 'function') throw new RpcError('INVALID_OPTION');
  // subscribe observes future changes; re-read to cover a synchronous foreign lifecycle transition.
  onState(connection.getSnapshot());
  if (closed) detachState();
  return Object.freeze({
    enqueue,
    reconcile,
    close,
    getSnapshot: (): QueueSnapshot => snapshot,
    subscribe: (observer: (value: QueueSnapshot) => void): (() => void) => {
      if (typeof observer !== 'function') throw new RpcError('INVALID_OPTION');
      if (!closed) observers.add(observer);
      return (): void => {
        observers.delete(observer);
      };
    },
  });
}
