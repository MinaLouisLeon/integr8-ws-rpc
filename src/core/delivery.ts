import { validateTimeout } from './operation.js';
import { RpcError, type RpcErrorCode } from './rpcError.js';

/** Application-procedure envelope, not a transport frame. @inline */
export interface DeliveryCommand {
  readonly key: string;
  readonly expiresAt: number;
  readonly payload: Uint8Array;
}

/** Process-local acknowledgement; missing never authorizes replay. @inline */
export type DeliveryReceipt =
  | Readonly<{ key: string; state: 'missing' }>
  | Readonly<{ key: string; expiresAt: number; state: 'pending' | 'uncertain' }>
  | Readonly<{ key: string; expiresAt: number; state: 'completed'; result: Uint8Array }>;

/** Required retained-data budgets, excluding JS/codec/transport overhead. @inline */
export interface DeliveryBudgets {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
}

/** Snapshot configuration once and normalize accessor failures without retaining their causes. */
export function readDeliveryOptions<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw new RpcError('INVALID_OPTION');
  }
}

export function validateBudgets(value: DeliveryBudgets): DeliveryBudgets {
  if (typeof value !== 'object' || value === null) throw new RpcError('INVALID_OPTION');
  const { maxEntries, maxBytes, maxEntryBytes } = value;
  if (
    !Number.isSafeInteger(maxEntries) ||
    maxEntries < 1 ||
    maxEntries > 10_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxEntryBytes) ||
    maxEntryBytes < 1 ||
    maxEntryBytes > maxBytes
  )
    throw new RpcError('INVALID_OPTION');
  return Object.freeze({
    maxEntries,
    maxBytes,
    maxEntryBytes,
  });
}

export function validateKey(value: unknown, code: RpcErrorCode = 'INVALID_OPTION'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new RpcError(code);
  }
  return value;
}

export function scopeBytes(value: string): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new RpcError('INVALID_OPTION');
  }
  const length = new TextEncoder().encode(value).byteLength;
  if (length > 256) throw new RpcError('INVALID_OPTION');
  return length;
}

export function byteLength(value: unknown, code: RpcErrorCode): number {
  if (!(value instanceof Uint8Array)) throw new RpcError(code);
  // Read the intrinsic getter: caller subclasses cannot forge retained-data accounting.
  const getter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(Uint8Array.prototype),
    'byteLength',
  )?.get;
  let length: unknown;
  try {
    length = getter?.call(value);
  } catch {
    throw new RpcError(code);
  }
  if (typeof length !== 'number' || !Number.isSafeInteger(length)) throw new RpcError(code);
  return length;
}

export function copyBytes(value: unknown, code: RpcErrorCode): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new RpcError(code);
  const length = byteLength(value, code);
  const copy = new Uint8Array(length);
  try {
    // Intrinsic set reads a typed-array view directly, ignoring iterators/species/overridden set.
    Uint8Array.prototype.set.call(copy, value);
  } catch {
    throw new RpcError(code);
  }
  return copy;
}

export function commandBytes(key: string, payload: Uint8Array, scope = ''): number {
  return checkedSum(
    16,
    key.length,
    byteLength(payload, 'INVALID_MESSAGE'),
    scope === '' ? 0 : scopeBytes(scope),
  );
}

export function checkedSum(...values: readonly number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new RpcError('LIMIT_EXCEEDED');
  return total;
}

export function expiry(now: number, duration: number): number {
  validateTimeout(duration);
  const value = now + duration;
  if (!Number.isSafeInteger(value) || value < 1) throw new RpcError('INVALID_OPTION');
  return value;
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null) throw new RpcError('INVALID_MESSAGE');
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor || !('value' in descriptor)) throw new RpcError('INVALID_MESSAGE');
  return descriptor.value;
}

function readExpiry(value: unknown): number {
  const result = field(value, 'expiresAt');
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1) {
    throw new RpcError('INVALID_MESSAGE');
  }
  return result;
}

/** Validate fields without copying payload; callers enforce byte budgets before allocation. */
export function readCommand(value: unknown): DeliveryCommand {
  const key = validateKey(field(value, 'key'), 'INVALID_MESSAGE');
  const expiresAt = readExpiry(value);
  const payload = field(value, 'payload');
  if (!(payload instanceof Uint8Array)) throw new RpcError('INVALID_MESSAGE');
  byteLength(payload, 'INVALID_MESSAGE');
  return Object.freeze({ key, expiresAt, payload });
}

export function readReceipt(value: unknown): DeliveryReceipt {
  const key = validateKey(field(value, 'key'), 'INVALID_MESSAGE');
  const state = field(value, 'state');
  if (state === 'missing') return Object.freeze({ key, state });
  const expiresAt = readExpiry(value);
  if (state === 'pending' || state === 'uncertain') return Object.freeze({ key, state, expiresAt });
  if (state !== 'completed') throw new RpcError('INVALID_MESSAGE');
  const result = field(value, 'result');
  if (!(result instanceof Uint8Array)) throw new RpcError('INVALID_MESSAGE');
  byteLength(result, 'INVALID_MESSAGE');
  return Object.freeze({ key, state, expiresAt, result });
}
