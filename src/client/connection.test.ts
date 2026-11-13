import { ORPCError, os, type RouterClient } from '@orpc/server';
import { RPCHandler } from '@orpc/server/websocket';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { RpcClientOptions } from '../core/connectionTypes.js';
import { RpcError } from '../core/rpcError.js';
import { FakeSocket } from '../core/testing/fakeSocket.js';
import { createSocketPair } from '../core/testing/socketPair.js';
import { attachPeer, type PeerBinding } from '../server/peer.js';
import { Session, type SessionOptions } from '../server/session.js';
import { createUnaryConnection } from './connection.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
  vi.useRealTimers();
});

function fixture(
  options: {
    authenticate?: SessionOptions<{ userId: string }>['authenticate'];
    helloReply?: unknown;
  } = {},
) {
  const sockets = createSocketPair();
  let binding: PeerBinding | undefined;
  let mutations = 0;
  const started = Promise.withResolvers<AbortSignal>();
  const session = new Session({
    protocolVersions: [1, 2],
    authenticate: options.authenticate ?? (async () => ({ context: { userId: 'principal' } })),
    onClose: (code) => binding?.dispose(code),
  });
  const base = os.$context<{ userId?: string }>();
  const authenticated = base.use(({ context, next }) => {
    if (!context.userId) {
      throw new ORPCError('UNAUTHORIZED');
    }
    return next({ context: { userId: context.userId } });
  });
  const app = {
    lookup: authenticated
      .input(z.object({ id: z.string() }))
      .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
      .handler(({ input, context, errors }) => {
        if (input.id === 'missing') {
          throw errors.NOT_FOUND({ data: { id: input.id } });
        }
        return { id: input.id, owner: context.userId };
      }),
    mutate: authenticated.handler(() => {
      mutations += 1;
      sockets.server.close(1000, 'DISCONNECTED');
      return { committed: true };
    }),
    wait: authenticated.handler(async ({ signal }): Promise<void> => {
      if (!signal) {
        throw new Error('Missing upstream signal.');
      }
      started.resolve(signal);
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
    }),
  };
  const router = {
    ...app,
    __integr8Transport: {
      hello: base
        .input(z.unknown())
        .handler(
          async ({ input }): Promise<unknown> =>
            options.helloReply === undefined ? session.hello(input) : options.helloReply,
        ),
    },
  };
  const handler = new RPCHandler<{ userId?: string }>(router, {
    clientInterceptors: [
      ({ path, next, ...call }) => {
        if (path[0] === '__integr8Transport' && path[1] === 'hello') {
          return next({ ...call, path });
        }
        return session.runUnary(
          (context, signal) => next({ ...call, path, context, signal }),
          call.signal,
        );
      },
    ],
  });
  binding = attachPeer(
    handler,
    sockets.server,
    {},
    {
      onDisconnect: (code) => session.close(code),
    },
  );
  cleanup.push(
    () => session.close(),
    () => sockets.close(),
  );
  return { sockets, app, started: started.promise, mutationCount: (): number => mutations };
}

type AppClient = RouterClient<ReturnType<typeof fixture>['app']>;

function connection(
  socket: ReturnType<RpcClientOptions['createWebSocket']>,
  overrides: Partial<RpcClientOptions> = {},
) {
  const handle = createUnaryConnection<AppClient>({
    url: 'ws://127.0.0.1:3000/rpc',
    protocolVersions: [1, 2],
    getToken: async () => 'fake-token',
    createWebSocket: () => socket,
    ...overrides,
  });
  cleanup.push(() => {
    void handle.close();
  });
  return handle;
}

describe('unary client connection integration', () => {
  it('opens lazily and shares one authenticated attempt across callers', async () => {
    const server = fixture();
    let factories = 0;
    let credentials = 0;
    const handle = connection(server.sockets.client, {
      getToken: async () => {
        credentials += 1;
        return 'fake-token';
      },
      createWebSocket: () => {
        factories += 1;
        return server.sockets.client;
      },
    });
    expect(factories).toBe(0);
    await expect(handle.client.lookup({ id: 'one' })).rejects.toMatchObject({
      code: 'DISCONNECTED',
    });
    const first = handle.connect();
    expect(handle.connect()).toBe(first);
    await first;
    expect(factories).toBe(1);
    expect(credentials).toBe(1);
    expect(handle.getSnapshot()).toMatchObject({ state: 'ready', attempt: 1, protocolVersion: 2 });
    expect(Object.isFrozen(handle.getSnapshot())).toBe(true);
    expect(JSON.stringify(handle.getSnapshot())).not.toContain('fake-token');
    await expect(handle.client.lookup({ id: 'one' })).resolves.toEqual({
      id: 'one',
      owner: 'principal',
    });
  });

  it('preserves typed application failures and tolerates failing state observers', async () => {
    const server = fixture();
    const handle = connection(server.sockets.client);
    handle.subscribe(() => {
      throw new Error('fake-secret');
    });
    handle.subscribe(async () => {
      throw new Error('fake-secret');
    });
    await handle.connect();
    await expect(handle.client.lookup({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { id: 'missing' },
      defined: true,
    });
    await expect(handle.client.lookup({ id: 'missing' })).rejects.not.toBeInstanceOf(RpcError);
    expect(handle.getSnapshot().state).toBe('ready');
  });

  it('avoids stale and duplicate transitions after reentrant close', async () => {
    const fake = new FakeSocket();
    const handle = connection(fake.socket);
    const seen: string[] = [];
    handle.subscribe((snapshot) => {
      if (snapshot.state === 'connecting') {
        void handle.close();
      }
    });
    handle.subscribe((snapshot) => {
      seen.push(snapshot.state);
    });
    await expect(handle.connect()).rejects.toMatchObject({ code: 'CLOSED' });
    expect(seen).toEqual(['closed']);
    expect(handle.getSnapshot().state).toBe('closed');
  });

  it('aborts a stalled handshake with a bounded timeout and no retained listeners', async () => {
    vi.useFakeTimers();
    const fake = new FakeSocket();
    const handle = connection(fake.socket, { handshakeTimeoutMs: 10 });
    const rejected = expect(handle.connect()).rejects.toMatchObject({ code: 'HANDSHAKE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(handle.getSnapshot()).toMatchObject({
      state: 'error',
      lastErrorCode: 'HANDSHAKE_TIMEOUT',
    });
    expect(fake.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never opens a socket from late credentials after close', async () => {
    const credentials = Promise.withResolvers<string>();
    const fake = new FakeSocket();
    let factories = 0;
    const handle = connection(fake.socket, {
      getToken: () => credentials.promise,
      createWebSocket: () => {
        factories += 1;
        return fake.socket;
      },
    });
    const pending = handle.connect();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CLOSED' });
    await Promise.resolve();
    await handle.close();
    await rejected;
    credentials.resolve('fake-token');
    await Promise.resolve();
    expect(factories).toBe(0);
    await expect(handle.connect()).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('closes a socket returned by a factory that reenters close before returning', async () => {
    const fake = new FakeSocket();
    let handle: ReturnType<typeof connection> | undefined;
    handle = connection(fake.socket, {
      createWebSocket: () => {
        void handle?.close();
        return fake.socket;
      },
    });
    await expect(handle.connect()).rejects.toMatchObject({ code: 'CLOSED' });
    expect(fake.socket.readyState).toBe(2);
    expect(fake.listenerCount).toBe(0);
  });

  it('makes credential-provider failure terminal without retaining its cause', async () => {
    const fake = new FakeSocket();
    let reads = 0;
    const handle = connection(fake.socket, {
      getToken: async () => {
        reads += 1;
        throw new Error('fake-secret');
      },
    });
    await expect(handle.connect()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(handle.connect()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(reads).toBe(1);
    expect(JSON.stringify(handle.getSnapshot())).not.toContain('fake-secret');
  });

  it('checks the absolute handshake deadline before opening a socket', async () => {
    let now = 0;
    let factories = 0;
    const fake = new FakeSocket();
    const handle = createUnaryConnection<AppClient>(
      {
        url: 'ws://127.0.0.1:3000/rpc',
        protocolVersions: [1],
        handshakeTimeoutMs: 10,
        getToken: async () => {
          now = 11;
          return 'fake-token';
        },
        createWebSocket: () => {
          factories += 1;
          return fake.socket;
        },
      },
      { now: () => now, schedule: () => () => {} },
    );
    cleanup.push(() => {
      void handle.close();
    });
    await expect(handle.connect()).rejects.toMatchObject({ code: 'HANDSHAKE_TIMEOUT' });
    expect(factories).toBe(0);
  });

  it('rejects a mismatched server reply without entering ready', async () => {
    const server = fixture({
      helloReply: {
        transportVersion: 1,
        protocolVersion: 9,
        sessionId: 'fake-session',
      },
    });
    const handle = connection(server.sockets.client);
    await expect(handle.connect()).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });
    expect(handle.getSnapshot().state).toBe('error');
  });

  it('treats a server authentication rejection as terminal', async () => {
    const server = fixture({
      authenticate: async () => {
        throw new Error('fake-secret');
      },
    });
    const handle = connection(server.sockets.client);
    await expect(handle.connect()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    await expect(handle.connect()).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(handle.getSnapshot()).toMatchObject({ state: 'error', lastErrorCode: 'AUTH_FAILED' });
    expect(JSON.stringify(handle.getSnapshot())).not.toContain('fake-secret');
  });

  it('enforces the client call limit and releases capacity after caller cancellation', async () => {
    const server = fixture();
    const handle = connection(server.sockets.client, { maxInFlightCalls: 1 });
    await handle.connect();
    const caller = new AbortController();
    const pending = handle.client.wait(undefined, { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await server.started;
    await expect(handle.client.lookup({ id: 'one' })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    caller.abort();
    await rejected;
    await expect(handle.client.lookup({ id: 'one' })).resolves.toEqual({
      id: 'one',
      owner: 'principal',
    });
  });

  it('cancels a timed-out app call and releases its deadline timers', async () => {
    vi.useFakeTimers();
    const server = fixture();
    const handle = connection(server.sockets.client, { callTimeoutMs: 10 });
    await handle.connect();
    const pending = handle.client.wait();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    const signal = await server.started;
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports uncertain mutation outcome and never replays after losing the response', async () => {
    const server = fixture();
    let factories = 0;
    const handle = connection(server.sockets.client, {
      reconnect: false,
      createWebSocket: () => {
        factories += 1;
        return server.sockets.client;
      },
    });
    await handle.connect();
    await expect(handle.client.mutate()).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await expect(handle.client.mutate()).rejects.toMatchObject({ code: 'DISCONNECTED' });
    expect(server.mutationCount()).toBe(1);
    expect(factories).toBe(1);
  });

  it('uses fresh credentials on a new attempt and ignores old-socket events', async () => {
    const first = fixture();
    const second = fixture();
    let factories = 0;
    let credentials = 0;
    const handle = connection(first.sockets.client, {
      reconnect: false,
      getToken: async () => {
        credentials += 1;
        return 'fake-token';
      },
      createWebSocket: () => (++factories === 1 ? first.sockets.client : second.sockets.client),
    });
    await handle.connect();
    await expect(handle.client.mutate()).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await handle.connect();
    first.sockets.clientSocket.receive('fake-secret-invalid-old-frame');
    await expect(handle.client.lookup({ id: 'one' })).resolves.toEqual({
      id: 'one',
      owner: 'principal',
    });
    expect(handle.getSnapshot()).toMatchObject({ state: 'ready', attempt: 2 });
    expect(credentials).toBe(2);
    expect(first.mutationCount()).toBe(1);
  });
});
