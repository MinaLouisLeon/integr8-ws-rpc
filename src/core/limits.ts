import { RpcError } from './rpcError.js';

/**
 * Internal normalized transport limits, shared by the documented client/server options.
 * @inline
 */
export interface TransportLimits {
  readonly maxMessageBytes: number;
  readonly maxBufferedBytes: number;
  readonly maxInFlightCalls: number;
  readonly maxSubscriptions: number;
  readonly maxPendingStreamItems: number;
  readonly maxPendingStreamBytes: number;
}

/** Validate finite integer limits before creating a socket, timer or listener. */
export function normalizeLimits(source: Partial<TransportLimits> = {}): TransportLimits {
  if (typeof source !== 'object' || source === null) throw new RpcError('INVALID_OPTION');
  const limits: TransportLimits = {
    maxMessageBytes: source.maxMessageBytes ?? 1024 * 1024,
    maxBufferedBytes: source.maxBufferedBytes ?? 1024 * 1024,
    maxInFlightCalls: source.maxInFlightCalls ?? 100,
    maxSubscriptions: source.maxSubscriptions ?? 32,
    maxPendingStreamItems: source.maxPendingStreamItems ?? 256,
    maxPendingStreamBytes: source.maxPendingStreamBytes ?? 1024 * 1024,
  };
  const maxima: TransportLimits = {
    maxMessageBytes: 64 * 1024 * 1024,
    maxBufferedBytes: 64 * 1024 * 1024,
    maxInFlightCalls: 10_000,
    maxSubscriptions: 1024,
    maxPendingStreamItems: 65_536,
    maxPendingStreamBytes: 64 * 1024 * 1024,
  };
  for (const name of Object.keys(limits) as Array<keyof TransportLimits>) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > maxima[name]) {
      throw new RpcError('INVALID_OPTION');
    }
  }
  return Object.freeze(limits);
}
