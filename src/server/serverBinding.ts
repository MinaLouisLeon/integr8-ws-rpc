import type { RpcClientOptions } from '../core/connectionTypes.js';
import { RpcError } from '../core/rpcError.js';
import type { PeerBinding } from './peer.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;

/** Internal bridge between the documented server handle and its platform adapters. */
export interface ServerBinding {
  readonly maxMessageBytes: number;
  attach(socket: Socket, closed?: Promise<void>): PeerBinding;
  isClosed(): boolean;
}

const bindings = new WeakMap<object, ServerBinding>();

/** Register only a package-owned server; never expose attachment as a public handle method. */
export function setServerBinding(handle: object, binding: ServerBinding): void {
  bindings.set(handle, binding);
}

/** Resolve a server handle at a package adapter boundary. */
export function getServerBinding(handle: object): ServerBinding {
  const binding = bindings.get(handle);
  if (!binding) {
    throw new RpcError('INVALID_OPTION');
  }
  return binding;
}
