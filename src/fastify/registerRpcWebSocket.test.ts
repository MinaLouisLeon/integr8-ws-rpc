import { os, type RouterClient } from '@orpc/server';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createUnaryConnection } from '../client/connection.js';
import { createRpcServer } from '../server/createRpcServer.js';
import { createNodeSocketBridge } from './nodeSocket.js';
import { registerRpcWebSocket } from './registerRpcWebSocket.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function setup() {
  const instance = Fastify({ logger: false });
  const router = {
    who: os.$context<{ principal: string }>().handler(({ context }) => context.principal),
  };
  let authentications = 0;
  const server = createRpcServer({
    router,
    protocolVersions: [1],
    authenticate: async () => {
      authentications += 1;
      return { context: { principal: 'caller' } };
    },
  });
  cleanup.push(
    () => instance.close(),
    () => server.close(),
  );
  return { instance, server, router, authentications: (): number => authentications };
}

describe('registerRpcWebSocket', () => {
  it('registers the default route and authenticates typed calls with caller context', async () => {
    const fixture = setup();
    registerRpcWebSocket(fixture.instance, fixture.server, {
      originPolicy: (origin) => origin === 'https://app.example',
    });
    await fixture.instance.ready();
    const wire = await fixture.instance.injectWS('/rpc', {
      headers: { origin: 'https://app.example' },
    });
    const bridge = createNodeSocketBridge(wire, 1024 * 1024);
    const client = createUnaryConnection<RouterClient<typeof fixture.router>>({
      url: 'ws://127.0.0.1/rpc',
      protocolVersions: [1],
      getToken: async () => 'fake-token',
      createWebSocket: () => bridge.socket,
    });
    cleanup.push(
      () => client.close(),
      () => bridge.close(),
    );
    await client.connect();
    await expect(client.client.who()).resolves.toBe('caller');
  });

  it('rejects forbidden and absent origins before authentication', async () => {
    const fixture = setup();
    registerRpcWebSocket(fixture.instance, fixture.server, {
      originPolicy: (origin) => origin === 'https://app.example',
    });
    await fixture.instance.ready();
    await expect(
      fixture.instance.injectWS('/rpc', { headers: { origin: 'https://other.example' } }),
    ).rejects.toThrow();
    await expect(fixture.instance.injectWS('/rpc')).rejects.toThrow();
    expect(fixture.authentications()).toBe(0);
  });

  it('keeps unrelated HTTP routes alive after adapter disposal and rejects later upgrades', async () => {
    const fixture = setup();
    fixture.instance.get('/health', () => ({ alive: true }));
    const adapter = registerRpcWebSocket(fixture.instance, fixture.server, {
      originPolicy: (origin) => origin === undefined,
    });
    await fixture.instance.ready();
    await adapter.dispose();
    await adapter.dispose();
    await expect(fixture.instance.injectWS('/rpc')).rejects.toThrow();
    const response = await fixture.instance.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ alive: true });
  });

  it('fails duplicate path ownership visibly and requires an explicit origin predicate', () => {
    const fixture = setup();
    registerRpcWebSocket(fixture.instance, fixture.server, { originPolicy: () => true });
    expect(() =>
      registerRpcWebSocket(fixture.instance, fixture.server, { originPolicy: () => true }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }));
    expect(() =>
      registerRpcWebSocket(fixture.instance, fixture.server, {
        path: '/other',
        // @ts-expect-error Runtime callers must also supply an explicit origin policy.
        originPolicy: undefined,
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }));
  });

  it('disposes live adapter sessions when the host shuts down', async () => {
    const fixture = setup();
    registerRpcWebSocket(fixture.instance, fixture.server, { originPolicy: () => true });
    await fixture.instance.ready();
    const wire = await fixture.instance.injectWS('/rpc');
    const closed = new Promise<void>((resolve) => wire.once('close', () => resolve()));
    await fixture.instance.close();
    await closed;
    expect(wire.readyState).toBe(3);
  });
});
