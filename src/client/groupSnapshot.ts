import type { ConnectionSnapshot, ConnectionState } from '../core/connectionTypes.js';
import { isRpcErrorCode, RpcError } from '../core/rpcError.js';

function isState(value: unknown): value is ConnectionState {
  return (
    typeof value === 'string' &&
    ['idle', 'connecting', 'authenticating', 'ready', 'reconnecting', 'error', 'closed'].includes(
      value,
    )
  );
}

/** Copy only the public, credential-free snapshot fields at the registry boundary. */
export function projectSnapshot(source: unknown): ConnectionSnapshot {
  if (typeof source !== 'object' || source === null) throw new RpcError('INVALID_OPTION');
  const state: unknown = 'state' in source ? source.state : undefined;
  const attempt: unknown = 'attempt' in source ? source.attempt : undefined;
  if (
    !isState(state) ||
    typeof attempt !== 'number' ||
    !Number.isSafeInteger(attempt) ||
    attempt < 0
  ) {
    throw new RpcError('INVALID_OPTION');
  }
  const code: unknown = 'lastErrorCode' in source ? source.lastErrorCode : undefined;
  if (code !== undefined && !isRpcErrorCode(code)) throw new RpcError('INVALID_OPTION');
  const error = code === undefined ? {} : { lastErrorCode: code };
  if (state === 'ready') {
    const sessionId: unknown = 'sessionId' in source ? source.sessionId : undefined;
    const protocolVersion: unknown =
      'protocolVersion' in source ? source.protocolVersion : undefined;
    if (
      typeof sessionId !== 'string' ||
      !sessionId.length ||
      sessionId.length > 128 ||
      typeof protocolVersion !== 'number' ||
      !Number.isSafeInteger(protocolVersion) ||
      protocolVersion < 1
    )
      throw new RpcError('INVALID_OPTION');
    return Object.freeze({
      state,
      attempt,
      sessionId,
      protocolVersion,
      ...error,
    });
  }
  return Object.freeze({ state, attempt, ...error });
}
