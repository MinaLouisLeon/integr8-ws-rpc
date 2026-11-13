// @vitest-environment jsdom
import { act, createElement, type ReactElement, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { connectionFixture, mountHook } from '../core/testing/reactHarness.js';
import { useRpcSnapshot } from './useRpcSnapshot.js';

function SnapshotProbe({
  connection,
  observed,
}: {
  connection: Parameters<typeof useRpcSnapshot>[0];
  observed: string[];
}): ReactElement {
  const state = useRpcSnapshot(connection);
  observed.push(state.state);
  return createElement('p', null, state.state);
}

describe('useRpcSnapshot', () => {
  it('borrows one subscription under StrictMode and switches handles without closing them', async () => {
    const first = connectionFixture();
    const second = connectionFixture();
    let selected = first.connection;
    const view = await mountHook(() => useRpcSnapshot(selected));
    try {
      expect(first.listeners.size).toBe(1);
      expect(view.read()).toBe(first.connection.getSnapshot());
      await act(async () => {
        first.ready();
      });
      expect(view.read().state).toBe('ready');
      selected = second.connection;
      await view.render();
      expect(first.listeners.size).toBe(0);
      expect(second.listeners.size).toBe(1);
      expect(view.read().state).toBe('idle');
    } finally {
      await view.close();
    }
    expect(second.listeners.size).toBe(0);
    expect(first.closed()).toBe(false);
    expect(second.closed()).toBe(false);
  });

  it('renders the stable idle server snapshot then hydrates to the existing live state', async () => {
    const fixture = connectionFixture();
    fixture.ready();
    const observed: string[] = [];
    const probe = createElement(SnapshotProbe, { connection: fixture.connection, observed });
    const html = renderToString(probe);
    expect(html).toBe('<p>idle</p>');
    expect(fixture.listeners.size).toBe(0);
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.append(host);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(host, createElement(StrictMode, null, probe));
      });
      expect(host.textContent).toBe('ready');
      expect(observed).toContain('idle');
      expect(fixture.listeners.size).toBe(1);
    } finally {
      await act(async () => {
        root?.unmount();
      });
      host.remove();
    }
    expect(fixture.listeners.size).toBe(0);
  });
});
