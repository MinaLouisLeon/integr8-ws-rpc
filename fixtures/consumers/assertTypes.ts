import { chunkBinary, createRpcClient, createRpcClientGroup } from '@integr8-media/ws-rpc/client';
import type { Client, InferClientErrors } from '@orpc/client';
import type { ExampleClient } from './router.ts';

/** Compile-only assertions against installed package exports, never source aliases. */
export async function assertTypes(options: Parameters<typeof createRpcClient>[0]): Promise<void> {
  const connection = createRpcClient<ExampleClient>(options);
  const contextual = createRpcClient<{
    run: Client<{ tenant: string }, { priority: number }, { count: number }, unknown>;
  }>(options);
  const group = createRpcClientGroup({ example: connection, jobs: contextual });
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
