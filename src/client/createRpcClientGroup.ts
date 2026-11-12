import type { ConnectionSnapshot } from '../core/connectionTypes.js';
import { isRpcErrorCode, RpcError, type RpcErrorCode } from '../core/rpcError.js';
import { projectSnapshot } from './groupSnapshot.js';

/** @inline */
interface GroupMember {
  readonly client: object;
  connect(): Promise<void>;
  close(): Promise<void>;
  getSnapshot(): ConnectionSnapshot;
  subscribe(listener: (snapshot: ConnectionSnapshot) => void): () => void;
}
type Registry = Record<string, GroupMember>;
type Names<T> = Extract<keyof T, string>;
type Snapshots<T> = Readonly<{ [K in keyof T]: ConnectionSnapshot }>;
type ConnectionResult = Readonly<
  { status: 'fulfilled' } | { status: 'rejected'; code: RpcErrorCode }
>;
type Results<T> = Readonly<{ [K in keyof T]: ConnectionResult }>;

/**
 * Static lifecycle owner; original client types and per-call context remain intact.
 * @inline
 */
export interface RpcClientGroup<T extends Registry> {
  readonly clients: Readonly<T>;
  connect(name: Names<T>): Promise<void>;
  connectAll(): Promise<Results<T>>;
  close(name?: Names<T>): Promise<void>;
  getSnapshot(): Snapshots<T>;
  subscribe(listener: (snapshot: Snapshots<T>) => void): () => void;
}

function isMember(value: unknown): value is GroupMember {
  return (
    typeof value === 'object' &&
    value !== null &&
    'client' in value &&
    ((typeof value.client === 'object' && value.client !== null) ||
      typeof value.client === 'function') &&
    'connect' in value &&
    typeof value.connect === 'function' &&
    'close' in value &&
    typeof value.close === 'function' &&
    'getSnapshot' in value &&
    typeof value.getSnapshot === 'function' &&
    'subscribe' in value &&
    typeof value.subscribe === 'function'
  );
}

function safeError(error: unknown): RpcError {
  return new RpcError(
    error instanceof RpcError && isRpcErrorCode(error.code) ? error.code : 'INTERNAL',
  );
}

function deferredCleanup(operation: () => Promise<void>): Readonly<{
  promise: Promise<void>;
  start(): void;
}> {
  let start = (): void => {};
  const promise = new Promise<void>((resolve, reject) => {
    start = (): void => {
      try {
        Promise.resolve(operation()).then(resolve, (error: unknown) => reject(safeError(error)));
      } catch (error) {
        reject(safeError(error));
      }
    };
  });
  return { promise, start };
}

function project<T extends Registry, U>(
  registry: Readonly<T>,
  value: (name: string) => U,
): Readonly<{ [K in keyof T]: U }> {
  // Only key correspondence is asserted: every validated own key is copied exactly once.
  // Original child/client/router values and their types are never cast or reconstructed.
  return Object.freeze(
    Object.fromEntries(Object.getOwnPropertyNames(registry).map((name) => [name, value(name)])),
  ) as Readonly<{ [K in keyof T]: U }>;
}

/**
 * Own 1..32 distinct existing typed clients under static names. Construction opens nothing.
 * Each child retains its own credentials/retry/streams; this group never reroutes or replays calls.
 * Whole-group close is terminal; close(name) closes only that child. Names are nonsecret identifiers.
 * @inlineType Registry
 * @inlineType ConnectionResult
 * @inlineType Snapshots
 */
export function createRpcClientGroup<T extends Registry>(clients: T): RpcClientGroup<T> {
  let registry: Readonly<T>;
  const members = new Map<string, GroupMember>();
  const states = new Map<string, ConnectionSnapshot>();
  try {
    if (
      typeof clients !== 'object' ||
      clients === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(clients))
    )
      throw new RpcError('INVALID_OPTION');
    const keys = Reflect.ownKeys(clients);
    if (keys.length < 1 || keys.length > 32) throw new RpcError('INVALID_OPTION');
    const descriptors = Object.getOwnPropertyDescriptors(clients);
    const seen = new Set<GroupMember>();
    for (const key of keys) {
      if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
        throw new RpcError('INVALID_OPTION');
      }
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor)) throw new RpcError('INVALID_OPTION');
      const candidate: unknown = descriptor.value;
      if (!isMember(candidate) || seen.has(candidate)) throw new RpcError('INVALID_OPTION');
      seen.add(candidate);
      members.set(key, candidate);
      states.set(key, projectSnapshot(candidate.getSnapshot()));
    }
    registry = Object.freeze(Object.defineProperties({ ...clients }, descriptors));
  } catch {
    throw new RpcError('INVALID_OPTION');
  }

  const listeners = new Set<(value: Snapshots<T>) => void>();
  const detach = new Set<() => void>();
  const childClosures = new Map<string, Promise<void>>();
  const connections = new Map<string, Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let snapshot = buildSnapshot();

  function buildSnapshot(): Snapshots<T> {
    return project(registry, (name) => {
      const value = states.get(name);
      if (!value) throw new RpcError('INTERNAL');
      return value;
    });
  }
  function publish(): void {
    snapshot = buildSnapshot();
    const committed = snapshot;
    const terminal = closed;
    for (const observer of [...listeners]) {
      if (snapshot !== committed || closed !== terminal) break;
      if (!listeners.has(observer)) continue;
      try {
        void Promise.resolve(observer(committed)).catch(() => {});
      } catch {
        /* observer isolation */
      }
    }
  }
  function update(name: string, value: unknown): void {
    if (closed) return;
    const next = projectSnapshot(value);
    const previous = states.get(name);
    if (previous?.state === 'closed' || (previous && next.attempt < previous.attempt)) return;
    states.set(name, next);
    publish();
  }
  try {
    for (const [name, member] of members) {
      const unsubscribe = member.subscribe((value) => {
        try {
          update(name, value);
        } catch {
          /* malformed foreign notifications cannot expose data */
        }
      });
      if (typeof unsubscribe !== 'function') throw new RpcError('INVALID_OPTION');
      detach.add(unsubscribe);
    }
  } catch {
    closed = true;
    for (const unsubscribe of detach) {
      try {
        void Promise.resolve(unsubscribe()).catch(() => {});
      } catch {
        /* release all listeners */
      }
    }
    detach.clear();
    throw new RpcError('INVALID_OPTION');
  }

  function connect(name: string): Promise<void> {
    if (closed) return Promise.reject(new RpcError('CLOSED'));
    const member = members.get(name);
    if (!member) return Promise.reject(new RpcError('INVALID_OPTION'));
    if (childClosures.has(name) || states.get(name)?.state === 'closed') {
      return Promise.reject(new RpcError('CLOSED'));
    }
    const existing = connections.get(name);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() => {
        if (closed || childClosures.has(name)) throw new RpcError('CLOSED');
        return member.connect();
      })
      .catch((error: unknown) => {
        throw safeError(error);
      });
    connections.set(name, pending);
    const clear = (): void => {
      if (connections.get(name) === pending) connections.delete(name);
    };
    void pending.then(clear, clear);
    return pending;
  }
  async function connectAll(): Promise<Results<T>> {
    if (closed) throw new RpcError('CLOSED');
    const results = new Map<string, ConnectionResult>();
    await Promise.all(
      [...members.keys()].map(async (name) => {
        try {
          await connect(name);
          results.set(name, Object.freeze({ status: 'fulfilled' }));
        } catch (error) {
          results.set(name, Object.freeze({ status: 'rejected', code: safeError(error).code }));
        }
      }),
    );
    return project(registry, (name) => {
      const result = results.get(name);
      if (!result) throw new RpcError('INTERNAL');
      return result;
    });
  }
  function closeChild(name: string): Promise<void> {
    const existing = childClosures.get(name);
    if (existing) return existing;
    const member = members.get(name);
    if (!member) return Promise.reject(new RpcError('INVALID_OPTION'));
    const task = deferredCleanup(async () => {
      await member.close();
      if (!closed) update(name, member.getSnapshot());
    });
    childClosures.set(name, task.promise);
    task.start();
    return task.promise;
  }
  function close(name?: Names<T>): Promise<void> {
    if (name !== undefined && !members.has(name))
      return Promise.reject(new RpcError('INVALID_OPTION'));
    if (closing) return closing;
    if (name !== undefined) return closeChild(name);
    closed = true;
    // Assign the shared promise before any child/observer callback can reenter close.
    const task = deferredCleanup(async () => {
      let failed = false;
      const unsubscribeWork: Promise<void>[] = [];
      for (const unsubscribe of detach) {
        try {
          unsubscribeWork.push(Promise.resolve(unsubscribe()));
        } catch {
          failed = true;
        }
      }
      detach.clear();
      const children = [...members.keys()].map(closeChild);
      const results = await Promise.allSettled([...unsubscribeWork, ...children]);
      if (results.some((result) => result.status === 'rejected')) failed = true;
      for (const [key, member] of members) {
        try {
          states.set(key, projectSnapshot(member.getSnapshot()));
        } catch {
          failed = true;
        }
      }
      try {
        publish();
      } finally {
        listeners.clear();
      }
      if (failed) throw new RpcError('INTERNAL');
    });
    closing = task.promise;
    task.start();
    return closing;
  }
  return Object.freeze({
    clients: registry,
    connect,
    connectAll,
    close,
    getSnapshot: (): Snapshots<T> => snapshot,
    subscribe: (observer: (value: Snapshots<T>) => void): (() => void) => {
      if (typeof observer !== 'function') throw new RpcError('INVALID_OPTION');
      if (!closed) listeners.add(observer);
      return (): void => {
        listeners.delete(observer);
      };
    },
  });
}
