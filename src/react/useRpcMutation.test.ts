// @vitest-environment jsdom
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcError } from '../core/rpcError.js';
import { connectionFixture, mountHook } from '../core/testing/reactHarness.js';
import { useRpcMutation } from './useRpcMutation.js';

afterEach(() => onlineManager.setOnline(true));

describe('useRpcMutation', () => {
  it('rejects offline explicit calls without pausing and never retries an uncertain mutation', async () => {
    const fixture = connectionFixture();
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: true, networkMode: 'online' } },
    });
    let calls = 0;
    const failure = new RpcError('OUTCOME_UNKNOWN');
    const view = await mountHook(
      () =>
        useRpcMutation({
          connection: fixture.connection,
          cacheScope: 'account',
          mutationKey: ['write'],
          mutation: async (_client, value: number) => {
            calls += value;
            throw failure;
          },
        }),
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    try {
      expect(calls).toBe(0);
      onlineManager.setOnline(false);
      await act(async () => {
        await expect(view.read().mutateAsync(1)).rejects.toMatchObject({ code: 'DISCONNECTED' });
      });
      expect(view.read().isPaused).toBe(false);
      expect(calls).toBe(0);
      await act(async () => {
        fixture.ready();
        await expect(view.read().mutateAsync(1)).rejects.toBe(failure);
      });
      expect(calls).toBe(1);
      await act(async () => {
        onlineManager.setOnline(true);
      });
      await view.render();
      expect(calls).toBe(1);
    } finally {
      await view.close();
      client.clear();
    }
  });

  it('does not expose old-handle mutation data during a replacement render', async () => {
    const first = connectionFixture();
    const second = connectionFixture();
    first.ready();
    second.ready();
    let selected = first.connection;
    const client = new QueryClient();
    const seen: unknown[] = [];
    const view = await mountHook(
      () => {
        const result = useRpcMutation({
          connection: selected,
          cacheScope: 'account',
          mutationKey: ['write'],
          mutation: async (_client, value: number) => value,
        });
        seen.push(result.data);
        return result;
      },
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    try {
      await act(async () => {
        expect(await view.read().mutateAsync(3)).toBe(3);
      });
      expect(view.read().data).toBe(3);
      seen.length = 0;
      selected = second.connection;
      await view.render();
      expect(seen).not.toContain(3);
      expect(view.read().isIdle).toBe(true);
    } finally {
      await view.close();
      client.clear();
    }
  });

  it('leaves running work and cancellation ownership with the caller after unmount', async () => {
    const fixture = connectionFixture();
    fixture.ready();
    const client = new QueryClient();
    const controller = new AbortController();
    let finish: (value: number) => void = () => {};
    const view = await mountHook(
      () =>
        useRpcMutation({
          connection: fixture.connection,
          cacheScope: 'account',
          mutationKey: ['write'],
          mutation: (_client, variables: { signal: AbortSignal }) => {
            expect(variables.signal).toBe(controller.signal);
            return new Promise<number>((resolve) => {
              finish = resolve;
            });
          },
        }),
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    let task: Promise<number> | undefined;
    await act(async () => {
      task = view.read().mutateAsync({ signal: controller.signal });
    });
    await view.close();
    expect(controller.signal.aborted).toBe(false);
    expect(fixture.closed()).toBe(false);
    finish(4);
    expect(await task).toBe(4);
    client.clear();
  });

  it('does not inherit a global mutation-scope queue for concurrent explicit calls', async () => {
    const fixture = connectionFixture();
    fixture.ready();
    const client = new QueryClient({ defaultOptions: { mutations: { scope: { id: 'serial' } } } });
    const started: number[] = [];
    const finish: Array<() => void> = [];
    const view = await mountHook(
      () =>
        useRpcMutation({
          connection: fixture.connection,
          cacheScope: 'account',
          mutationKey: ['write'],
          mutation: (_client, value: number) => {
            started.push(value);
            return new Promise<number>((resolve) => {
              finish.push(() => resolve(value));
            });
          },
        }),
      (child) => createElement(QueryClientProvider, { client }, child),
    );
    const tasks: Promise<number>[] = [];
    try {
      await act(async () => {
        tasks.push(view.read().mutateAsync(1), view.read().mutateAsync(2));
      });
      expect(started).toEqual([1, 2]);
      await act(async () => {
        for (const resolve of finish) resolve();
        await Promise.all(tasks);
      });
      expect(await Promise.all(tasks)).toEqual([1, 2]);
    } finally {
      await view.close();
      client.clear();
    }
  });
});
