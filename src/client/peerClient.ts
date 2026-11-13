import type { ClientContext } from '@orpc/client';
import type { StandardLinkClient } from '@orpc/client/standard';
import {
  ClientPeer,
  type EncodedMessage,
  encodeRequestMessage,
  MessageType,
} from '@orpc/standard-server-peer';
import type { RpcClientOptions } from '../core/connectionTypes.js';
import { normalizeLimits } from '../core/limits.js';
import { runOperation } from '../core/operation.js';
import { isRpcErrorCode, RpcError, type RpcErrorCode } from '../core/rpcError.js';
import { assertMessageSize, assertSendCapacity } from '../core/socketLimits.js';
import { createPeerQuota } from './peerQuota.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;

interface PeerClientOptions {
  readonly maxMessageBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxInFlightCalls?: number;
  readonly maxSubscriptions?: number;
  readonly maxPendingStreamItems?: number;
  readonly maxPendingStreamBytes?: number;
  readonly onDisconnect?: (code: RpcErrorCode) => void;
}

/** Private owned transport for StandardRPCLink; no public handle or stream-bound claim. */
export interface PeerClient<TContext extends ClientContext> {
  readonly sender: StandardLinkClient<TContext>;
  dispose(code?: RpcErrorCode): void;
}

/**
 * Bind the stable upstream ClientPeer to one socket. Upstream owns frames, IDs and routing;
 * this layer owns listeners, local request admission, cancellation and safe failure cleanup.
 */
export function createPeerClient<TContext extends ClientContext = Record<never, never>>(
  socket: Socket,
  options: PeerClientOptions = {},
): PeerClient<TContext> {
  const maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  const maxCalls = options.maxInFlightCalls ?? 100;
  const limits = normalizeLimits(options);
  assertMessageSize('', maxMessageBytes);
  assertSendCapacity(0, 0, maxBufferedBytes);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 10_000) {
    throw new RpcError('INVALID_OPTION');
  }
  const lifetime = new AbortController();
  let disposed = false;
  let closedCode: RpcErrorCode = 'CLOSED';
  let inFlight = 0;
  const quota = createPeerQuota(limits, {
    close: (id, reason) => peer.close({ id, reason }),
    cancel: (id) => {
      void encodeRequestMessage(id, MessageType.ABORT_SIGNAL, undefined)
        .then(send)
        .catch(() => disconnect('INVALID_MESSAGE'));
    },
  });
  const peer = new ClientPeer(send);
  async function send(message: EncodedMessage): Promise<void> {
    // Upstream also sends from async abort listeners. Never reject those detached callbacks:
    // dispose/close rejects the request queues with the safe error instead.
    if (disposed) {
      return;
    }
    try {
      if (socket.readyState !== 1) {
        throw new RpcError('DISCONNECTED');
      }
      const data = normalizeOutgoing(message, maxMessageBytes);
      const bytes = assertMessageSize(data, maxMessageBytes);
      await quota.sent(data);
      if (disposed) return;
      assertSendCapacity(socket.bufferedAmount, bytes, maxBufferedBytes);
      socket.send(data);
    } catch (error) {
      disconnect(error instanceof RpcError ? error.code : 'DISCONNECTED');
    }
  }

  function disconnect(code: RpcErrorCode): void {
    if (disposed) {
      return;
    }
    disposed = true;
    closedCode = code;
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    const reason = new RpcError(code);
    lifetime.abort(reason);
    peer.close({ reason });
    quota.clear();
    try {
      if (socket.readyState !== 3) {
        socket.close(code === 'CLOSED' ? 1000 : code === 'PAYLOAD_TOO_LARGE' ? 1009 : 1008, code);
      }
    } catch {
      // Platform failures are not diagnostics and never become public causes.
    }
    try {
      options.onDisconnect?.(code);
    } catch {
      // A state observer must not break peer cancellation or listener removal.
    }
  }

  async function receive(event: MessageEvent<unknown>): Promise<void> {
    try {
      const data: unknown = event.data;
      assertMessageSize(data, maxMessageBytes);
      const normalized = data instanceof Blob ? await data.arrayBuffer() : data;
      if (disposed) {
        return;
      }
      const encoded =
        typeof normalized === 'string' || normalized instanceof ArrayBuffer
          ? normalized
          : ArrayBuffer.isView(normalized)
            ? new Uint8Array(
                normalized.buffer,
                normalized.byteOffset,
                normalized.byteLength,
              ).slice()
            : undefined;
      if (encoded === undefined) throw new RpcError('INVALID_MESSAGE');
      const message = await quota.received(encoded, assertMessageSize(encoded, maxMessageBytes));
      if (!disposed && message !== undefined) await peer.message(message);
    } catch (error) {
      disconnect(error instanceof RpcError ? error.code : 'INVALID_MESSAGE');
    }
  }

  let receiving: Promise<void> = Promise.resolve();
  let pendingFrames = 0;
  let pendingBytes = 0;
  function onMessage(event: MessageEvent<unknown>): void {
    if (disposed) return;
    let bytes: number;
    try {
      bytes = assertMessageSize(event.data, maxMessageBytes);
      const maxFrames = maxCalls + limits.maxSubscriptions * (limits.maxPendingStreamItems + 2);
      const maxBytes =
        maxMessageBytes * (maxCalls + 1) + limits.maxPendingStreamBytes * limits.maxSubscriptions;
      if (pendingFrames >= maxFrames || pendingBytes > maxBytes - bytes) {
        throw new RpcError('BACKPRESSURE');
      }
    } catch (error) {
      disconnect(error instanceof RpcError ? error.code : 'INVALID_MESSAGE');
      return;
    }
    pendingFrames += 1;
    pendingBytes += bytes;
    receiving = receiving
      .then(() => (disposed ? undefined : receive(event)))
      .finally(() => {
        pendingFrames -= 1;
        pendingBytes -= bytes;
      });
  }

  function onClose(event: Event): void {
    const code = 'reason' in event && isRpcErrorCode(event.reason) ? event.reason : 'DISCONNECTED';
    // A remote shutdown does not make the local handle explicitly closed.
    disconnect(code === 'CLOSED' ? 'DISCONNECTED' : code);
  }

  function onError(): void {
    disconnect('DISCONNECTED');
  }

  const sender: StandardLinkClient<TContext> = {
    call: async (request, _options, path) => {
      const control =
        path.length === 2 &&
        path[0] === '__integr8Transport' &&
        (path[1] === 'hello' || path[1] === 'ping');
      if (disposed) {
        throw new RpcError(closedCode);
      }
      if (request.signal?.aborted) {
        throw new RpcError('CANCELLED');
      }
      if (socket.readyState !== 1) {
        throw new RpcError('DISCONNECTED');
      }
      if (!control && inFlight >= maxCalls) {
        throw new RpcError('LIMIT_EXCEEDED');
      }
      if (!control) inFlight += 1;
      try {
        return await runOperation(
          async (signal) => {
            const response = await peer.request({ ...request, signal });
            const tracked = quota.response(response, request.signal, lifetime.signal);
            return { ...tracked, body: () => Promise.resolve(tracked.body) };
          },
          {
            ...(request.signal ? { signal: request.signal } : {}),
            lifetime: lifetime.signal,
          },
        );
      } finally {
        if (!control) inFlight -= 1;
      }
    },
  };
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  return Object.freeze({
    sender,
    dispose: (code?: RpcErrorCode): void => disconnect(code ?? 'CLOSED'),
  });
}

function normalizeOutgoing(message: EncodedMessage, maxBytes: number): string | ArrayBuffer {
  if (typeof message === 'string') {
    assertMessageSize(message, maxBytes);
    return message;
  }
  if (message.byteLength > maxBytes) {
    throw new RpcError('PAYLOAD_TOO_LARGE');
  }
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice().buffer;
  }
  return new Uint8Array(message).slice().buffer;
}
