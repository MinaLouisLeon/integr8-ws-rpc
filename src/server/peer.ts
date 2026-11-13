import type { MinimalWebsocket } from '@orpc/server/websocket';
import { decodeRequestMessage, MessageType } from '@orpc/standard-server-peer';
import type { RpcClientOptions } from '../core/connectionTypes.js';
import { RpcError, type RpcErrorCode } from '../core/rpcError.js';
import { assertMessageSize, assertSendCapacity } from '../core/socketLimits.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;

/** Narrow structural view of the upstream public manual API, retaining its context type. */
interface ManualHandler<TContext extends object> {
  message(
    socket: MinimalWebsocket,
    data: string | ArrayBuffer | Blob,
    options: { context: TContext },
  ): Promise<void>;
  close(socket: MinimalWebsocket): void;
}

interface PeerOptions {
  readonly maxMessageBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxPendingMessages?: number;
  /** The owner must invalidate its session here; no peer exception or request payload is passed. */
  readonly onDisconnect?: (code: RpcErrorCode) => void;
}

/** Internal owned-listener handle. Public asynchronous transport disposal is integrated later. */
export interface PeerBinding {
  dispose(code?: RpcErrorCode): void;
}

/**
 * Attach a manual oRPC server peer without the Node adapter's raw error logger/anonymous listeners.
 * The native host must additionally enforce parser-level maxPayload and upgrade/rate limits.
 * This frame boundary does not establish per-subscription/upstream queue bounds.
 */
export function attachPeer<TContext extends object>(
  handler: ManualHandler<TContext>,
  socket: Socket,
  context: TContext,
  options: PeerOptions = {},
): PeerBinding {
  const maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
  const maxBufferedBytes = options.maxBufferedBytes ?? 1024 * 1024;
  const maxPendingMessages = options.maxPendingMessages ?? 133;
  if (!Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1) {
    throw new RpcError('INVALID_OPTION');
  }
  // Validate configuration before listeners or resources are installed.
  assertMessageSize('', maxMessageBytes);
  assertSendCapacity(0, 0, maxBufferedBytes);
  let disposed = false;
  let pendingMessages = 0;
  const facade: MinimalWebsocket = {
    addEventListener: socket.addEventListener.bind(socket),
    send: (data): void => {
      try {
        if (disposed || socket.readyState !== 1) {
          throw new RpcError('DISCONNECTED');
        }
        const bytes = assertMessageSize(data, maxMessageBytes);
        assertSendCapacity(socket.bufferedAmount, bytes, maxBufferedBytes);
        socket.send(data);
      } catch (error) {
        const code = error instanceof RpcError ? error.code : 'DISCONNECTED';
        disconnect(code);
        throw new RpcError(code);
      }
    },
  };

  function disconnect(code: RpcErrorCode): void {
    if (disposed) {
      return;
    }
    disposed = true;
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    try {
      handler.close(facade);
    } catch {
      // Continue releasing our resources even if upstream cleanup fails.
    }
    try {
      if (socket.readyState !== 3) {
        socket.close(code === 'CLOSED' ? 1000 : code === 'PAYLOAD_TOO_LARGE' ? 1009 : 1008, code);
      }
    } catch {
      // Never expose platform exception messages or reasons.
    }
    try {
      options.onDisconnect?.(code);
    } catch {
      // Observer failure cannot prevent listener removal or upstream cancellation.
    }
  }

  function onMessage(event: MessageEvent<unknown>): void {
    if (disposed) {
      return;
    }
    try {
      if (pendingMessages >= maxPendingMessages) {
        throw new RpcError('LIMIT_EXCEEDED');
      }
      assertMessageSize(event.data, maxMessageBytes);
      const payload = normalizeMessage(event.data);
      pendingMessages += 1;
      void processMessage(payload);
    } catch (error) {
      disconnect(error instanceof RpcError ? error.code : 'INVALID_MESSAGE');
    }
  }

  async function processMessage(payload: string | ArrayBuffer | Blob): Promise<void> {
    try {
      const encoded = payload instanceof Blob ? await payload.arrayBuffer() : payload;
      const decoded = await decodeRequestMessage(encoded);
      if (disposed) return;
      // First delivery supports server-to-client streams. Never let an untrusted client fill
      // upstream's unbounded input-event queue; client event-stream frames are not accepted.
      if (decoded[1] === MessageType.EVENT_ITERATOR) {
        throw new RpcError('INVALID_MESSAGE');
      }
      await handler.message(facade, encoded, { context });
    } catch (error) {
      disconnect(error instanceof RpcError ? error.code : 'INVALID_MESSAGE');
    } finally {
      pendingMessages -= 1;
    }
  }

  function onClose(): void {
    disconnect('DISCONNECTED');
  }

  function onError(): void {
    disconnect('DISCONNECTED');
  }

  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  return Object.freeze({ dispose: (code?: RpcErrorCode): void => disconnect(code ?? 'CLOSED') });
}

function normalizeMessage(data: unknown): string | ArrayBuffer | Blob {
  if (typeof data === 'string' || data instanceof ArrayBuffer || data instanceof Blob) {
    return data;
  }
  if (ArrayBuffer.isView(data)) {
    // Copy only the bounded view. Node Buffers can share a much larger backing allocation.
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  }
  throw new RpcError('INVALID_MESSAGE');
}
