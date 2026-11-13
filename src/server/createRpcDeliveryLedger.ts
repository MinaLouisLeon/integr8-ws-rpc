import {
  byteLength,
  checkedSum,
  commandBytes,
  copyBytes,
  type DeliveryBudgets,
  type DeliveryCommand,
  type DeliveryReceipt,
  expiry,
  readCommand,
  readDeliveryOptions,
  scopeBytes,
  validateBudgets,
  validateKey,
} from '../core/delivery.js';
import {
  runOperation,
  type Scheduler,
  systemScheduler,
  validateTimeout,
} from '../core/operation.js';
import { RpcError } from '../core/rpcError.js';

/** @inline */
interface LedgerOptions<TResult> extends DeliveryBudgets {
  readonly retentionMs: number;
  readonly maxCommandAgeMs: number;
  readonly encodeResult: (result: TResult) => Uint8Array;
  readonly decodeResult: (bytes: Uint8Array) => TResult;
}

/**
 * Process-local receipt ownership. Authenticate/authorize scope on every application route.
 * @inline
 */
export interface RpcDeliveryLedger<TResult> {
  /** Run once for a live scoped key; duplicates join or retrieve its receipt. */
  execute(
    scope: string,
    command: DeliveryCommand,
    run: (payload: Uint8Array, signal: AbortSignal) => TResult | PromiseLike<TResult>,
  ): Promise<DeliveryReceipt>;
  /** Read only. Missing is not proof a mutation did not commit elsewhere. */
  lookup(scope: string, key: string): DeliveryReceipt;
  /** Terminal local shutdown; does not wait for uncooperative handlers. */
  close(): Promise<void>;
}

interface RecordEntry {
  readonly command: DeliveryCommand;
  readonly bytes: number;
  readonly controller: AbortController;
  state: 'pending' | 'completed' | 'uncertain';
  result: Uint8Array | undefined;
  retainUntil: number;
  task: Promise<DeliveryReceipt> | undefined;
}

/**
 * Deduplicate an explicitly wrapped command family in this process only. Keys are scoped by the
 * application's authenticated identity and operation. Executions outlive individual RPC observers;
 * close requests cooperative cancellation. No persistence, rollback or exactly-once guarantee.
 * @inlineType LedgerOptions
 * @inlineType DeliveryBudgets
 * @inlineType DeliveryCommand
 * @inlineType DeliveryReceipt
 */
export function createRpcDeliveryLedger<TResult>(
  options: LedgerOptions<TResult>,
): RpcDeliveryLedger<TResult> {
  return createDeliveryLedger(options, systemScheduler);
}

/** @internal Clock seam, never exported from a package entry. */
export function createDeliveryLedger<TResult>(
  source: LedgerOptions<TResult>,
  clock: Scheduler,
): RpcDeliveryLedger<TResult> {
  const { limits, retentionMs, maxCommandAgeMs, encodeResult, decodeResult } = readDeliveryOptions(
    () => {
      const limits = validateBudgets(source);
      const retentionMs = validateTimeout(source.retentionMs);
      const maxCommandAgeMs = validateTimeout(source.maxCommandAgeMs);
      const { encodeResult, decodeResult } = source;
      if (
        maxCommandAgeMs > retentionMs ||
        typeof encodeResult !== 'function' ||
        typeof decodeResult !== 'function'
      )
        throw new RpcError('INVALID_OPTION');
      return { limits, retentionMs, maxCommandAgeMs, encodeResult, decodeResult };
    },
  );
  const scopes = new Map<string, Map<string, RecordEntry>>();
  let entries = 0;
  let bytes = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  function prune(): void {
    for (const [scope, records] of scopes) {
      for (const [key, record] of records) {
        if (record.state !== 'pending' && record.retainUntil <= clock.now()) {
          records.delete(key);
          entries -= 1;
          bytes -= record.bytes;
        }
      }
      if (records.size === 0) scopes.delete(scope);
    }
  }
  function receipt(record: RecordEntry): DeliveryReceipt {
    const { key, expiresAt } = record.command;
    if (record.state === 'completed' && record.result) {
      return Object.freeze({
        key,
        expiresAt,
        state: 'completed',
        result: copyBytes(record.result, 'INTERNAL'),
      });
    }
    return Object.freeze({
      key,
      expiresAt,
      state: record.state === 'pending' ? 'pending' : 'uncertain',
    });
  }
  function settle(record: RecordEntry, state: 'completed' | 'uncertain'): void {
    record.state = state;
    // Saturating retention on clock overflow never evicts a live deduplication tombstone early.
    const until = Math.max(record.command.expiresAt, clock.now()) + retentionMs;
    record.retainUntil = Number.isSafeInteger(until) ? until : Number.MAX_SAFE_INTEGER;
  }
  async function execute(
    scope: string,
    raw: DeliveryCommand,
    run: (payload: Uint8Array, signal: AbortSignal) => TResult | PromiseLike<TResult>,
  ): Promise<DeliveryReceipt> {
    if (closed) throw new RpcError('CLOSED');
    scopeBytes(scope);
    if (typeof run !== 'function') throw new RpcError('INVALID_OPTION');
    const command = readCommand(raw);
    const length = byteLength(command.payload, 'INVALID_MESSAGE');
    if (length > limits.maxEntryBytes) throw new RpcError('PAYLOAD_TOO_LARGE');
    prune();
    const existing = scopes.get(scope)?.get(command.key);
    if (existing) {
      if (
        existing.command.expiresAt !== command.expiresAt ||
        existing.command.payload.length !== length ||
        !existing.command.payload.every((value, index) => value === command.payload[index])
      ) {
        throw new RpcError('INVALID_MESSAGE');
      }
      if (existing.state === 'pending') {
        await existing.task;
        return receipt(existing);
      }
      return receipt(existing);
    }
    const now = clock.now();
    if (command.expiresAt <= now) throw new RpcError('TIMEOUT');
    if (command.expiresAt > expiry(now, maxCommandAgeMs)) throw new RpcError('INVALID_MESSAGE');
    const reserved = checkedSum(
      commandBytes(command.key, command.payload, scope),
      limits.maxEntryBytes,
    );
    if (entries >= limits.maxEntries || reserved > limits.maxBytes - bytes) {
      throw new RpcError('LIMIT_EXCEEDED');
    }
    const owned = Object.freeze({
      ...command,
      payload: copyBytes(command.payload, 'INVALID_MESSAGE'),
    });
    const controller = new AbortController();
    // Defer user code until the pending record and its shared task are visible to reentrant callers.
    const record: RecordEntry = {
      command: owned,
      bytes: reserved,
      controller,
      state: 'pending',
      result: undefined,
      retainUntil: Number.MAX_SAFE_INTEGER,
      task: undefined,
    };
    const records = scopes.get(scope) ?? new Map<string, RecordEntry>();
    scopes.set(scope, records);
    records.set(command.key, record);
    entries += 1;
    bytes += reserved;
    record.task = Promise.resolve().then(async () => {
      try {
        const output = await runOperation(
          (signal) => {
            if (clock.now() >= owned.expiresAt) throw new RpcError('TIMEOUT');
            return Promise.resolve(run(copyBytes(owned.payload, 'INTERNAL'), signal));
          },
          { lifetime: controller.signal },
        );
        if (closed) throw new RpcError('CLOSED');
        let encoded: Uint8Array;
        try {
          const value = encodeResult(output);
          if (byteLength(value, 'INTERNAL') > limits.maxEntryBytes) {
            throw new RpcError('PAYLOAD_TOO_LARGE');
          }
          encoded = copyBytes(value, 'INTERNAL');
          decodeResult(copyBytes(encoded, 'INTERNAL'));
        } catch (error) {
          throw error instanceof RpcError && error.code === 'PAYLOAD_TOO_LARGE'
            ? error
            : new RpcError('INTERNAL');
        }
        if (closed) throw new RpcError('CLOSED');
        record.result = encoded;
        settle(record, 'completed');
        return receipt(record);
      } catch (error) {
        settle(record, 'uncertain');
        throw error;
      }
    });
    // A disconnected RPC observer may never await the task; always observe application failures.
    const task = record.task;
    void task.then(
      () => {
        if (record.task === task) record.task = undefined;
      },
      () => {
        if (record.task === task) record.task = undefined;
      },
    );
    await task;
    return receipt(record);
  }
  function lookup(scope: string, key: string): DeliveryReceipt {
    if (closed) throw new RpcError('CLOSED');
    scopeBytes(scope);
    validateKey(key);
    prune();
    const record = scopes.get(scope)?.get(key);
    return record ? receipt(record) : Object.freeze({ key, state: 'missing' });
  }
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    closing = Promise.resolve();
    const records = [...scopes.values()].flatMap((value) => [...value.values()]);
    scopes.clear();
    bytes = 0;
    entries = 0;
    for (const record of records) {
      record.controller.abort(new RpcError('CLOSED'));
      record.result = undefined;
    }
    return closing;
  }
  return Object.freeze({ execute, lookup, close });
}
