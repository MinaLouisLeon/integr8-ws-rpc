import { once } from 'node:events';
import { os, type RouterClient } from '@orpc/server';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket as NativeWebSocket } from 'ws';
import { createSocketPair } from '../core/testing/socketPair.js';
import { registerRpcWebSocket } from '../fastify/registerRpcWebSocket.js';
import { createRpcServer } from '../server/createRpcServer.js';
import { getServerBinding } from '../server/serverBinding.js';
import { createRpcClient } from './createRpcClient.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers();
});

async function nativeFixture(principal = 'native') {
  const app = Fastify({ logger: false });
  const produced = Promise.withResolvers<void>();
  const base = os.$context<{ principal: string }>();
  const router = {
    who: base.handler(({ context }) => context.principal),
    steady: base.handler(async function* (): AsyncGenerator<number> {
      yield 1;
    }),
    burst: base.handler(async function* ({
      signal,
    }): AsyncGenerator<{ sequence: number; data: string }> {
      try {
        for (let sequence = 0; sequence < 128; sequence += 1) {
          signal?.throwIfAborted();
          yield { sequence, data: 'x'.repeat(512) };
        }
      } finally {
        produced.resolve();
      }
    }),
  };
  const server = createRpcServer({
    router,
    protocolVersions: [1],
    authenticate: async ({ token }) => {
      if (token !== `${principal}-fake-token`) throw new Error('Rejected fixture credentials.');
      return { context: { principal } };
    },
  });
  const adapter = registerRpcWebSocket(app, server, {
    originPolicy: (origin) => origin === undefined,
  });
  cleanup.push(async () => {
    await adapter.dispose();
    await server.close();
    await app.close();
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback listener.');
  const url = `ws://127.0.0.1:${address.port}/rpc`;
  function client(limits: { maxPendingStreamItems?: number; maxPendingStreamBytes?: number } = {}) {
    const handle = createRpcClient<RouterClient<typeof router>>({
      url,
      protocolVersions: [1],
      getToken: async () => `${principal}-fake-token`,
      createWebSocket: (endpoint) => new WebSocket(endpoint),
      reconnect: false,
      ...limits,
    });
    cleanup.push(() => handle.close());
    return handle;
  }
  return { url, client, produced: produced.promise };
}

describe('native socket and repeated-lifecycle boundaries', () => {
  it('closes a malformed peer without disrupting an authenticated client', async () => {
    const fixture = await nativeFixture();
    const healthy = fixture.client();
    await healthy.connect();
    const malformed = new NativeWebSocket(fixture.url);
    cleanup.push(() => malformed.terminate());
    await once(malformed, 'open');
    const closed = once(malformed, 'close');
    malformed.send('{invalid');
    await closed;
    await expect(healthy.client.who()).resolves.toBe('native');
    expect(healthy.getSnapshot().state).toBe('ready');
  });

  it('rejects an oversized native frame before app execution while healthy peers survive', async () => {
    const fixture = await nativeFixture();
    const healthy = fixture.client();
    await healthy.connect();
    const oversized = new NativeWebSocket(fixture.url);
    cleanup.push(() => oversized.terminate());
    await once(oversized, 'open');
    const closed = once(oversized, 'close');
    oversized.send(new Uint8Array(1024 * 1024 + 1));
    await closed;
    await expect(healthy.client.who()).resolves.toBe('native');
  });

  it.each([
    { maxPendingStreamItems: 2, maxPendingStreamBytes: 1024 * 1024 },
    { maxPendingStreamItems: 256, maxPendingStreamBytes: 256 },
  ])('isolates a slow stream with limits %j on a real socket', async (limits) => {
    const fixture = await nativeFixture();
    const connection = fixture.client(limits);
    await connection.connect();
    // Observe both early admission failure and a delivered iterator: a fast peer may overflow
    // before the caller receives response headers. Neither path may poison later unary calls.
    const pending = connection.client.burst().then(
      (stream) => ({ stream, error: undefined }),
      (error: unknown) => ({ stream: undefined, error }),
    );
    await fixture.produced;
    await expect(connection.client.who()).resolves.toBe('native');
    const result = await pending;
    if (result.stream)
      await expect(result.stream.next()).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    else expect(result.error).toMatchObject({ code: 'BACKPRESSURE' });
    const healthyStream = await connection.client.steady();
    const items: number[] = [];
    for await (const item of healthyStream) items.push(item);
    expect(items).toEqual([1]);
    expect(connection.getSnapshot().state).toBe('ready');
  });

  it('keeps two server handles authenticated with separate contexts', async () => {
    const first = await nativeFixture('first');
    const second = await nativeFixture('second');
    const left = first.client();
    const right = second.client();
    await Promise.all([left.connect(), right.connect()]);
    await expect(left.client.who()).resolves.toBe('first');
    await expect(right.client.who()).resolves.toBe('second');
    await left.close();
    await expect(right.client.who()).resolves.toBe('second');
  });

  it('releases every fake-socket listener and owned timer over repeated public handle cycles', async () => {
    vi.useFakeTimers();
    const router = { who: os.handler(() => 'cycle') };
    const server = createRpcServer({
      router,
      protocolVersions: [1],
      authenticate: async () => ({ context: {} }),
    });
    cleanup.push(() => server.close());
    for (let iteration = 0; iteration < 30; iteration += 1) {
      const pair = createSocketPair();
      getServerBinding(server).attach(pair.server);
      const client = createRpcClient<RouterClient<typeof router>>({
        url: 'ws://127.0.0.1/rpc',
        protocolVersions: [1],
        getToken: async () => 'fake-token',
        createWebSocket: () => pair.client,
      });
      try {
        await client.connect();
        await expect(client.client.who()).resolves.toBe('cycle');
      } finally {
        await client.close();
      }
      expect(pair.clientSocket.listenerCount).toBe(0);
      expect(pair.serverSocket.listenerCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});
