import {
  chunkBinary,
  createRpcClient,
  createRpcClientGroup,
  createRpcOfflineQueue,
} from '@integr8-media/ws-rpc/client';
import { createRpcDeliveryLedger } from '@integr8-media/ws-rpc/server';
import type { Client, InferClientErrors } from '@orpc/client';
import type { ExampleClient } from './router.ts';

/** Compile-only assertions against installed package exports, never source aliases. */
export async function assertTypes(options: Parameters<typeof createRpcClient>[0]): Promise<void> {
  const connection = createRpcClient<ExampleClient>(options);
  const contextual = createRpcClient<{
    run: Client<{ tenant: string }, { priority: number }, { count: number }, unknown>;
  }>(options);
  const group = createRpcClientGroup({ example: connection, jobs: contextual });
  const queue = createRpcOfflineQueue({
    connection: contextual,
    maxEntries: 2,
    maxBytes: 1024,
    maxEntryBytes: 64,
    maxAgeMs: 1000,
    attemptTimeoutMs: 1000,
    encode: (priority: number): Uint8Array => new Uint8Array([priority]),
    decode: (bytes: Uint8Array): number => bytes[0] ?? 0,
    decodeResult: (bytes: Uint8Array): number => bytes[0] ?? 0,
    deliver: async (client, command, signal, priority) => {
      const reply = await client.run({ priority }, { context: { tenant: 'example' }, signal });
      // @ts-expect-error Queue callbacks must retain required per-call context.
      void client.run({ priority });
      // @ts-expect-error Queue callbacks must retain the client's exact procedure names.
      void client.lookup({ id: 'wrong-router' });
      return {
        key: command.key,
        expiresAt: command.expiresAt,
        state: 'completed',
        result: new Uint8Array([reply.count]),
      };
    },
    reconcile: async (_client, key) => ({ key, state: 'missing' }),
  });
  const queued = queue.enqueue(1, { key: 'typecheck' });
  const queuedResult: number = await queued.result;
  // @ts-expect-error Queue inputs retain the application codec input type.
  queue.enqueue('wrong', { key: 'wrong' });
  // @ts-expect-error Queue result is typed, not unknown or any.
  const wrongQueued: string = await queued.result;
  // @ts-expect-error Queue snapshot entries are readonly.
  queue.getSnapshot().tickets[0].state = 'queued';
  const ledger = createRpcDeliveryLedger({
    maxEntries: 2,
    maxBytes: 1024,
    maxEntryBytes: 64,
    retentionMs: 2000,
    maxCommandAgeMs: 1000,
    encodeResult: (value: number): Uint8Array => new Uint8Array([value]),
    decodeResult: (bytes: Uint8Array): number => bytes[0] ?? 0,
  });
  const envelope = { key: 'typed', expiresAt: Date.now() + 1000, payload: new Uint8Array([1]) };
  // @ts-expect-error Ledger application result type must match its codec.
  void ledger.execute('scope', envelope, () => 'wrong');
  void [queuedResult, wrongQueued];
  const job = await group.clients.jobs.client.run(
    { priority: 2 },
    { context: { tenant: 'example' } },
  );
  const count: number = job.count;
  // @ts-expect-error A sibling router must not widen to the other's procedure names.
  void group.clients.example.client.run({ priority: 2 });
  // @ts-expect-error Per-call context is still required through the group.
  void group.clients.jobs.client.run({ priority: 2 });
  // @ts-expect-error Names are not arbitrary runtime strings.
  void group.connect('missing');
  for await (const chunk of chunkBinary(new Uint8Array([1]), { maxBytes: 1 })) {
    const byte: number | undefined = chunk[0];
    void byte;
  }
  const result = await connection.client.lookup({ id: 'typed' });
  const owner: string = result.owner;
  // @ts-expect-error Input inference must survive declaration packaging.
  void connection.client.lookup({ id: 123 });
  // @ts-expect-error Output inference must survive declaration packaging.
  const wrongOwner: number = result.owner;
  // @ts-expect-error Unknown procedures must not become callable.
  void connection.client.missing();
  connection.subscribeStream((client, signal) => client.events({ count: 2 }, { signal }), {
    next: (item) => {
      const sequence: number = item.sequence;
      // @ts-expect-error Stream items must retain their original fields.
      const wrong: string = item.sequence;
      void [sequence, wrong];
    },
    error: () => {},
    complete: () => {},
  });
  void [owner, wrongOwner, count];
}

export function assertTypedError(
  error: Extract<InferClientErrors<ExampleClient>['lookup'], { code: 'NOT_FOUND' }>,
): string {
  // @ts-expect-error Typed error data must retain its string input.
  const wrong: number = error.data.id;
  void wrong;
  return error.data.id;
}
