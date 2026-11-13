import { hashKey, type QueryKey, type UseQueryResult, useQuery } from '@tanstack/react-query';
import {
  assertReady,
  effectiveKey,
  type QueryConnection,
  validateCacheDuration,
} from './queryIdentity.js';

/** @inline */
interface RpcQueryOptions<TClient extends object, TResult> {
  readonly connection: QueryConnection<TClient>;
  readonly cacheScope: string;
  readonly queryKey: QueryKey;
  readonly query: (client: TClient, signal: AbortSignal) => PromiseLike<TResult>;
  readonly staleTime?: number;
  readonly gcTime?: number;
}

/**
 * Cache a manually requested typed read. Call refetch explicitly: render, remount, reconnect,
 * invalidation and focus never initiate work. Original errors stay unknown for honest narrowing.
 * The caller owns QueryClientProvider, connection lifecycle and non-secret cache scope/input keys.
 * @inlineType RpcQueryOptions
 * @inlineType QueryConnection
 */
export function useRpcQuery<TClient extends object, TResult>(
  source: RpcQueryOptions<TClient, TResult>,
): UseQueryResult<TResult, unknown> {
  const { connection, query } = source;
  const queryKey = effectiveKey(connection, source.cacheScope, source.queryKey);
  const staleTime = validateCacheDuration(source.staleTime);
  const gcTime = validateCacheDuration(source.gcTime);
  // Use a typed variable so internal runtime safeguards (e.g. suspense) may be supplied even
  // where upstream intentionally omits them from useQuery's public option type.
  const options = {
    queryKey,
    queryHash: hashKey(queryKey),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<TResult> => {
      assertReady(connection);
      return query(connection.client, signal);
    },
    ...(staleTime === undefined ? {} : { staleTime }),
    ...(gcTime === undefined ? {} : { gcTime }),
    enabled: false as const,
    retry: false as const,
    retryOnMount: false,
    refetchOnMount: false as const,
    refetchOnReconnect: false as const,
    refetchOnWindowFocus: false as const,
    refetchInterval: false as const,
    networkMode: 'always' as const,
    queryKeyHashFn: hashKey,
    initialData: () => undefined,
    placeholderData: () => undefined,
    suspense: false,
    experimental_prefetchInRender: false,
    throwOnError: false as const,
  };
  return useQuery<TResult, unknown>(options);
}
