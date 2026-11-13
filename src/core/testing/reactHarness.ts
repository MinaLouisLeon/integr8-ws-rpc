import { act, createElement, type ReactElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConnectionSnapshot } from '../connectionTypes.js';

function HookProbe<T>({ callback, publish }: { callback: () => T; publish(value: T): void }): null {
  publish(callback());
  return null;
}

/** Real React harness, excluded from production/packed graphs. */
export async function mountHook<T>(
  hook: () => T,
  wrap: (child: ReactElement) => ReactElement = (child) => child,
): Promise<Readonly<{ read(): T; render(): Promise<void>; close(): Promise<void> }>> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let current: { value: T } | undefined;
  const render = async (): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          wrap(
            createElement(HookProbe<T>, {
              callback: hook,
              publish: (value: T): void => {
                current = { value };
              },
            }),
          ),
        ),
      );
    });
  };
  await render();
  return {
    read: (): T => {
      if (!current) throw new Error('Hook has not rendered.');
      return current.value;
    },
    render,
    close: async (): Promise<void> => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

/** Complete borrowed lifecycle surface; no socket/automatic callback is hidden by this fixture. */
export function connectionFixture(): Readonly<{
  connection: {
    readonly client: { read(input: { id: string }): Promise<{ id: string }> };
    getSnapshot(): ConnectionSnapshot;
    subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
    close(): Promise<void>;
  };
  listeners: Set<(snapshot: ConnectionSnapshot) => void>;
  publish(snapshot: ConnectionSnapshot): void;
  ready(sessionId?: string): void;
  closed(): boolean;
}> {
  let snapshot: ConnectionSnapshot = Object.freeze({ state: 'idle', attempt: 0 });
  const listeners = new Set<(value: ConnectionSnapshot) => void>();
  const publish = (next: ConnectionSnapshot): void => {
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener(snapshot);
  };
  return {
    connection: {
      client: { read: async (input) => input },
      getSnapshot: (): ConnectionSnapshot => snapshot,
      subscribe: (listener): (() => void) => {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
      close: async (): Promise<void> => publish({ state: 'closed', attempt: snapshot.attempt }),
    },
    listeners,
    publish,
    ready: (sessionId = 'fake-session'): void =>
      publish({ state: 'ready', attempt: 1, sessionId, protocolVersion: 1 }),
    closed: (): boolean => snapshot.state === 'closed',
  };
}
