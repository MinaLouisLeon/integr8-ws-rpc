import {
  hashKey,
  MutationObserver,
  type QueryKey,
  type UseMutationResult,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { assertReady, effectiveKey, type QueryConnection } from './queryIdentity.js';

/** @inline */
interface RpcMutationOptions<TClient extends object, TVariables, TResult> {
  readonly connection: QueryConnection<TClient>;
  readonly cacheScope: string;
  readonly mutationKey: QueryKey;
  readonly mutation: (client: TClient, variables: TVariables) => PromiseLike<TResult>;
}

/**
 * Execute explicit typed mutations without retries, offline pause or automatic invalidation.
 * Include an AbortSignal in application variables when needed; unmount never implies rollback.
 * Handle/key replacement observes a fresh mutation, leaving old work under its original key.
 * @inlineType RpcMutationOptions
 * @inlineType QueryConnection
 */
export function useRpcMutation<TClient extends object, TVariables, TResult>(
  source: RpcMutationOptions<TClient, TVariables, TResult>,
): UseMutationResult<TResult, unknown, TVariables> {
  const { connection, mutation, cacheScope, mutationKey: inputKey } = source;
  const client = useQueryClient();
  const mutationKey = useMemo(
    () => effectiveKey(connection, cacheScope, inputKey),
    [connection, cacheScope, inputKey],
  );
  const identity = hashKey(mutationKey);
  const options = useMemo(() => {
    const value = {
      mutationKey,
      mutationFn: async (variables: TVariables): Promise<TResult> => {
        assertReady(connection);
        return mutation(connection.client, variables);
      },
      retry: false as const,
      networkMode: 'always' as const,
      throwOnError: false as const,
    };
    // Override a global scope without asserting upstream exact-optional option types.
    Object.defineProperty(value, 'scope', { value: undefined, enumerable: true });
    return value;
  }, [connection, mutation, mutationKey]);
  // A new observer per effective key avoids one render of the previous handle's result while
  // useMutation's normal key-change reset effect is still pending. These are public Query APIs.
  const [binding, setBinding] = useState(() => ({
    client,
    identity,
    observer: new MutationObserver<TResult, unknown, TVariables>(client, options),
  }));
  let observer = binding.observer;
  if (binding.client !== client || binding.identity !== identity) {
    const next = {
      client,
      identity,
      observer: new MutationObserver<TResult, unknown, TVariables>(client, options),
    };
    setBinding(next);
    observer = next.observer;
  }
  useEffect(() => {
    observer.setOptions(options);
  }, [observer, options]);
  const subscribe = useCallback(
    (notify: () => void): (() => void) => observer.subscribe(notify),
    [observer],
  );
  const read = useCallback(() => observer.getCurrentResult(), [observer]);
  const result = useSyncExternalStore(subscribe, read, read);
  const mutateAsync = useCallback<UseMutationResult<TResult, unknown, TVariables>['mutateAsync']>(
    (...args) => {
      // Match upstream useMutation's conditional argument bridge: omission is allowed only
      // when TVariables admits it. The observer itself still declares a required argument.
      return observer.mutate(args[0] as TVariables, args[1]);
    },
    [observer],
  );
  const mutate = useCallback<UseMutationResult<TResult, unknown, TVariables>['mutate']>(
    (...args) => {
      void mutateAsync(...args).catch(() => {});
    },
    [mutateAsync],
  );
  return { ...result, mutate, mutateAsync };
}
