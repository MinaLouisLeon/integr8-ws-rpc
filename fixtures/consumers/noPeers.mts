import type { RpcClientOptions } from '@integr8-media/ws-rpc';

// Both declaration compilation and runtime imports must work with optional peers absent.
const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
Object.defineProperty(globalThis, 'WebSocket', {
  configurable: true,
  get() {
    throw new Error('Base entry accessed WebSocket while importing.');
  },
});
try {
  const { RpcError } = await import('@integr8-media/ws-rpc');
  const { createRpcClient } = await import('@integr8-media/ws-rpc/client');
  const options: RpcClientOptions = {
    url: 'ws://127.0.0.1/rpc',
    protocolVersions: [1],
    getToken: async () => 'fake-unused',
    createWebSocket: () => {
      throw new Error('A lazy client must not open a socket.');
    },
  };
  const connection = createRpcClient(options);
  if (connection.getSnapshot().state !== 'idle') throw new Error('Expected lazy idle client.');
  if (new RpcError('DISCONNECTED').code !== 'DISCONNECTED') throw new Error('Invalid error entry.');
  await connection.close();
} finally {
  if (descriptor) Object.defineProperty(globalThis, 'WebSocket', descriptor);
  else Reflect.deleteProperty(globalThis, 'WebSocket');
}
