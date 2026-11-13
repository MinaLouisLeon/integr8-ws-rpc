import { createRpcClient } from '@integr8-media/ws-rpc/client';
import { useRpcMutation, useRpcQuery, useRpcSnapshot } from '@integr8-media/ws-rpc/react';
import type { Client } from '@orpc/client';

/** Compile-only hook probe against actual public declarations; never called by a runtime script. */
export function useAssertReactTypes(options: Parameters<typeof createRpcClient>[0]): void {
  const connection = createRpcClient<{
    lookup: Client<{ tenant: string }, { id: string }, { count: number }, unknown>;
  }>(options);
  const snapshot = useRpcSnapshot(connection);
  const read = useRpcQuery({
    connection,
    cacheScope: 'account',
    queryKey: ['lookup', 'one'],
    query: async (client, signal) => {
      // @ts-expect-error Required upstream caller context cannot be omitted through the hook.
      void client.lookup({ id: 'one' });
      // @ts-expect-error Procedure inputs retain their original types.
      void client.lookup({ id: 1 }, { context: { tenant: 'a' } });
      return client.lookup({ id: 'one' }, { context: { tenant: 'a' }, signal });
    },
  });
  const count: number | undefined = read.data?.count;
  // @ts-expect-error Output fields must not widen to any/unknown.
  const wrongCount: string | undefined = read.data?.count;
  const write = useRpcMutation({
    connection,
    cacheScope: 'account',
    mutationKey: ['write'],
    mutation: (client, variables: { id: string; signal?: AbortSignal }) =>
      client.lookup(
        { id: variables.id },
        { context: { tenant: 'a' }, ...(variables.signal ? { signal: variables.signal } : {}) },
      ),
  });
  void write.mutateAsync({ id: 'one' }).then((value) => {
    const output: number = value.count;
    // @ts-expect-error Mutation outputs preserve the application type.
    const wrong: string = value.count;
    void [output, wrong];
  });
  // @ts-expect-error Mutation variables preserve required application fields.
  write.mutate({ missing: true });
  // @ts-expect-error A mutation with required variables must not admit an omitted argument.
  write.mutate();
  const noInput = useRpcMutation<typeof connection.client, void, { done: boolean }>({
    connection,
    cacheScope: 'account',
    mutationKey: ['noInput'],
    mutation: async () => ({ done: true }),
  });
  noInput.mutate();
  void noInput.mutateAsync().then((value) => {
    const done: boolean = value.done;
    void done;
  });
  // @ts-expect-error Unknown failures must be narrowed before reading application details.
  void read.error.code;
  useRpcQuery({
    connection,
    cacheScope: 'account',
    queryKey: ['read'],
    query: async () => 1,
    // @ts-expect-error Manual policy cannot be replaced with an automatic enabled option.
    enabled: true,
  });
  void [snapshot, count, wrongCount];
}
