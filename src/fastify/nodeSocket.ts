import { Buffer } from 'node:buffer';
import type { RawData, WebSocket } from 'ws';
import type { RpcClientOptions } from '../core/connectionTypes.js';
import { isRpcErrorCode, RpcError } from '../core/rpcError.js';
import { assertMessageSize } from '../core/socketLimits.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;

/** Internal Node bridge; never imported by the root or client entry. */
export interface NodeSocketBridge {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Normalize ws events and bound graceful close without leaking native errors or payloads. */
export function createNodeSocketBridge(native: WebSocket, maxBytes: number): NodeSocketBridge {
  assertMessageSize('', maxBytes);
  const events = new EventTarget();
  const completion = Promise.withResolvers<void>();
  let finished = false;
  let cancelWatchdog: (() => void) | undefined;

  function startClose(code = 1000, reason = 'CLOSED'): void {
    if (finished) return;
    if (!cancelWatchdog) {
      const timer = setTimeout(() => native.terminate(), 1000);
      cancelWatchdog = (): void => clearTimeout(timer);
    }
    try {
      native.close(code, isRpcErrorCode(reason) ? reason : 'CLOSED');
    } catch {
      native.terminate();
    }
  }

  function onMessage(data: RawData, binary: boolean): void {
    try {
      let bytes: Buffer;
      if (Array.isArray(data)) {
        let length = 0;
        for (const fragment of data) {
          length += fragment.byteLength;
          if (length > maxBytes) throw new RpcError('PAYLOAD_TOO_LARGE');
        }
        bytes = Buffer.concat(data, length);
      } else {
        assertMessageSize(data, maxBytes);
        bytes = data instanceof ArrayBuffer ? Buffer.from(data) : data;
      }
      const payload = binary ? new Uint8Array(bytes).slice().buffer : bytes.toString('utf8');
      events.dispatchEvent(new MessageEvent('message', { data: payload }));
    } catch {
      startClose(1009, 'PAYLOAD_TOO_LARGE');
    }
  }

  function onError(): void {
    events.dispatchEvent(new Event('error'));
    startClose(1008, 'DISCONNECTED');
  }

  function onClose(code: number, reason: Buffer): void {
    if (finished) return;
    finished = true;
    cancelWatchdog?.();
    cancelWatchdog = undefined;
    native.off('message', onMessage);
    native.off('error', onError);
    native.off('close', onClose);
    const text = reason.toString('utf8');
    events.dispatchEvent(
      Object.assign(new Event('close'), {
        code,
        reason: isRpcErrorCode(text) ? text : 'DISCONNECTED',
        wasClean: code !== 1006,
      }),
    );
    completion.resolve();
  }

  const socket: Socket = {
    get readyState(): Socket['readyState'] {
      return native.readyState;
    },
    get bufferedAmount(): number {
      return native.bufferedAmount;
    },
    // All emitted events above have the WebSocket event-map shape used by our handlers.
    addEventListener: events.addEventListener.bind(events) as Socket['addEventListener'],
    removeEventListener: events.removeEventListener.bind(events) as Socket['removeEventListener'],
    send: (data): void => {
      assertMessageSize(data, maxBytes);
      native.send(data, (error) => {
        if (error) onError();
      });
    },
    close: startClose,
  };
  native.on('message', onMessage);
  native.on('error', onError);
  native.on('close', onClose);
  if (native.readyState === 3) onClose(1006, Buffer.alloc(0));
  return {
    socket,
    closed: completion.promise,
    close: (): Promise<void> => {
      startClose();
      return completion.promise;
    },
  };
}
