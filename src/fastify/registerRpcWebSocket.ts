import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { RpcError } from '../core/rpcError.js';
import type { RpcServer } from '../server/createRpcServer.js';
import type { PeerBinding } from '../server/peer.js';
import { getServerBinding, type ServerBinding } from '../server/serverBinding.js';
import { createNodeSocketBridge, type NodeSocketBridge } from './nodeSocket.js';
import { assertOriginAllowed } from './originPolicy.js';

type OriginPolicy = (origin: string | undefined) => boolean | PromiseLike<boolean>;
/** @inline */
interface AdapterOptions {
  readonly path?: string;
  readonly originPolicy: OriginPolicy;
}
/** @inline */
interface AdapterHandle {
  /** Close this adapter's sessions; leave the caller's Fastify server and other routes alive. */
  dispose(): Promise<void>;
}
interface Attachment {
  readonly peer: PeerBinding;
  readonly bridge: NodeSocketBridge;
}
interface HostState {
  readonly paths: Set<string>;
  pluginQueued: boolean;
}
const hosts = new WeakMap<FastifyInstance, HostState>();

/**
 * Queue an authenticated RPC WebSocket route before Fastify starts listening.
 * Registration/boot errors surface through Fastify ready/listen; duplicate ownership is rejected
 * immediately. The origin predicate is mandatory, including its decision for absent Origin.
 * @inlineType OriginPolicy
 */
export function registerRpcWebSocket(
  instance: FastifyInstance,
  server: RpcServer,
  options: AdapterOptions,
): AdapterHandle {
  if (typeof options !== 'object' || options === null) throw new RpcError('INVALID_OPTION');
  const path = options.path ?? '/rpc';
  if (
    typeof options.originPolicy !== 'function' ||
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    /[?#:*\s]/.test(path) ||
    instance.server.listening
  ) {
    throw new RpcError('INVALID_OPTION');
  }
  let binding: ServerBinding | undefined = getServerBinding(server);
  if (binding.isClosed()) throw new RpcError('CLOSED');
  let policy: OriginPolicy | undefined = options.originPolicy;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const connections = new Set<Attachment>();
  let state = hosts.get(instance);
  if (!state) {
    state = { paths: new Set(), pluginQueued: false };
    hosts.set(instance, state);
  }
  if (state.paths.has(path) || instance.hasRoute({ method: 'GET', url: path })) {
    throw new RpcError('INVALID_OPTION');
  }
  state.paths.add(path);
  const maxBytes = binding.maxMessageBytes;
  try {
    // Queue cleanup before an owned plugin's default preClose waits for native ws clients.
    // onClose remains a fallback for host/plugin lifecycle variations.
    instance.addHook('preClose', async (): Promise<void> => {
      await dispose();
    });
    if (!instance.hasDecorator('websocketServer') && !state.pluginQueued) {
      state.pluginQueued = true;
      instance.register(websocket, {
        options: { maxPayload: maxBytes, perMessageDeflate: false },
        errorHandler: (_error, socket): void => {
          socket.terminate();
        },
      });
    }
    instance.after((error) => {
      if (error) throw new RpcError('INVALID_OPTION');
      // A host-installed plugin must already enforce a parser cap at least this strict.
      const parserLimit = instance.websocketServer.options.maxPayload;
      if (typeof parserLimit !== 'number' || parserLimit <= 0 || parserLimit > maxBytes) {
        throw new RpcError('INVALID_OPTION');
      }
      instance.get(
        path,
        {
          websocket: true,
          preValidation: async (request, reply): Promise<void> => {
            if (disposed || !binding || binding.isClosed()) {
              await reply.code(410).send({ code: 'CLOSED' });
              return;
            }
            try {
              await assertOriginAllowed(policy, request.headers.origin);
            } catch {
              await reply.code(403).send({ code: 'AUTH_FAILED' });
            }
          },
        },
        (socket): void => {
          if (disposed || !binding || binding.isClosed()) {
            socket.close(1008, 'CLOSED');
            return;
          }
          const bridge = createNodeSocketBridge(socket, maxBytes);
          try {
            const peer = binding.attach(bridge.socket, bridge.closed);
            const attachment = { peer, bridge };
            connections.add(attachment);
            void bridge.closed.then(() => connections.delete(attachment));
          } catch {
            void bridge.close();
          }
        },
      );
    });
    instance.addHook('onClose', async (): Promise<void> => {
      await dispose();
    });
  } catch {
    state.paths.delete(path);
    binding = undefined;
    policy = undefined;
    throw new RpcError('INVALID_OPTION');
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true;
    binding = undefined;
    policy = undefined;
    const closing = [...connections].map(({ peer, bridge }) => {
      peer.dispose('CLOSED');
      return bridge.close();
    });
    disposal = Promise.all(closing).then(() => {
      connections.clear();
    });
    // Fastify cannot unregister a booted route: keep its path reserved and reject future upgrades.
    return disposal;
  }
  return Object.freeze({ dispose });
}
