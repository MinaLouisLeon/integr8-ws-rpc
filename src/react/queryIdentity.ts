import type { QueryKey } from '@tanstack/react-query';
import type { ConnectionSnapshot } from '../core/connectionTypes.js';
import { RpcError } from '../core/rpcError.js';

/** Borrowed typed handle; no upstream router/client constraint erases required call context. @inline */
export interface QueryConnection<TClient extends object> {
  readonly client: TClient;
  getSnapshot(): ConnectionSnapshot;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

/** Internal cache namespace, independent of credentials, sockets and authentication session IDs. */
export function effectiveKey(connection: object, scope: string, key: QueryKey): QueryKey {
  if (
    (typeof connection !== 'object' && typeof connection !== 'function') ||
    connection === null ||
    typeof scope !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(scope) ||
    !Array.isArray(key) ||
    key.length === 0
  )
    throw new RpcError('INVALID_OPTION');
  let identity = identities.get(connection);
  if (identity === undefined) {
    if (nextIdentity >= Number.MAX_SAFE_INTEGER) throw new RpcError('LIMIT_EXCEEDED');
    identity = ++nextIdentity;
    identities.set(connection, identity);
  }
  return Object.freeze(['integr8-ws-rpc', scope, identity, ...key]);
}

export function assertReady<TClient extends object>(connection: QueryConnection<TClient>): void {
  const snapshot = connection.getSnapshot();
  if (snapshot.state !== 'ready') {
    throw new RpcError(snapshot.state === 'closed' ? 'CLOSED' : 'DISCONNECTED');
  }
}

export function validateCacheDuration(value: number | undefined): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)) {
    throw new RpcError('INVALID_OPTION');
  }
  return value;
}
