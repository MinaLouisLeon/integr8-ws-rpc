import { os, type RouterClient } from '@orpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket } from '../core/testing/fakeSocket.js';
import { createSocketPair } from '../core/testing/socketPair.js';
import { createRpcServer } from '../server/createRpcServer.js';
import { getServerBinding } from '../server/serverBinding.js';
import { createRpcClient } from './createRpcClient.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});

function setup() {
  const router = {
    ping: os.handler(() => 'pong'),
    events: os.handler(async function* ({ signal }) {
      yield 1;
      signal?.throwIfAborted();
      await new Promise<void>((resolve) =>
        signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
    }),
  };
  const server = createRpcServer({
    router,
    protocolVersions: [1],
    authenticate: async () => ({ context: {} }),
  });
  const pairs: ReturnType<typeof createSocketPair>[] = [];
  cleanup.push(() => server.close());
  const factory = () => {
    const pair = createSocketPair();
    pairs.push(pair);
    getServerBinding(server).attach(pair.server);
    return pair.client;
  };
  return { router, factory, pairs };
}

describe('createRpcClient public factory', () => {
  it('is lazy and returns the documented client lifecycle and stream handle', async () => {
    const fixture = setup();
    const client = createRpcClient<RouterClient<typeof fixture.router>>({
      url: 'ws://127.0.0.1/rpc',
      protocolVersions: [1],
      getToken: async () => 'fake-token',
      createWebSocket: fixture.factory,
    });
    cleanup.push(() => client.close());
    expect(fixture.pairs).toHaveLength(0);
    const connecting = client.connect();
    expect(client.connect()).toBe(connecting);
    await connecting;
    await expect(client.client.ping()).resolves.toBe('pong');
    expect(typeof client.subscribeStream).toBe('function');
    await client.close();
    await client.close();
    await expect(client.connect()).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('retries a failed initial attempt with a fresh credential read', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    let attempts = 0;
    let reads = 0;
    const stalled = new FakeSocket();
    const client = createRpcClient<RouterClient<typeof fixture.router>>({
      url: 'ws://127.0.0.1/rpc',
      protocolVersions: [1],
      getToken: async () => {
        reads += 1;
        return 'fake-token';
      },
      createWebSocket: () => (++attempts === 1 ? stalled.socket : fixture.factory()),
      handshakeTimeoutMs: 5,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    });
    cleanup.push(() => client.close());
    const pending = client.connect();
    await vi.advanceTimersByTimeAsync(6);
    await pending;
    expect(reads).toBe(2);
    expect(stalled.listenerCount).toBe(0);
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resubscribes once per fresh epoch and emits a gap before new items', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const client = createRpcClient<RouterClient<typeof fixture.router>>({
      url: 'ws://127.0.0.1/rpc',
      protocolVersions: [1],
      getToken: async () => 'fake-token',
      createWebSocket: fixture.factory,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    });
    cleanup.push(() => client.close());
    const seen: Array<number | string> = [];
    let opened = 0;
    const subscription = client.subscribeStream(
      async (rpc, signal) => {
        opened += 1;
        return rpc.events(undefined, { signal });
      },
      {
        next: (item) => {
          seen.push(item);
        },
        error: () => {
          seen.push('error');
        },
        complete: () => {
          seen.push('complete');
        },
        gap: () => {
          seen.push('gap');
        },
      },
      { resubscribe: true },
    );
    await client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
    fixture.pairs[0]?.server.close(1000, 'DISCONNECTED');
    await vi.advanceTimersByTimeAsync(2);
    expect(seen).toEqual([1, 'gap', 1]);
    await subscription.unsubscribe();
    fixture.pairs[1]?.server.close(1000, 'DISCONNECTED');
    await vi.advanceTimersByTimeAsync(2);
    expect(opened).toBe(2);
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a reconnect delay on close and never allocates another socket', async () => {
    vi.useFakeTimers();
    const fixture = setup();
    const client = createRpcClient<RouterClient<typeof fixture.router>>({
      url: 'ws://127.0.0.1/rpc',
      protocolVersions: [1],
      getToken: async () => 'fake-token',
      createWebSocket: fixture.factory,
    });
    cleanup.push(() => client.close());
    await client.connect();
    fixture.pairs[0]?.server.close(1000, 'DISCONNECTED');
    await client.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.pairs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.getSnapshot().state).toBe('closed');
  });

  it('does not retry authentication rejection with revoked credentials', async () => {
    vi.useFakeTimers();
    const server = createRpcServer({
      router: { ping: os.handler(() => 'pong') },
      protocolVersions: [1],
      authenticate: async () => {
        throw new Error('fake-secret');
      },
    });
    cleanup.push(() => server.close());
    let reads = 0;
    const client = createRpcClient<{ ping(): Promise<string> }>({
      url: 'ws://127.0.0.1/rpc',
      protocolVersions: [1],
      getToken: async () => {
        reads += 1;
        return 'fake-token';
      },
      createWebSocket: () => {
        const pair = createSocketPair();
        getServerBinding(server).attach(pair.server);
        return pair.client;
      },
    });
    cleanup.push(() => client.close());
    await expect(client.connect()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(1);
    expect(client.getSnapshot()).toMatchObject({ state: 'error', lastErrorCode: 'AUTH_FAILED' });
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
