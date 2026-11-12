import assert from 'node:assert/strict';
import { os } from '@orpc/server';
import Fastify from 'fastify';
import * as z from 'zod';
import { createRpcClient } from '../dist/browser/client/index.mjs';
import { RpcError } from '../dist/browser/index.mjs';
import { registerRpcWebSocket } from '../dist/node/fastify/index.mjs';
import { createRpcServer } from '../dist/node/server/index.mjs';

// Loopback-only fixture credentials; never use this example authentication in production.
const fakeToken = 'playground-fake-token';
assert.throws(
  () =>
    createRpcServer({
      router: { __integr8Transport: {} },
      protocolVersions: [1],
      authenticate: async () => ({ context: {} }),
    }),
  RpcError,
);
const router = {
  greet: os
    .$context()
    .input(z.object({ name: z.string() }))
    .handler(({ input, context }) => ({
      greeting: `Hello ${input.name}`,
      principal: context.principal,
    })),
};
const app = Fastify({ logger: false });
const server = createRpcServer({
  router,
  protocolVersions: [1],
  authenticate: async ({ token }) => {
    if (token !== fakeToken) throw new Error('Authentication rejected.');
    return { context: { principal: 'playground' } };
  },
});
const adapter = registerRpcWebSocket(app, server, {
  originPolicy: (origin) => origin === undefined,
});
let connection;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object');
  connection = createRpcClient({
    url: `ws://127.0.0.1:${address.port}/rpc`,
    protocolVersions: [1],
    getToken: async () => fakeToken,
    createWebSocket: (url) => new WebSocket(url),
    reconnect: false,
  });
  assert.equal(connection.getSnapshot().state, 'idle');
  await connection.connect();
  assert.deepEqual(await connection.client.greet({ name: 'RPC' }), {
    greeting: 'Hello RPC',
    principal: 'playground',
  });
  await adapter.dispose();
  assert.equal(app.server.listening, true);
  process.stdout.write('Authenticated unary RPC and adapter disposal smoke completed.\n');
} finally {
  await connection?.close();
  await adapter.dispose();
  await server.close();
  await app.close();
}
