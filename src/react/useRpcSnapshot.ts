import { useMemo, useSyncExternalStore } from 'react';
import type { ConnectionSnapshot } from '../core/connectionTypes.js';

/** Read-only lifecycle source; the caller retains connection ownership. @inline */
interface SnapshotSource {
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
}
const serverSnapshot: ConnectionSnapshot = Object.freeze({ state: 'idle', attempt: 0 });

/**
 * Observe a borrowed connection without connecting/closing it. SSR and initial hydration render
 * a stable idle snapshot; React reads the real cached snapshot after hydration. No provider needed.
 * @inlineType SnapshotSource
 */
export function useRpcSnapshot(connection: SnapshotSource): ConnectionSnapshot {
  const store = useMemo(
    () => ({
      read: (): ConnectionSnapshot => connection.getSnapshot(),
      subscribe: (notify: () => void): (() => void) => connection.subscribe(() => notify()),
    }),
    [connection],
  );
  return useSyncExternalStore(store.subscribe, store.read, () => serverSnapshot);
}
