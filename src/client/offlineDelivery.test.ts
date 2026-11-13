import { os, type RouterClient } from '@orpc/server';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { DeliveryReceipt } from '../core/delivery.js';
import { registerRpcWebSocket } from '../fastify/index.js';
import { createRpcDeliveryLedger, createRpcServer } from '../server/index.js';
import { createRpcClient, createRpcOfflineQueue } from './index.js';

describe('explicit offline delivery through real Fastify/oRPC sockets', () => {
  it('reconciles a lost response under authenticated scope without executing the mutation again', async () => {
    const ledger = createRpcDeliveryLedger({
      maxEntries: 8,
      maxBytes: 8192,
      maxEntryBytes: 64,
      maxCommandAgeMs: 10_000,
      retentionMs: 20_000,
      encodeResult: (value: number) => new Uint8Array([value]),
      decodeResult: (bytes) => bytes[0] ?? 0,
    });
    const base = os.$context<{ principal: string }>();
    const input = z.object({
      key: z.string(),
      expiresAt: z.number(),
      payload: z.array(z.number().int().min(0).max(255)).max(64),
    });
    let mutations = 0;
    let dropReply = async (): Promise<void> => {};
    const pack = (receipt: DeliveryReceipt) =>
      receipt.state === 'completed' ? { ...receipt, result: Array.from(receipt.result) } : receipt;
    const router = {
      command: base.input(input).handler(async ({ input: command, context }) => {
        const receipt = await ledger.execute(
          `${context.principal}/increment`,
          {
            ...command,
            payload: new Uint8Array(command.payload),
          },
          async () => {
            mutations += 1;
            return mutations;
          },
        );
        // Invalidate the actual socket after commit and before the procedure returns its result.
        await dropReply();
        return pack(receipt);
      }),
      status: base
        .input(z.object({ key: z.string() }))
        .handler(({ input: query, context }) =>
          pack(ledger.lookup(`${context.principal}/increment`, query.key)),
        ),
    };
    const app = Fastify({ logger: false });
    const server = createRpcServer({
      router,
      protocolVersions: [1],
      authenticate: async ({ token }) => ({
        context: { principal: token === 'fake-a' ? 'a' : 'b' },
      }),
    });
    const adapter = registerRpcWebSocket(app, server, {
      originPolicy: (origin) => origin === undefined,
    });
    let connection: ReturnType<typeof createRpcClient<RouterClient<typeof router>>> | undefined;
    let other: ReturnType<typeof createRpcClient<RouterClient<typeof router>>> | undefined;
    let cleanupQueue: (() => Promise<void>) | undefined;
    try {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback listener.');
      const options = {
        url: `ws://127.0.0.1:${address.port}/rpc`,
        protocolVersions: [1],
        getToken: async () => 'fake-a',
        createWebSocket: (url: string) => new WebSocket(url),
        reconnect: false,
      };
      const active = createRpcClient<RouterClient<typeof router>>(options);
      connection = active;
      let deliveries = 0;
      let responseLost = (): void => {};
      const lost = new Promise<void>((resolve) => {
        responseLost = resolve;
      });
      let seenReady = false;
      active.subscribe((snapshot) => {
        if (snapshot.state === 'ready') seenReady = true;
        else if (seenReady) responseLost();
      });
      dropReply = async (): Promise<void> => {
        const session = active.getSnapshot().sessionId;
        if (!session) throw new Error('Missing authenticated session.');
        await server.disconnectSession(session, 'DISCONNECTED');
      };
      const unpack = (
        receipt: Awaited<ReturnType<typeof active.client.status>>,
      ): DeliveryReceipt =>
        receipt.state === 'completed'
          ? { ...receipt, result: new Uint8Array(receipt.result) }
          : receipt;
      const queue = createRpcOfflineQueue({
        connection: active,
        maxEntries: 4,
        maxBytes: 4096,
        maxEntryBytes: 64,
        maxAgeMs: 8000,
        attemptTimeoutMs: 1000,
        encode: (value: number) => new Uint8Array([value]),
        decode: (bytes) => bytes[0] ?? 0,
        decodeResult: (bytes) => bytes[0] ?? 0,
        deliver: async (client, command, signal) => {
          deliveries += 1;
          return unpack(
            await client.command({ ...command, payload: Array.from(command.payload) }, { signal }),
          );
        },
        reconcile: async (client, key, signal) => unpack(await client.status({ key }, { signal })),
      });
      cleanupQueue = () => queue.close();
      const ticket = queue.enqueue(1, { key: 'logical-one' });
      expect(queue.getSnapshot().queued).toBe(1);
      await active.connect();
      await lost;
      await active.connect();
      expect(await ticket.result).toBe(1);
      expect(deliveries).toBe(1);
      expect(mutations).toBe(1);
      other = createRpcClient<RouterClient<typeof router>>({
        ...options,
        getToken: async () => 'fake-b',
      });
      await other.connect();
      expect(await other.client.status({ key: 'logical-one' })).toEqual({
        key: 'logical-one',
        state: 'missing',
      });
    } finally {
      await cleanupQueue?.();
      await connection?.close();
      await other?.close();
      await adapter.dispose();
      await server.close();
      await ledger.close();
      await app.close();
    }
  });
});
