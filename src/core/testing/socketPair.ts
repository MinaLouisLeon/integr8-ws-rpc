import type { RpcClientOptions } from '../connectionTypes.js';
import { FakeSocket } from './fakeSocket.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;

/** Private test-only pair; messages use microtasks and never create a real network connection. */
export interface SocketPair {
  readonly client: Socket;
  readonly server: Socket;
  readonly clientSocket: FakeSocket;
  readonly serverSocket: FakeSocket;
  close(): void;
}

/** Create two controlled sockets; the default open state can be disabled for connection races. */
export function createSocketPair(open = true): SocketPair {
  const left = new FakeSocket();
  const right = new FakeSocket();
  function endpoint(source: FakeSocket, target: FakeSocket): Socket {
    return {
      get readyState(): Socket['readyState'] {
        return source.socket.readyState;
      },
      get bufferedAmount(): number {
        return source.socket.bufferedAmount;
      },
      addEventListener: source.socket.addEventListener,
      removeEventListener: source.socket.removeEventListener,
      send: (data): void => {
        source.socket.send(data);
        queueMicrotask(() => {
          source.drain();
          target.receive(data);
        });
      },
      close: (code = 1000, reason = ''): void => {
        source.finishClose(code, reason);
        target.finishClose(code, reason);
      },
    };
  }
  if (open) {
    left.open();
    right.open();
  }
  return {
    client: endpoint(left, right),
    server: endpoint(right, left),
    clientSocket: left,
    serverSocket: right,
    close: (): void => {
      left.finishClose();
      right.finishClose();
    },
  };
}
