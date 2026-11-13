import {
  type Client,
  type ClientContext,
  type ClientOptions,
  createORPCClient,
  ORPCError,
} from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import type { ConnectionSnapshot, RpcClientOptions } from '../core/connectionTypes.js';
import {
  type Hello,
  parseHello,
  parseHelloResponse,
  validateProtocolVersions,
} from '../core/handshake.js';
import { retainIterator } from '../core/iteratorLifetime.js';
import {
  runOperation,
  type Scheduler,
  systemScheduler,
  validateTimeout,
} from '../core/operation.js';
import { isRpcErrorCode, RpcError, type RpcErrorCode } from '../core/rpcError.js';
import { assertMessageSize, assertSendCapacity } from '../core/socketLimits.js';
import { createPeerClient, type PeerClient } from './peerClient.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;
type Listener = (snapshot: ConnectionSnapshot) => void;
// Derive the same client bound as the upstream factory. NestedClient<ClientContext> would
// exclude clients whose per-call context is required, due to parameter contravariance.
type UpstreamClient = ReturnType<typeof createORPCClient>;

type TransportClient = {
  readonly __integr8Transport: {
    readonly hello: Client<Record<never, never>, Hello, unknown, unknown>;
  };
};

interface Attempt {
  readonly controller: AbortController;
  readonly deadlineAt: number;
  socket: Socket | undefined;
  peer: PeerClient<ClientContext> | undefined;
  link: StandardRPCLink<ClientContext> | undefined;
}

/**
 * Private attempt/call primitive. Public createRpcClient owns retry, heartbeat and managed
 * subscriptions; this primitive never queues or replays application operations.
 */
export interface UnaryConnection<TClient extends UpstreamClient> {
  readonly client: TClient;
  connect(): Promise<void>;
  close(): Promise<void>;
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: Listener): () => void;
  /** Internal control methods used by the public lifecycle owner. */
  ping(): Promise<void>;
  disconnect(code?: RpcErrorCode): void;
}

/** Build a lazy typed unary client without accessing a global socket or starting a timer. */
export function createUnaryConnection<TClient extends UpstreamClient>(
  sourceOptions: RpcClientOptions,
  scheduler: Scheduler = systemScheduler,
): UnaryConnection<TClient> {
  const versions = validateProtocolVersions(sourceOptions.protocolVersions);
  if (
    versions.length > 8 ||
    typeof sourceOptions.getToken !== 'function' ||
    typeof sourceOptions.createWebSocket !== 'function'
  ) {
    throw new RpcError('INVALID_OPTION');
  }
  const options: RpcClientOptions = { ...sourceOptions, protocolVersions: versions };
  const endpoint = validateEndpoint(options.url);
  const handshakeTimeoutMs = validateTimeout(options.handshakeTimeoutMs ?? 10_000);
  const callTimeoutMs = validateTimeout(options.callTimeoutMs ?? 30_000);
  assertMessageSize('', options.maxMessageBytes ?? 1024 * 1024);
  assertSendCapacity(0, 0, options.maxBufferedBytes ?? 1024 * 1024);
  const maxCalls = options.maxInFlightCalls ?? 100;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10_000) {
    throw new RpcError('INVALID_OPTION');
  }
  let snapshot: ConnectionSnapshot = Object.freeze({ state: 'idle', attempt: 0 });
  let attemptNumber = 0;
  let active: Attempt | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  let terminal: RpcErrorCode | undefined;
  const listeners = new Set<Listener>();

  function publish(next: ConnectionSnapshot): void {
    snapshot = Object.freeze(next);
    const committed = snapshot;
    for (const listener of [...listeners]) {
      if (snapshot !== committed) {
        break;
      }
      if (!listeners.has(listener)) {
        continue;
      }
      try {
        void Promise.resolve(listener(committed)).catch(() => {});
      } catch {
        // Observers cannot change a committed transition or expose raw exceptions.
      }
    }
  }

  function releaseAttempt(attempt: Attempt, code: RpcErrorCode): void {
    attempt.controller.abort(new RpcError(code));
    const peer = attempt.peer;
    const socket = attempt.socket;
    attempt.peer = undefined;
    attempt.socket = undefined;
    attempt.link = undefined;
    if (peer) {
      peer.dispose(code);
    } else {
      try {
        socket?.close(code === 'CLOSED' ? 1000 : 1008, code);
      } catch {
        // Do not retain platform errors or a raw URL.
      }
    }
  }

  function failAttempt(attempt: Attempt, error: RpcError): void {
    if (active !== attempt || closed) {
      releaseAttempt(attempt, error.code);
      return;
    }
    active = undefined;
    pending = undefined;
    if (['AUTH_FAILED', 'PROTOCOL_MISMATCH', 'INVALID_OPTION'].includes(error.code)) {
      terminal = error.code;
    }
    releaseAttempt(attempt, error.code);
    publish({ state: 'error', attempt: attemptNumber, lastErrorCode: error.code });
  }

  function assertActive(attempt: Attempt, signal: AbortSignal): void {
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      throw reason instanceof RpcError ? reason : new RpcError('DISCONNECTED');
    }
    if (closed || active !== attempt) {
      throw new RpcError(closed ? 'CLOSED' : 'DISCONNECTED');
    }
  }

  function assertHandshakeActive(attempt: Attempt, signal: AbortSignal): void {
    assertActive(attempt, signal);
    if (scheduler.now() >= attempt.deadlineAt) {
      throw new RpcError('HANDSHAKE_TIMEOUT');
    }
  }

  async function authenticate(attempt: Attempt): Promise<void> {
    try {
      const remaining = attempt.deadlineAt - scheduler.now();
      if (remaining <= 0) {
        throw new RpcError('HANDSHAKE_TIMEOUT');
      }
      await runOperation(
        async (signal) => {
          assertHandshakeActive(attempt, signal);
          let token: string;
          try {
            token = await options.getToken();
          } catch {
            assertHandshakeActive(attempt, signal);
            throw new RpcError('AUTH_FAILED');
          }
          assertHandshakeActive(attempt, signal);
          const hello = parseHello({ transportVersion: 1, protocolVersions: versions, token });
          try {
            attempt.socket = options.createWebSocket(endpoint);
          } catch {
            throw new RpcError('DISCONNECTED');
          }
          const socket = attempt.socket;
          assertHandshakeActive(attempt, signal);
          attempt.peer = createPeerClient<ClientContext>(socket, {
            maxMessageBytes: options.maxMessageBytes ?? 1024 * 1024,
            maxBufferedBytes: options.maxBufferedBytes ?? 1024 * 1024,
            maxInFlightCalls: maxCalls,
            maxSubscriptions: options.maxSubscriptions ?? 32,
            maxPendingStreamItems: options.maxPendingStreamItems ?? 256,
            maxPendingStreamBytes: options.maxPendingStreamBytes ?? 1024 * 1024,
            onDisconnect: (code) => failAttempt(attempt, new RpcError(code)),
          });
          const link = new StandardRPCLink<ClientContext>(attempt.peer.sender, {
            url: 'http://orpc',
          });
          attempt.link = link;
          await waitForOpen(socket, signal);
          assertHandshakeActive(attempt, signal);
          publish({ state: 'authenticating', attempt: attemptNumber });
          assertHandshakeActive(attempt, signal);
          const transport = createORPCClient<TransportClient>(link);
          let response: unknown;
          try {
            response = await transport.__integr8Transport.hello(hello, { signal });
          } catch (error) {
            if (error instanceof RpcError) {
              throw error;
            }
            if (error instanceof ORPCError && isRpcErrorCode(error.code)) {
              throw new RpcError(error.code);
            }
            throw new RpcError('AUTH_FAILED');
          }
          assertHandshakeActive(attempt, signal);
          const reply = parseHelloResponse(response, versions);
          assertHandshakeActive(attempt, signal);
          if (reply.expiresAt !== undefined && reply.expiresAt <= scheduler.now()) {
            throw new RpcError('AUTH_EXPIRED');
          }
          publish({
            state: 'ready',
            attempt: attemptNumber,
            sessionId: reply.sessionId,
            protocolVersion: reply.protocolVersion,
          });
          assertActive(attempt, signal);
        },
        {
          lifetime: attempt.controller.signal,
          timeoutMs: Math.min(handshakeTimeoutMs, Math.ceil(remaining)),
          timeoutCode: 'HANDSHAKE_TIMEOUT',
          scheduler,
        },
      );
    } catch (error) {
      const failure = error instanceof RpcError ? error : new RpcError('INTERNAL');
      failAttempt(attempt, failure);
      throw failure;
    }
  }

  function connect(): Promise<void> {
    if (closed) {
      return Promise.reject(new RpcError('CLOSED'));
    }
    if (snapshot.state === 'ready') {
      return Promise.resolve();
    }
    if (terminal) {
      return Promise.reject(new RpcError(terminal));
    }
    if (pending) {
      return pending;
    }
    const attempt: Attempt = {
      controller: new AbortController(),
      deadlineAt: scheduler.now() + handshakeTimeoutMs,
      socket: undefined,
      peer: undefined,
      link: undefined,
    };
    active = attempt;
    attemptNumber += 1;
    // Queue startup so even a reentrant observer sees the shared attempt promise first.
    const promise = new Promise<void>((resolve, reject) => {
      void Promise.resolve()
        .then(() => authenticate(attempt))
        .then(resolve, reject);
    });
    pending = promise;
    const clearPending = (): void => {
      if (pending === promise) {
        pending = undefined;
      }
    };
    void promise.then(clearPending, clearPending);
    publish({ state: 'connecting', attempt: attemptNumber });
    return promise;
  }

  async function callApplication(
    path: readonly string[],
    input: unknown,
    callOptions: ClientOptions<ClientContext>,
  ): Promise<unknown> {
    const attempt = active;
    if (closed) {
      throw new RpcError('CLOSED');
    }
    if (snapshot.state !== 'ready' || !attempt?.link || attempt.socket?.readyState !== 1) {
      throw new RpcError('DISCONNECTED');
    }
    if (path[0] === '__integr8Transport') {
      throw new RpcError('INVALID_OPTION');
    }
    const link = attempt.link;
    try {
      const result = await runOperation(
        (signal) => {
          assertActive(attempt, signal);
          return link.call(path, input, { ...callOptions, signal });
        },
        {
          ...(callOptions.signal ? { signal: callOptions.signal } : {}),
          lifetime: attempt.controller.signal,
          timeoutMs: callTimeoutMs,
          scheduler,
        },
      );
      return retainIterator(result, {
        ...(callOptions.signal ? { signal: callOptions.signal } : {}),
        lifetime: attempt.controller.signal,
      });
    } catch (error) {
      if (error instanceof ORPCError && !error.defined && isRpcErrorCode(error.code)) {
        throw new RpcError(error.code);
      }
      if (
        !closed &&
        error instanceof RpcError &&
        ['DISCONNECTED', 'AUTH_FAILED', 'AUTH_EXPIRED', 'CLOSED'].includes(error.code)
      ) {
        // Once dispatched, upstream encoding/send may have occurred. Never infer non-execution
        // from a lost response, and never replay or enqueue this call.
        throw new RpcError('OUTCOME_UNKNOWN');
      }
      throw error;
    }
  }

  async function close(): Promise<void> {
    if (closed) {
      return;
    }
    closed = true;
    const attempt = active;
    active = undefined;
    pending = undefined;
    if (attempt) {
      releaseAttempt(attempt, 'CLOSED');
    }
    publish({ state: 'closed', attempt: attemptNumber });
    listeners.clear();
  }

  const client = createORPCClient<TClient>({ call: callApplication });
  return Object.freeze({
    client,
    connect,
    close,
    ping: async (): Promise<void> => {
      const attempt = active;
      if (!attempt?.link || snapshot.state !== 'ready') throw new RpcError('DISCONNECTED');
      const link = attempt.link;
      await runOperation(
        async (signal) => {
          await link.call(['__integr8Transport', 'ping'], undefined, { context: {}, signal });
        },
        {
          lifetime: attempt.controller.signal,
          timeoutMs: options.heartbeatTimeoutMs ?? 10_000,
          scheduler,
        },
      );
    },
    disconnect: (code: RpcErrorCode = 'DISCONNECTED'): void => {
      if (active) failAttempt(active, new RpcError(code));
    },
    getSnapshot: (): ConnectionSnapshot => snapshot,
    subscribe: (listener: Listener): (() => void) => {
      if (!closed) {
        listeners.add(listener);
      }
      return (): void => {
        listeners.delete(listener);
      };
    },
  });
}

function validateEndpoint(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if (
      (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new RpcError('INVALID_OPTION');
    }
    return url.href;
  } catch {
    throw new RpcError('INVALID_OPTION');
  }
}

function waitForOpen(socket: Socket, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      socket.removeEventListener('open', onOpen);
      signal.removeEventListener('abort', onAbort);
    }
    function onOpen(): void {
      cleanup();
      resolve();
    }
    function onAbort(): void {
      cleanup();
      const reason: unknown = signal.reason;
      reject(reason instanceof RpcError ? reason : new RpcError('DISCONNECTED'));
    }
    if (signal.aborted) {
      onAbort();
    } else if (socket.readyState === 1) {
      resolve();
    } else if (socket.readyState !== 0) {
      reject(new RpcError('DISCONNECTED'));
    } else {
      socket.addEventListener('open', onOpen, { once: true });
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
