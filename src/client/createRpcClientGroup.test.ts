import { describe, expect, it } from 'vitest';
import type { ConnectionSnapshot } from '../core/connectionTypes.js';
import { RpcError } from '../core/rpcError.js';
import { createRpcClientGroup } from './createRpcClientGroup.js';

function member() {
  let state: ConnectionSnapshot = { state: 'idle', attempt: 0 };
  const observers = new Set<(value: ConnectionSnapshot) => void>();
  let connects = 0;
  let closes = 0;
  let pending: Promise<void> | undefined;
  function emit(value: ConnectionSnapshot): void {
    state = value;
    for (const observer of [...observers]) observer(value);
  }
  const handle = {
    client: { value: async (): Promise<string> => 'value' },
    connect: (): Promise<void> => {
      if (pending) return pending;
      connects += 1;
      pending = Promise.resolve().then(() =>
        emit({
          state: 'ready',
          attempt: connects,
          protocolVersion: 1,
          sessionId: `session-${connects}`,
        }),
      );
      return pending;
    },
    close: async (): Promise<void> => {
      closes += 1;
      emit({ state: 'closed', attempt: connects });
    },
    getSnapshot: (): ConnectionSnapshot => state,
    subscribe: (observer: (value: ConnectionSnapshot) => void): (() => void) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
  return { handle, emit, observers, connects: () => connects, closes: () => closes };
}

describe('createRpcClientGroup', () => {
  it('is lazy, preserves the original typed handles and freezes projected snapshots', async () => {
    const first = member();
    const second = member();
    const input = { first: first.handle, second: second.handle };
    const group = createRpcClientGroup(input);
    expect(group.clients).not.toBe(input);
    expect(group.clients.first).toBe(first.handle);
    expect(first.connects()).toBe(0);
    expect(Object.isFrozen(group.clients)).toBe(true);
    expect(Object.isFrozen(group.getSnapshot().first)).toBe(true);
    const pending = group.connect('first');
    expect(group.connect('first')).toBe(pending);
    await pending;
    expect(group.getSnapshot().second.state).toBe('idle');
    await group.close();
    expect(first.observers.size).toBe(0);
    expect(second.observers.size).toBe(0);
  });

  it('rejects invalid keys, aliases and accessors before installing listeners', () => {
    const first = member();
    for (const input of [
      {},
      { 'bad.name': first.handle },
      { one: first.handle, two: first.handle },
    ]) {
      expect(() => createRpcClientGroup(input)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTION' }),
      );
    }
    const getter = Object.defineProperty({}, 'first', {
      enumerable: true,
      get: () => {
        throw new Error('Must not read configuration getter.');
      },
    });
    expect(() => createRpcClientGroup(getter)).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTION' }),
    );
    expect(first.observers.size).toBe(0);
    const tooMany = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`member${index}`, member().handle]),
    );
    expect(() => createRpcClientGroup(tooMany)).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTION' }),
    );
  });

  it('projects only safe fields and isolates both throwing and rejecting observers', async () => {
    const child = member();
    const group = createRpcClientGroup({ child: child.handle });
    const seen: string[] = [];
    group.subscribe(() => {
      throw new Error('observer');
    });
    group.subscribe(async () => {
      throw new Error('async observer');
    });
    group.subscribe((snapshot) => {
      seen.push(snapshot.child.state);
    });
    child.emit(
      Object.assign({ state: 'connecting' as const, attempt: 1 }, { token: 'fake-secret' }),
    );
    expect(seen).toEqual(['connecting']);
    expect(JSON.stringify(group.getSnapshot())).not.toContain('fake-secret');
    await group.close();
  });

  it('copies the same snapshot field values it validated, without rereading accessors', async () => {
    const child = member();
    const original = child.handle.getSnapshot;
    let first = true;
    let reads = 0;
    child.handle.getSnapshot = () => {
      if (!first) return original();
      first = false;
      return Object.defineProperty({ state: 'idle' as const, attempt: 0 }, 'attempt', {
        get: () => {
          reads += 1;
          return reads === 1 ? 0 : 'fake-secret';
        },
      });
    };
    const group = createRpcClientGroup({ child: child.handle });
    expect(reads).toBe(1);
    expect(group.getSnapshot().child).toEqual({ state: 'idle', attempt: 0 });
    await group.close();
  });

  it('settles every connect without leaking raw errors or rolling back healthy siblings', async () => {
    const healthy = member();
    const broken = member();
    broken.handle.connect = async () => {
      throw new Error('fake-secret');
    };
    const group = createRpcClientGroup({ healthy: healthy.handle, broken: broken.handle });
    const report = await group.connectAll();
    expect(report).toEqual({
      healthy: { status: 'fulfilled' },
      broken: { status: 'rejected', code: 'INTERNAL' },
    });
    expect(Object.isFrozen(report.broken)).toBe(true);
    expect(healthy.closes()).toBe(0);
    expect(JSON.stringify(report)).not.toContain('fake-secret');
    await group.close();
  });

  it('sanitizes an asynchronous child connect failure as well as all-settled reports', async () => {
    const child = member();
    child.handle.connect = async () => {
      throw new Error('fake-secret');
    };
    const group = createRpcClientGroup({ child: child.handle });
    await expect(group.connect('child')).rejects.toMatchObject({ code: 'INTERNAL' });
    await group.close();
  });

  it('closes one child idempotently, leaving its sibling available', async () => {
    const first = member();
    const second = member();
    const group = createRpcClientGroup({ first: first.handle, second: second.handle });
    await group.connectAll();
    await Promise.all([group.close('first'), group.close('first')]);
    expect(first.closes()).toBe(1);
    expect(second.closes()).toBe(0);
    expect(group.getSnapshot().first.state).toBe('closed');
    await expect(group.connect('first')).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(group.clients.second.client.value()).resolves.toBe('value');
    await group.close();
    expect(first.closes()).toBe(1);
    expect(second.closes()).toBe(1);
  });

  it('commits whole-group close before observers and ignores retained late callbacks', async () => {
    const first = member();
    const second = member();
    const group = createRpcClientGroup({ first: first.handle, second: second.handle });
    const late = [...first.observers][0];
    let calls = 0;
    group.subscribe(() => {
      calls += 1;
      void group.close();
      throw new Error('observer');
    });
    await group.connect('first');
    await group.close();
    const final = group.getSnapshot();
    const before = calls;
    late?.({ state: 'ready', attempt: 999, sessionId: 'stale', protocolVersion: 1 });
    expect(group.getSnapshot()).toBe(final);
    expect(calls).toBe(before);
    await expect(group.connect('second')).rejects.toMatchObject({ code: 'CLOSED' });
    await expect(group.connectAll()).rejects.toMatchObject({ code: 'CLOSED' });
  });

  it('attempts every cleanup even if one child fails, returning a safe error', async () => {
    const first = member();
    const second = member();
    first.handle.close = async () => {
      throw new Error('fake-secret');
    };
    const group = createRpcClientGroup({ first: first.handle, second: second.handle });
    const closing = group.close();
    expect(group.close()).toBe(closing);
    await expect(closing).rejects.toBeInstanceOf(RpcError);
    expect(second.closes()).toBe(1);
    expect(first.observers.size).toBe(0);
    expect(second.observers.size).toBe(0);
  });

  it('starts closing all children synchronously before returning the shared cleanup promise', async () => {
    const first = member();
    const second = member();
    const group = createRpcClientGroup({ first: first.handle, second: second.handle });
    const closing = group.close();
    expect(first.closes()).toBe(1);
    expect(second.closes()).toBe(1);
    await closing;
  });
});
