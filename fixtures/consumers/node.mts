import assert from 'node:assert/strict';
import { RpcError } from '@integr8-media/ws-rpc';
import { chunkBinary, createRpcClient, createRpcClientGroup } from '@integr8-media/ws-rpc/client';
import { registerRpcWebSocket } from '@integr8-media/ws-rpc/fastify';
import { createRpcServer } from '@integr8-media/ws-rpc/server';
import { safe } from '@orpc/client';
import Fastify from 'fastify';
import { type ExampleClient, exampleRouter } from './router.ts';

const app = Fastify({ logger: false });
const server = createRpcServer({
  router: exampleRouter,
  protocolVersions: [1],
  authenticate: async ({ token }) => {
    if (token !== 'packed-fake-token') throw new Error('Authentication rejected.');
    return { context: { principal: 'packed-node' } };
  },
});
const adapter = registerRpcWebSocket(app, server, {
  originPolicy: (origin) => origin === undefined,
});
app.get('/health', () => ({ alive: true }));
let connection: ReturnType<typeof createRpcClient<ExampleClient>> | undefined;
let closeGroup: (() => Promise<void>) | undefined;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object');
  connection = createRpcClient<ExampleClient>({
    url: `ws://127.0.0.1:${address.port}/rpc`,
    protocolVersions: [1],
    getToken: async () => 'packed-fake-token',
    createWebSocket: (url) => new WebSocket(url),
    reconnect: false,
  });
  assert.equal(connection.getSnapshot().state, 'idle');
  const group = createRpcClientGroup({ main: connection });
  closeGroup = () => group.close();
  assert.deepEqual(await group.connectAll(), { main: { status: 'fulfilled' } });
  assert.deepEqual(await connection.client.lookup({ id: 'node' }), {
    id: 'node',
    owner: 'packed-node',
  });
  const missing = await safe(connection.client.lookup({ id: 'missing' }));
  assert(missing.isDefined);
  assert.equal(missing.error.code, 'NOT_FOUND');
  assert.deepEqual(missing.error.data, { id: 'missing' });
  const events = await connection.client.events({ count: 3 });
  const sequences: number[] = [];
  for await (const event of events) sequences.push(event.sequence);
  assert.deepEqual(sequences, [0, 1, 2]);
  let received = 0;
  const progress: number[] = [];
  for await (const chunk of chunkBinary(new Uint8Array([1, 2, 3, 4, 5]), {
    maxBytes: 5,
    chunkBytes: 2,
    onProgress: (value) => {
      progress.push(value.producedBytes);
    },
  })) {
    const response = await connection.client.binarySize(new Blob([new Uint8Array(chunk).buffer]));
    received += response.receivedBytes;
  }
  assert.equal(received, 5);
  assert.deepEqual(progress, [0, 2, 4, 5, 5]);
  const closed = group.close();
  await closed;
  await assert.rejects(connection.connect(), RpcError);
  await adapter.dispose();
  assert.equal(app.server.listening, true);
  assert.equal((await app.inject('/health')).statusCode, 200);
} finally {
  await closeGroup?.();
  await connection?.close();
  await adapter.dispose();
  await server.close();
  await app.close();
}
process.stdout.write('Packed Node consumer: typed unary/error/stream/disposal checks completed.\n');
