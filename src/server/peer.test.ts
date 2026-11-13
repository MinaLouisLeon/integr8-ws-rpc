import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import { ORPCError, os, type RouterClient } from '@orpc/server';
import { RPCHandler } from '@orpc/server/websocket';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { RpcClientOptions } from '../core/connectionTypes.js';
import { FakeSocket } from '../core/testing/fakeSocket.js';
import { attachPeer, type PeerBinding } from './peer.js';
import { Session } from './session.js';

type Socket = ReturnType<RpcClientOptions['createWebSocket']>;
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
});

function pair(): { client: Socket; server: Socket; rawServer: FakeSocket } {
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
      close: (): void => {
        source.finishClose();
        target.finishClose();
      },
    };
  }
  left.open();
  right.open();
  cleanup.push(() => {
    left.finishClose();
    right.finishClose();
  });
  return { client: endpoint(left, right), server: endpoint(right, left), rawServer: right };
}

function application() {
  const base = os.$context<{ userId?: string }>();
  const guarded = base.use(({ context, next }) => {
    if (!context.userId) {
      throw new ORPCError('UNAUTHORIZED');
    }
    return next({ context: { userId: context.userId } });
  });
  let invocations = 0;
  const lookup = guarded
    .input(z.object({ id: z.string() }))
    .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
    .handler(({ input, context, errors }) => {
      invocations += 1;
      if (input.id === 'missing') {
        throw errors.NOT_FOUND({ data: { id: input.id } });
      }
      return { id: input.id, owner: context.userId };
    });
  return { lookup, count: (): number => invocations, base };
}

describe('manual upstream peer integration', () => {
  it('uses real oRPC hello/routing/typed errors with a guarded principal context', async () => {
    const sockets = pair();
    const app = application();
    let binding: PeerBinding | undefined;
    const session = new Session({
      protocolVersions: [1],
      authenticate: async () => ({ context: { userId: 'principal' } }),
      onClose: () => binding?.dispose(),
    });
    cleanup.push(() => session.close());
    const router = {
      lookup: app.lookup,
      __integr8Transport: {
        hello: app.base.input(z.unknown()).handler(({ input }) => session.hello(input)),
      },
    };
    const handler = new RPCHandler<{ userId?: string }>(router, {
      clientInterceptors: [
        ({ path, next, ...options }) => {
          if (path[0] === '__integr8Transport' && path[1] === 'hello') {
            return next({ ...options, path });
          }
          return session.runUnary(
            (context, signal) =>
              next({
                ...options,
                path,
                context,
                signal,
              }),
            options.signal,
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
    const client = createORPCClient<RouterClient<typeof router>>(
      new RPCLink({ websocket: sockets.client }),
    );
    await expect(client.lookup({ id: 'one' })).rejects.toThrow();
    expect(app.count()).toBe(0);
    await client.__integr8Transport.hello({
      transportVersion: 1,
      protocolVersions: [1],
      token: 'fake-token',
    });
    await expect(client.lookup({ id: 'one' })).resolves.toEqual({ id: 'one', owner: 'principal' });
    await expect(client.lookup({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { id: 'missing' },
    });
    binding.dispose();
    binding.dispose();
    expect(sockets.rawServer.listenerCount).toBe(0);
  });

  it('catches a malformed upstream frame and reports only a safe failure code', async () => {
    const sockets = pair();
    const codes: string[] = [];
    const handler = new RPCHandler({ ping: os.handler(() => 'pong') });
    const binding = attachPeer(
      handler,
      sockets.server,
      {},
      {
        onDisconnect: (code) => {
          codes.push(code);
        },
      },
    );
    cleanup.push(() => binding.dispose());
    sockets.client.send('fake-secret-not-valid-orpc');
    // Drain the input event and async upstream decoding/rejection path without starting a server.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(codes).toEqual(['INVALID_MESSAGE']);
    expect(sockets.rawServer.listenerCount).toBe(0);
    expect(sockets.server.readyState).toBe(3);
  });

  it('rejects an oversize frame before passing it to the upstream decoder', async () => {
    const sockets = pair();
    const codes: string[] = [];
    const handler = new RPCHandler({ ping: os.handler(() => 'pong') });
    const binding = attachPeer(
      handler,
      sockets.server,
      {},
      {
        maxMessageBytes: 4,
        onDisconnect: (code) => {
          codes.push(code);
        },
      },
    );
    cleanup.push(() => binding.dispose());
    sockets.rawServer.receive('12345');
    expect(codes).toEqual(['PAYLOAD_TOO_LARGE']);
    expect(sockets.rawServer.listenerCount).toBe(0);
  });
});
