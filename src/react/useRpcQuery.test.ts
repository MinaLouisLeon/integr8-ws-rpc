// @vitest-environment jsdom
import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcError } from '../core/rpcError.js';
import { connectionFixture, mountHook } from '../core/testing/reactHarness.js';
import { useRpcQuery } from './useRpcQuery.js';

afterEach(() => {
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});

describe('useRpcQuery', () => {
  it('never issues automatic reads despite retries, invalidation, focus, online or ready changes', async () => {
    const fixture = connectionFixture();
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: true,
          refetchOnMount: 'always',
          refetchOnWindowFocus: 'always',
          refetchOnReconnect: 'always',
          refetchInterval: 1,
        },
      },
    });
    let calls = 0;
    const view = await mountHook(
      () =>
        useRpcQuery({
          connection: fixture.connection,
          cacheScope: 'account',
          queryKey: ['read'],
          query: async () => {
            calls += 1;
            return 7;
          },
        }),
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    try {
      await act(async () => {
        fixture.ready();
        await client.invalidateQueries();
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      expect(calls).toBe(0);
      await act(async () => {
        await view.read().refetch();
      });
      await view.render();
      expect(view.read().data).toBe(7);
      expect(calls).toBe(1);
      await view.render();
      await act(async () => {
        await client.invalidateQueries();
      });
      expect(calls).toBe(1);
    } finally {
      await view.close();
      client.clear();
    }
  });

  it('fails fast offline and preserves an uncertain error without retry', async () => {
    const fixture = connectionFixture();
    const client = new QueryClient({ defaultOptions: { queries: { retry: true } } });
    const failure = new RpcError('OUTCOME_UNKNOWN');
    let calls = 0;
    const view = await mountHook(
      () =>
        useRpcQuery({
          connection: fixture.connection,
          cacheScope: 'account',
          queryKey: ['read'],
          query: async () => {
            calls += 1;
            throw failure;
          },
        }),
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    try {
      onlineManager.setOnline(false);
      let offlineCode: unknown;
      await act(async () => {
        offlineCode = (await view.read().refetch()).error;
      });
      expect(offlineCode).toMatchObject({ code: 'DISCONNECTED' });
      expect(calls).toBe(0);
      await act(async () => {
        fixture.ready();
        await view.read().refetch();
      });
      await view.render();
      expect(view.read().error).toBe(failure);
      expect(calls).toBe(1);
      await act(async () => {
        fixture.publish({ state: 'reconnecting', attempt: 2 });
        fixture.ready('new');
      });
      expect(calls).toBe(1);
    } finally {
      await view.close();
      client.clear();
    }
  });

  it('isolates replacement handles even with a colliding global hash and previous-data default', async () => {
    const first = connectionFixture();
    const second = connectionFixture();
    first.ready();
    second.ready();
    let selected = first.connection;
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          queryKeyHashFn: () => 'collision',
          queryHash: 'global-collision',
          placeholderData: (previous: unknown) => previous,
          initialData: 'must not leak',
        },
      },
    });
    const seen: unknown[] = [];
    const view = await mountHook(
      () => {
        const result = useRpcQuery({
          connection: selected,
          cacheScope: 'same',
          queryKey: ['read'],
          query: async () => (selected === first.connection ? 'first' : 'second'),
        });
        seen.push(result.data);
        return result;
      },
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    try {
      expect(view.read().data).toBeUndefined();
      await act(async () => {
        await view.read().refetch();
      });
      await view.render();
      expect(view.read().data).toBe('first');
      selected = second.connection;
      seen.length = 0;
      await view.render();
      expect(seen).not.toContain('first');
      expect(view.read().data).toBeUndefined();
      await act(async () => {
        await view.read().refetch();
      });
      await view.render();
      expect(view.read().data).toBe('second');
      expect(client.getQueryCache().getAll()).toHaveLength(2);
    } finally {
      await view.close();
      client.clear();
    }
  });

  it('forwards Query cancellation to the application call without closing its connection', async () => {
    const fixture = connectionFixture();
    fixture.ready();
    const client = new QueryClient();
    let signal: AbortSignal | undefined;
    const view = await mountHook(
      () =>
        useRpcQuery({
          connection: fixture.connection,
          cacheScope: 'account',
          queryKey: ['read'],
          query: (_client, received) => {
            signal = received;
            return new Promise<number>(() => {});
          },
        }),
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    try {
      let task: ReturnType<ReturnType<typeof view.read>['refetch']> | undefined;
      await act(async () => {
        task = view.read().refetch();
      });
      expect(signal?.aborted).toBe(false);
      await act(async () => {
        await client.cancelQueries();
      });
      await task;
      expect(signal?.aborted).toBe(true);
      expect(fixture.closed()).toBe(false);
    } finally {
      await view.close();
      client.clear();
    }
  });

  it('unmount/remount does not retry an existing uncertain result', async () => {
    const fixture = connectionFixture();
    fixture.ready();
    const client = new QueryClient();
    let calls = 0;
    const hook = () =>
      useRpcQuery({
        connection: fixture.connection,
        cacheScope: 'account',
        queryKey: ['read'],
        query: async () => {
          calls += 1;
          throw new RpcError('OUTCOME_UNKNOWN');
        },
      });
    const wrap = (child: ReactElement) => createElement(QueryClientProvider, { client }, child);
    const first = await mountHook(hook, wrap);
    await act(async () => {
      await first.read().refetch();
    });
    await first.close();
    const second = await mountHook(hook, wrap);
    try {
      expect(calls).toBe(1);
    } finally {
      await second.close();
      client.clear();
    }
  });
});
