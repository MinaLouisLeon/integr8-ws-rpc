import Fastify from 'fastify';
import { registerRpcWebSocket } from '../dist/node/fastify/index.mjs';
import { createRpcServer } from '../dist/node/server/index.mjs';
import { exampleRouter } from './router.ts';

/** Start an example application, not a product authentication service. */
export async function startExample({ port = 0, origin = 'http://127.0.0.1:5173' } = {}) {
  const app = Fastify({ logger: false });
  const server = createRpcServer({
    router: exampleRouter,
    protocolVersions: [1],
    authenticate: async ({ token }) => {
      if (token !== 'playground-fake-token') throw new Error('Authentication rejected.');
      return { context: { principal: 'playground' } };
    },
  });
  app.get('/health', () => ({ alive: true }));
  const adapter = registerRpcWebSocket(app, server, {
    originPolicy: (value) => value === undefined || value === origin,
  });
  const close = async () => {
    await adapter.dispose();
    await server.close();
    await app.close();
  };
  try {
    await app.listen({ host: '127.0.0.1', port });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback listener.');
    return { url: `ws://127.0.0.1:${address.port}/rpc`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
