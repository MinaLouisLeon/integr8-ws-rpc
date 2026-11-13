import { createORPCClient } from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import { os, type RouterClient } from '@orpc/server';
import { RPCHandler } from '@orpc/server/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { FakeSocket } from '../core/testing/fakeSocket.js';
import { createSocketPair } from '../core/testing/socketPair.js';
import { attachPeer } from '../server/peer.js';
import { chunkBinary } from './chunkBinary.js';
import { createPeerClient } from './peerClient.js';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
});

describe('owned client peer', () => {
  it('preserves typed nested calls and application errors through oRPC', async () => {
    const sockets = createSocketPair();
    const router = {
      nested: {
        lookup: os
          .input(z.object({ id: z.string() }))
          .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
          .handler(({ input, errors }) => {
            if (input.id === 'missing') {
              throw errors.NOT_FOUND({ data: { id: input.id } });
            }
            return { id: input.id, value: 42 };
          }),
      },
    };
    const server = attachPeer(new RPCHandler(router), sockets.server, {});
    const peer = createPeerClient(sockets.client);
    cleanup.push(
      () => peer.dispose(),
      () => server.dispose(),
      () => sockets.close(),
    );
    const client = createORPCClient<RouterClient<typeof router>>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    await expect(client.nested.lookup({ id: 'one' })).resolves.toEqual({ id: 'one', value: 42 });
    await expect(client.nested.lookup({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { id: 'missing' },
      defined: true,
    });
  });

  it('rejects a call on a connecting socket without queuing or sending it later', async () => {
    const fake = new FakeSocket();
    const peer = createPeerClient(fake.socket);
    cleanup.push(() => peer.dispose());
    const client = createORPCClient<{ ping: () => Promise<string> }>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    await expect(client.ping()).rejects.toMatchObject({ code: 'DISCONNECTED' });
    fake.open();
    expect(fake.sent).toEqual([]);
  });

  it('catches malformed incoming frames and releases pending requests and listeners', async () => {
    const fake = new FakeSocket();
    fake.open();
    const codes: string[] = [];
    const peer = createPeerClient(fake.socket, {
      onDisconnect: (code) => {
        codes.push(code);
      },
    });
    cleanup.push(() => peer.dispose());
    const client = createORPCClient<{ ping: () => Promise<string> }>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const call = client.ping();
    const rejected = expect(call).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    fake.receive('fake-secret-invalid-orpc');
    await rejected;
    expect(codes).toEqual(['INVALID_MESSAGE']);
    expect(fake.listenerCount).toBe(0);
  });

  it('enforces outgoing byte capacity before a platform send', async () => {
    const fake = new FakeSocket();
    fake.open();
    const peer = createPeerClient(fake.socket, { maxBufferedBytes: 1 });
    cleanup.push(() => peer.dispose());
    const client = createORPCClient<{ ping: () => Promise<string> }>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    await expect(client.ping()).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    expect(fake.sent).toEqual([]);
    expect(fake.listenerCount).toBe(0);
  });

  it('sanitizes arbitrary remote close reasons', () => {
    const fake = new FakeSocket();
    fake.open();
    const codes: string[] = [];
    const peer = createPeerClient(fake.socket, {
      onDisconnect: (code) => {
        codes.push(code);
      },
    });
    cleanup.push(() => peer.dispose());
    fake.finishClose(1000, 'fake-secret');
    expect(codes).toEqual(['DISCONNECTED']);
    expect(fake.listenerCount).toBe(0);
  });

  it('closes a pending request idempotently and never replays it', async () => {
    const fake = new FakeSocket();
    fake.open();
    const peer = createPeerClient(fake.socket);
    cleanup.push(() => peer.dispose());
    const client = createORPCClient<{ ping: () => Promise<string> }>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const call = client.ping();
    const rejected = expect(call).rejects.toMatchObject({ code: 'CLOSED' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const sentBeforeClose = fake.sent.length;
    peer.dispose();
    peer.dispose();
    await rejected;
    expect(fake.listenerCount).toBe(0);
    expect(fake.sent.length).toBe(sentBeforeClose);
  });

  it('propagates caller cancellation to the actual upstream server signal', async () => {
    const sockets = createSocketPair();
    const started = Promise.withResolvers<AbortSignal>();
    const router = {
      wait: os.handler(async ({ signal }): Promise<void> => {
        if (!signal) {
          throw new Error('The upstream request signal is missing.');
        }
        started.resolve(signal);
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      }),
    };
    const server = attachPeer(new RPCHandler(router), sockets.server, {});
    const peer = createPeerClient(sockets.client);
    cleanup.push(
      () => peer.dispose(),
      () => server.dispose(),
      () => sockets.close(),
    );
    const client = createORPCClient<RouterClient<typeof router>>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const caller = new AbortController();
    const pending = client.wait(undefined, { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    const serverSignal = await started.promise;
    caller.abort('fake-secret');
    await rejected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(serverSignal.aborted).toBe(true);
  });

  it('fails only a slow stream at its upstream item bound while unary calls remain usable', async () => {
    const sockets = createSocketPair();
    const router = {
      stream: os.handler(async function* () {
        for (let sequence = 0; sequence < 20; sequence += 1) yield { sequence };
      }),
      ping: os.handler(() => 'pong'),
    };
    const server = attachPeer(new RPCHandler(router), sockets.server, {});
    const peer = createPeerClient(sockets.client, { maxPendingStreamItems: 2 });
    cleanup.push(
      () => peer.dispose(),
      () => server.dispose(),
      () => sockets.close(),
    );
    const client = createORPCClient<RouterClient<typeof router>>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const stream = await client.stream();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(stream.next()).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    await expect(client.ping()).resolves.toBe('pong');
  });

  it('enforces stream byte capacity independently of item count', async () => {
    const sockets = createSocketPair();
    const router = {
      stream: os.handler(async function* () {
        yield 'payload';
      }),
    };
    const server = attachPeer(new RPCHandler(router), sockets.server, {});
    const peer = createPeerClient(sockets.client, { maxPendingStreamBytes: 1 });
    cleanup.push(
      () => peer.dispose(),
      () => server.dispose(),
      () => sockets.close(),
    );
    const client = createORPCClient<RouterClient<typeof router>>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const stream = await client.stream();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(stream.next()).rejects.toMatchObject({ code: 'BACKPRESSURE' });
  });

  it('preserves binary response bodies through the local codec bookkeeping', async () => {
    const sockets = createSocketPair();
    const router = { binary: os.handler(() => new Blob([new Uint8Array([0, 255, 17])])) };
    const server = attachPeer(new RPCHandler(router), sockets.server, {});
    const peer = createPeerClient(sockets.client);
    cleanup.push(
      () => peer.dispose(),
      () => server.dispose(),
      () => sockets.close(),
    );
    const client = createORPCClient<RouterClient<typeof router>>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const result = await client.binary();
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(new Uint8Array([0, 255, 17]));
  });

  it('still enforces encoded frame limits when a raw helper chunk fits its own budget', async () => {
    const sockets = createSocketPair();
    let calls = 0;
    const router = {
      binary: os.input(z.instanceof(Blob)).handler(({ input }) => {
        calls += 1;
        return input.size;
      }),
    };
    const server = attachPeer(new RPCHandler(router), sockets.server, {});
    const peer = createPeerClient(sockets.client, { maxMessageBytes: 64 });
    cleanup.push(
      () => peer.dispose(),
      () => server.dispose(),
      () => sockets.close(),
    );
    const client = createORPCClient<RouterClient<typeof router>>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const chunks = chunkBinary(new Uint8Array(32), { maxBytes: 32, chunkBytes: 32 });
    const item = await chunks.next();
    if (!item.value) throw new Error('Expected one raw chunk.');
    expect(item.value.byteLength).toBe(32);
    await expect(
      client.binary(new Blob([new Uint8Array(item.value).buffer])),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(calls).toBe(0);
    await chunks.return?.();
  });

  it('retains caller abort after returning an iterator instead of releasing it at response headers', async () => {
    const sockets = createSocketPair();
    const router = {
      stream: os.handler(async function* ({ signal }) {
        yield 1;
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      }),
    };
    const server = attachPeer(new RPCHandler(router), sockets.server, {});
    const peer = createPeerClient(sockets.client);
    cleanup.push(
      () => peer.dispose(),
      () => server.dispose(),
      () => sockets.close(),
    );
    const client = createORPCClient<RouterClient<typeof router>>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    const caller = new AbortController();
    const stream = await client.stream(undefined, { signal: caller.signal });
    await stream.next();
    const pending = stream.next();
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    caller.abort();
    await rejected;
  });
});
