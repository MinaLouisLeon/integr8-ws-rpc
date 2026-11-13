/** Stable transport/lifecycle codes. Application failures retain their upstream oRPC errors. */
export type RpcErrorCode =
  | 'INVALID_OPTION'
  | 'AUTH_FAILED'
  | 'AUTH_EXPIRED'
  | 'PROTOCOL_MISMATCH'
  | 'HANDSHAKE_TIMEOUT'
  | 'DISCONNECTED'
  | 'OUTCOME_UNKNOWN'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CLOSED'
  | 'LIMIT_EXCEEDED'
  | 'BACKPRESSURE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INVALID_MESSAGE'
  | 'INTERNAL';

const messages: Readonly<Record<RpcErrorCode, string>> = {
  INVALID_OPTION: 'The RPC configuration is invalid.',
  AUTH_FAILED: 'RPC authentication failed.',
  AUTH_EXPIRED: 'The RPC session expired.',
  PROTOCOL_MISMATCH: 'No compatible RPC protocol version is available.',
  HANDSHAKE_TIMEOUT: 'The RPC connection handshake timed out.',
  DISCONNECTED: 'The RPC connection is not ready.',
  OUTCOME_UNKNOWN: 'The connection was lost before the RPC outcome was known.',
  TIMEOUT: 'The RPC deadline elapsed.',
  CANCELLED: 'The RPC operation was cancelled.',
  CLOSED: 'The RPC connection was explicitly closed.',
  LIMIT_EXCEEDED: 'An RPC resource limit was exceeded.',
  BACKPRESSURE: 'RPC buffered data exceeded its limit.',
  PAYLOAD_TOO_LARGE: 'The encoded RPC message exceeded its size limit.',
  INVALID_MESSAGE: 'The peer sent an invalid RPC message.',
  INTERNAL: 'An internal RPC transport failure occurred.',
};

/** Internal boundary check for bounded transport codes; never expose arbitrary socket reasons. */
export function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}

/**
 * A transport failure with a fixed safe message and a stable code.
 *
 * The optional cause is retained for local inspection; never log the whole error or its cause.
 * Deadlines/cancellation do not prove a handler stopped before committing a mutation.
 */
export class RpcError extends Error {
  /** Safe error class name. */
  public override readonly name: string = 'RpcError';

  /** Machine-readable transport code. */
  public readonly code: RpcErrorCode;

  /** Create a transport error without including credentials or peer payloads in its message. */
  public constructor(code: RpcErrorCode, options?: ErrorOptions) {
    super(messages[code], options);
    this.code = code;
  }
}
