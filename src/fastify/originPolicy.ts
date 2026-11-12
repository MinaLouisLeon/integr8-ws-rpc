import { RpcError } from '../core/rpcError.js';

type OriginPolicy = (origin: string | undefined) => boolean | PromiseLike<boolean>;

/** Internal pre-upgrade boundary. The Fastify adapter must call it before handing off a socket. */
export async function assertOriginAllowed(
  policy: OriginPolicy | undefined,
  origin: unknown,
): Promise<void> {
  if (typeof policy !== 'function') {
    throw new RpcError('INVALID_OPTION');
  }
  if (origin !== undefined && typeof origin !== 'string') {
    throw new RpcError('AUTH_FAILED');
  }
  try {
    if ((await policy(origin)) === true) {
      return;
    }
  } catch {
    // Origin policy failures can contain request details; do not retain/log the cause.
  }
  throw new RpcError('AUTH_FAILED');
}
