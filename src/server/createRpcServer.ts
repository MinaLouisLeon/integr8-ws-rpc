import { type AnyRouter, type InferRouterInitialContext, ORPCError, os } from '@orpc/server';
import { RPCHandler } from '@orpc/server/websocket';
import * as z from 'zod';
import { validateProtocolVersions } from '../core/handshake.js';
import { normalizeLimits, type TransportLimits } from '../core/limits.js';
import { validateTimeout } from '../core/operation.js';
import { isRpcErrorCode, RpcError, type RpcErrorCode } from '../core/rpcError.js';
import { attachPeer, type PeerBinding } from './peer.js';
import { setServerBinding } from './serverBinding.js';
import { type AuthenticationInput, type AuthenticationResult, Session } from './session.js';

const sessionKey: unique symbol = Symbol('integr8 RPC session');

/** @inline */
interface ServerOptions<TRouter extends Record<string, AnyRouter>> {
  readonly router: TRouter;
  readonly protocolVersions: readonly number[];
  readonly authenticate: (
    input: AuthenticationInput,
  ) => PromiseLike<AuthenticationResult<InferRouterInitialContext<NoInfer<TRouter>>>>;
  readonly limits?: Partial<TransportLimits>;
  readonly handshakeTimeoutMs?: number;
  readonly callTimeoutMs?: number;
  readonly diagnostics?: (event: Readonly<{ code: RpcErrorCode; sessionId?: string }>) => void;
}

/**
 * Server lifecycle; the host retains ownership of its HTTP/Fastify instance.
 * @inline
 */
export interface RpcServer {
  /** Invalidate one authenticated session and cooperatively cancel its work. */
  disconnectSession(sessionId: string, reason?: RpcErrorCode): Promise<void>;
  /** Idempotently close every socket owned by this server handle. */
  close(): Promise<void>;
}

/**
 * Compose a caller-owned oRPC router with authenticated, versioned hello and guarded ping.
 * Authentication must return the router's required context. No socket/timer starts until attachment.
 */
export function createRpcServer<TRouter extends Record<string, AnyRouter>>(
  source: ServerOptions<TRouter>,
): RpcServer {
  if (
    typeof source !== 'object' ||
    source === null ||
    typeof source.router !== 'object' ||
    source.router === null ||
    '__integr8Transport' in source.router ||
    typeof source.authenticate !== 'function'
  ) {
    throw new RpcError('INVALID_OPTION');
  }
  const versions = validateProtocolVersions(source.protocolVersions);
  const limits = normalizeLimits(source.limits);
  const handshakeTimeoutMs = validateTimeout(source.handshakeTimeoutMs ?? 10_000);
  const callTimeoutMs = validateTimeout(source.callTimeoutMs ?? 30_000);
  type Principal = InferRouterInitialContext<TRouter>;
  type Envelope = { readonly [sessionKey]: Session<Principal> };
  const authenticated = new Map<string, Session<Principal>>();
  const live = new Set<Session<Principal>>();
  const closures = new Map<Session<Principal>, Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function report(code: RpcErrorCode, sessionId?: string): void {
    try {
      void Promise.resolve(
        source.diagnostics?.({
          code,
          ...(sessionId === undefined ? {} : { sessionId }),
        }),
      ).catch(() => {});
    } catch {
      // Diagnostics receive only safe codes/random IDs and cannot interrupt cleanup.
    }
  }

  const handle: RpcServer = Object.freeze({
    disconnectSession: async (
      sessionId: string,
      reason: RpcErrorCode = 'AUTH_FAILED',
    ): Promise<void> => {
      if (typeof sessionId !== 'string' || sessionId.length > 128 || !isRpcErrorCode(reason)) {
        throw new RpcError('INVALID_OPTION');
      }
      const session = authenticated.get(sessionId);
      const done = session ? closures.get(session) : undefined;
      session?.close(reason);
      await done;
    },
    close: (): Promise<void> => {
      if (closing) return closing;
      closed = true;
      const pending = [...closures.values()];
      const completion = Promise.withResolvers<void>();
      closing = completion.promise;
      for (const session of [...live]) session.close('CLOSED');
      void Promise.all(pending).then(() => {
        authenticated.clear();
        live.clear();
        completion.resolve();
      }, completion.reject);
      return closing;
    },
  });

  setServerBinding(handle, {
    maxMessageBytes: limits.maxMessageBytes,
    isClosed: (): boolean => closed,
    attach: (socket, socketClosed): PeerBinding => {
      if (closed) {
        throw new RpcError('CLOSED');
      }
      let binding: PeerBinding | undefined;
      let id: string | undefined;
      const session = new Session<Principal>({
        protocolVersions: versions,
        authenticate: source.authenticate,
        handshakeTimeoutMs,
        callTimeoutMs,
        maxInFlightCalls: limits.maxInFlightCalls,
        maxSubscriptions: limits.maxSubscriptions,
        onClose: (code) => {
          live.delete(session);
          if (id !== undefined) {
            authenticated.delete(id);
          }
          binding?.dispose(code);
          report(code, id);
        },
      });
      live.add(session);
      if (socketClosed) {
        closures.set(session, socketClosed);
        void socketClosed.then(
          () => closures.delete(session),
          () => closures.delete(session),
        );
      }
      const base = os.$context<Envelope>();
      const app = base
        .use(({ context, next }) =>
          next({
            context: context[sessionKey].getContext(),
          }),
        )
        .router(source.router);
      const router = {
        ...app,
        __integr8Transport: {
          hello: base.input(z.unknown()).handler(async ({ input }) => {
            const reply = await session.hello(input);
            session.getContext();
            id = reply.sessionId;
            authenticated.set(id, session);
            return reply;
          }),
          ping: base.handler((): { alive: true } => {
            session.getContext();
            return { alive: true };
          }),
        },
      };
      const handler = new RPCHandler(router, {
        clientInterceptors: [
          async ({ path, next, ...call }) => {
            try {
              if (path.length === 2 && path[0] === '__integr8Transport' && path[1] === 'hello') {
                return await next({ ...call, path });
              }
              if (path.length === 2 && path[0] === '__integr8Transport' && path[1] === 'ping') {
                session.getContext();
                return await next({ ...call, path });
              }
              return await session.runProcedure(
                (_principal, signal) =>
                  next({
                    ...call,
                    path,
                    signal,
                  }),
                call.signal,
              );
            } catch (error) {
              if (error instanceof RpcError) {
                throw new ORPCError(error.code, {
                  defined: false,
                  message: error.message,
                  status: statusFor(error.code),
                });
              }
              throw error;
            }
          },
        ],
      });
      try {
        binding = attachPeer(
          handler,
          socket,
          { [sessionKey]: session },
          {
            maxMessageBytes: limits.maxMessageBytes,
            maxBufferedBytes: limits.maxBufferedBytes,
            maxPendingMessages: limits.maxInFlightCalls + limits.maxSubscriptions + 1,
            onDisconnect: (code) => session.close(code),
          },
        );
      } catch (error) {
        session.close('INTERNAL');
        throw error instanceof RpcError ? error : new RpcError('INTERNAL');
      }
      return binding;
    },
  });
  return handle;
}

function statusFor(code: RpcErrorCode): number {
  if (code === 'AUTH_FAILED' || code === 'AUTH_EXPIRED') return 401;
  if (code === 'LIMIT_EXCEEDED' || code === 'BACKPRESSURE') return 429;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'TIMEOUT' || code === 'HANDSHAKE_TIMEOUT') return 408;
  if (code === 'CANCELLED') return 499;
  if (code === 'CLOSED') return 410;
  if (code === 'DISCONNECTED' || code === 'OUTCOME_UNKNOWN') return 503;
  if (code === 'PROTOCOL_MISMATCH' || code === 'INVALID_MESSAGE') return 400;
  return 500;
}
