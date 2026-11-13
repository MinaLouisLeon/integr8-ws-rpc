import { createORPCClient } from '@orpc/client';
import { StandardRPCLink } from '@orpc/client/standard';
import { os, type RouterClient } from '@orpc/server';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod';
import { createPeerClient } from '../client/peerClient.js';
import { createSocketPair } from '../core/testing/socketPair.js';
import { createRpcServer } from './createRpcServer.js';
import { getServerBinding } from './serverBinding.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) {
    await dispose();
  }
});

function application() {
  let invoked = 0;
  const base = os.$context<{ principal: string }>();
  const router = {
    lookup: base
      .input(z.object({ id: z.string() }))
      .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
      .handler(({ input, context, errors }) => {
        invoked += 1;
        if (input.id === 'missing') {
          throw errors.NOT_FOUND({ data: { id: input.id } });
        }
        return { id: input.id, owner: context.principal };
      }),
  };
  return { router, count: (): number => invoked };
}

describe('createRpcServer', () => {
  it('guards a caller router with required context and preserves its typed errors', async () => {
    const app = application();
    const server = createRpcServer({
      router: app.router,
      protocolVersions: [1, 2],
      authenticate: async ({ token }) => {
        if (token !== 'fake-token') {
          throw new Error('fake-secret');
        }
        return { context: { principal: 'caller' } };
      },
    });
    cleanup.push(() => server.close());
    const sockets = createSocketPair();
    const attachment = getServerBinding(server).attach(sockets.server);
    const peer = createPeerClient(sockets.client);
    cleanup.push(
      () => attachment.dispose(),
      () => peer.dispose(),
      () => sockets.close(),
    );
    type Client = RouterClient<typeof app.router> & {
      __integr8Transport: { hello(input: unknown): Promise<{ sessionId: string }> };
    };
    const client = createORPCClient<Client>(
      new StandardRPCLink(peer.sender, { url: 'http://orpc' }),
    );
    await expect(client.lookup({ id: 'one' })).rejects.toThrow();
    expect(app.count()).toBe(0);
    const hello = await client.__integr8Transport.hello({
      transportVersion: 1,
      protocolVersions: [1, 2],
      token: 'fake-token',
    });
    await expect(client.lookup({ id: 'one' })).resolves.toEqual({ id: 'one', owner: 'caller' });
    await expect(client.lookup({ id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      data: { id: 'missing' },
      defined: true,
    });
    await server.disconnectSession(hello.sessionId, 'AUTH_FAILED');
    expect(sockets.clientSocket.socket.readyState).toBe(3);
  });

  it('rejects the reserved namespace without creating a socket or authentication timer', () => {
    expect(() =>
      createRpcServer({
        router: { __integr8Transport: { hello: os.handler(() => 'collision') } },
        protocolVersions: [1],
        authenticate: async () => ({ context: {} }),
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }));
  });

  it('rejects new attachments after an idempotent server close', async () => {
    const app = application();
    const server = createRpcServer({
      router: app.router,
      protocolVersions: [1],
      authenticate: async ({ token }) => ({ context: { principal: token } }),
    });
    cleanup.push(() => server.close());
    const closing = server.close();
    expect(server.close()).toBe(closing);
    await closing;
    const sockets = createSocketPair();
    cleanup.push(() => sockets.close());
    expect(() => getServerBinding(server).attach(sockets.server)).toThrow(
      expect.objectContaining({ code: 'CLOSED' }),
    );
  });
});
