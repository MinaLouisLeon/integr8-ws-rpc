import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionSnapshot } from '../core/connectionTypes.js';
import type { DeliveryCommand, DeliveryReceipt } from '../core/delivery.js';
import { RpcError } from '../core/rpcError.js';
import { createRpcOfflineQueue } from './createRpcOfflineQueue.js';

function connectionFixture() {
  let snapshot: ConnectionSnapshot = { state: 'idle', attempt: 0 };
  const observers = new Set<(value: ConnectionSnapshot) => void>();
  const connection = {
    client: { operation: async (value: number): Promise<number> => value + 1 },
    getSnapshot: (): ConnectionSnapshot => snapshot,
    subscribe: (observer: (value: ConnectionSnapshot) => void): (() => void) => {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
  };
  return {
    connection,
    observers,
    publish(value: ConnectionSnapshot): void {
      snapshot = value;
      for (const observer of [...observers]) observer(value);
    },
    ready(sessionId = 'one'): void {
      this.publish({ state: 'ready', attempt: 1, sessionId, protocolVersion: 1 });
    },
  };
}
const budgets = {
  maxEntries: 3,
  maxBytes: 1024,
  maxEntryBytes: 16,
  maxAgeMs: 100,
  attemptTimeoutMs: 50,
};
const codec = {
  encode: (value: number): Uint8Array => new Uint8Array([value]),
  decode: (bytes: Uint8Array): number => bytes[0] ?? 0,
  decodeResult: (bytes: Uint8Array): number => bytes[0] ?? 0,
};
function completed(command: DeliveryCommand, value: number): DeliveryReceipt {
  return {
    key: command.key,
    expiresAt: command.expiresAt,
    state: 'completed',
    result: new Uint8Array([value]),
  };
}
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('createRpcOfflineQueue', () => {
  it('queues explicitly while offline, preserves client inference and dispatches FIFO after ready', async () => {
    const fixture = connectionFixture();
    const order: string[] = [];
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: async (client, command, _signal, input) => {
        order.push(command.key);
        return completed(command, await client.operation(input));
      },
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const first = queue.enqueue(3, { key: 'first' });
    const second = queue.enqueue(5, { key: 'second' });
    expect(order).toEqual([]);
    expect(queue.getSnapshot()).toMatchObject({ queued: 2, retainedBytes: 45 });
    fixture.ready();
    expect(await first.result).toBe(4);
    expect(await second.result).toBe(6);
    expect(order).toEqual(['first', 'second']);
    await queue.close();
    expect(fixture.observers.size).toBe(0);
  });

  it('enforces admission count/bytes synchronously and releases cancelled capacity', async () => {
    const fixture = connectionFixture();
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      maxEntries: 1,
      maxBytes: 18,
      connection: fixture.connection,
      deliver: async (_client, command) => completed(command, 1),
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const ticket = queue.enqueue(1, { key: 'k' });
    const cancelled = expect(ticket.result).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(() => queue.enqueue(2, { key: 'j' })).toThrowError();
    ticket.cancel();
    await cancelled;
    expect(queue.getSnapshot().retainedBytes).toBe(0);
    await queue.close();
  });

  it('retains unknown outcomes and reconciles on a new epoch without re-delivery', async () => {
    const fixture = connectionFixture();
    let delivered = 0;
    let lookups = 0;
    let saved: DeliveryCommand | undefined;
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: async (_client, command) => {
        delivered += 1;
        saved = command;
        throw new RpcError('OUTCOME_UNKNOWN');
      },
      reconcile: async (_client, key) => {
        lookups += 1;
        if (lookups === 1) return { key, state: 'missing' };
        if (!saved) throw new Error('No command.');
        return completed(saved, 9);
      },
    });
    const ticket = queue.enqueue(1, { key: 'one' });
    fixture.ready();
    await flush();
    expect(queue.getSnapshot().uncertain).toBe(1);
    fixture.publish({ state: 'reconnecting', attempt: 2 });
    fixture.ready('two');
    await flush();
    expect(lookups).toBe(1);
    expect(delivered).toBe(1);
    await queue.reconcile('one');
    expect(await ticket.result).toBe(9);
    expect(delivered).toBe(1);
    await queue.close();
  });

  it('expires unsent work as TIMEOUT and invoked work as OUTCOME_UNKNOWN', async () => {
    vi.useFakeTimers();
    const fixture = connectionFixture();
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: () => new Promise<DeliveryReceipt>(() => {}),
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const unsent = queue.enqueue(1, { key: 'unsent' });
    const unsentResult = expect(unsent.result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100);
    await unsentResult;
    const sent = queue.enqueue(1, { key: 'sent' });
    const sentResult = expect(sent.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    fixture.ready();
    await vi.advanceTimersByTimeAsync(100);
    await sentResult;
    await queue.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes locally without waiting on callbacks and ignores their late results', async () => {
    const fixture = connectionFixture();
    let finish: (receipt: DeliveryReceipt) => void = () => {};
    let saved: DeliveryCommand | undefined;
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: (_client, command) => {
        saved = command;
        return new Promise<DeliveryReceipt>((resolve) => {
          finish = resolve;
        });
      },
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const sent = queue.enqueue(1, { key: 'sent' });
    const result = expect(sent.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    fixture.ready();
    await flush();
    const closing = queue.close();
    expect(queue.close()).toBe(closing);
    await closing;
    await result;
    if (!saved) throw new Error('Not dispatched.');
    finish(completed(saved, 99));
    await flush();
    expect(queue.getSnapshot()).toMatchObject({ closed: true, retainedBytes: 0, tickets: [] });
    expect(() => queue.enqueue(1, { key: 'new' })).toThrowError();
  });

  it('does not dispatch cancelled work when observers reenter admission', async () => {
    const fixture = connectionFixture();
    const controller = new AbortController();
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: async (_client, command) => completed(command, 1),
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    queue.subscribe(() => controller.abort());
    const ticket = queue.enqueue(1, { key: 'one', signal: controller.signal });
    await expect(ticket.result).rejects.toMatchObject({ code: 'CANCELLED' });
    fixture.ready();
    await flush();
    expect(queue.getSnapshot().queued).toBe(0);
    await queue.close();
  });

  it('retains an immutable encoded snapshot and rejects oversized or duplicate admission', async () => {
    const fixture = connectionFixture();
    const source = new Uint8Array([7]);
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      encode: (value: Uint8Array) => value,
      decode: (value) => value,
      deliver: async (_client, command, _signal, input) => {
        input[0] = 99;
        return completed(command, command.payload[0] ?? 0);
      },
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const ticket = queue.enqueue(source, { key: 'one' });
    source[0] = 8;
    expect(() => queue.enqueue(source, { key: 'one' })).toThrowError();
    expect(() => queue.enqueue(new Uint8Array(17), { key: 'large' })).toThrowError();
    fixture.ready();
    expect(await ticket.result).toBe(7);
    await queue.close();
  });

  it('rejects malformed matching receipts and preserves application errors without replay', async () => {
    const fixture = connectionFixture();
    const applicationError = new Error('application');
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: async (_client, command) => {
        if (command.key === 'application') throw applicationError;
        return completed({ ...command, key: 'wrong' }, 9);
      },
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const malformed = queue.enqueue(1, { key: 'malformed' });
    const app = queue.enqueue(1, { key: 'application' });
    const invalid = expect(malformed.result).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    const rejected = expect(app.result).rejects.toBe(applicationError);
    fixture.ready();
    await Promise.all([invalid, rejected]);
    expect(queue.getSnapshot().tickets).toEqual([]);
    await queue.close();
  });

  it('terminates unsent work on auth failure and cleans up on borrowed-connection closure', async () => {
    const fixture = connectionFixture();
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: async (_client, command) => completed(command, 1),
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const ticket = queue.enqueue(1, { key: 'one' });
    const rejected = expect(ticket.result).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    fixture.publish({ state: 'error', attempt: 1, lastErrorCode: 'AUTH_FAILED' });
    await rejected;
    expect(() => queue.enqueue(1, { key: 'new' })).toThrowError();
    fixture.publish({ state: 'closed', attempt: 1 });
    expect(queue.getSnapshot().closed).toBe(true);
    expect(fixture.observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overlap callbacks when an aborted attempt ignores its signal', async () => {
    const fixture = connectionFixture();
    let finish: (receipt: DeliveryReceipt) => void = () => {};
    let first: DeliveryCommand | undefined;
    const observed: string[] = [];
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      maxAgeMs: 1000,
      connection: fixture.connection,
      deliver: (_client, command) => {
        observed.push(command.key);
        if (command.key !== 'one') return completed(command, 2);
        first = command;
        return new Promise<DeliveryReceipt>((resolve) => {
          finish = resolve;
        });
      },
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const one = queue.enqueue(1, { key: 'one' });
    const two = queue.enqueue(2, { key: 'two' });
    fixture.ready();
    await vi.advanceTimersByTimeAsync(50);
    expect(observed).toEqual(['one']);
    one.cancel();
    await expect(one.result).rejects.toMatchObject({ code: 'CANCELLED' });
    if (!first) throw new Error('Missing first command.');
    finish(completed(first, 99));
    expect(await two.result).toBe(2);
    expect(observed).toEqual(['one', 'two']);
    await queue.close();
  });

  it('shares explicit status lookups and never resends after a pending acknowledgement', async () => {
    const fixture = connectionFixture();
    let finish: (receipt: DeliveryReceipt) => void = () => {};
    let saved: DeliveryCommand | undefined;
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      deliver: (_client, command) => {
        saved = command;
        return { key: command.key, expiresAt: command.expiresAt, state: 'pending' };
      },
      reconcile: () =>
        new Promise<DeliveryReceipt>((resolve) => {
          finish = resolve;
        }),
    });
    const ticket = queue.enqueue(1, { key: 'one' });
    fixture.ready();
    await flush();
    const lookup = queue.reconcile('one');
    await flush();
    expect(queue.reconcile('one')).toBe(lookup);
    if (!saved) throw new Error('Missing command.');
    finish(completed(saved, 8));
    await lookup;
    expect(await ticket.result).toBe(8);
    await queue.close();
  });

  it('checks capacity again after a reentrant codec and isolates snapshot observers', async () => {
    const fixture = connectionFixture();
    let reentered = false;
    const queue: ReturnType<
      typeof createRpcOfflineQueue<typeof fixture.connection.client, number, number>
    > = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      maxEntries: 1,
      connection: fixture.connection,
      encode: (value: number) => {
        if (!reentered) {
          reentered = true;
          const inner = queue.enqueue(2, { key: 'inner' });
          void inner.result.catch(() => {});
        }
        return new Uint8Array([value]);
      },
      deliver: async (_client, command) => completed(command, 1),
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    queue.subscribe(() => {
      throw new Error('observer');
    });
    expect(() => queue.enqueue(1, { key: 'outer' })).toThrowError();
    expect(queue.getSnapshot().tickets.map((ticket) => ticket.key)).toEqual(['inner']);
    expect(Object.isFrozen(queue.getSnapshot().tickets)).toBe(true);
    expect(JSON.stringify(queue.getSnapshot())).not.toContain('payload');
    await queue.close();
  });

  it('does not acknowledge success after a blocking codec crosses the absolute expiry', async () => {
    const fixture = connectionFixture();
    const queue = createRpcOfflineQueue({
      ...budgets,
      ...codec,
      connection: fixture.connection,
      decodeResult: (bytes) => {
        vi.setSystemTime(1100);
        return bytes[0] ?? 0;
      },
      deliver: async (_client, command) => completed(command, 1),
      reconcile: async (_client, key) => ({ key, state: 'missing' }),
    });
    const ticket = queue.enqueue(1, { key: 'one' });
    const result = expect(ticket.result).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    fixture.ready();
    await result;
    await queue.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('normalizes option getter failures before installing connection observers', () => {
    const fixture = connectionFixture();
    try {
      createRpcOfflineQueue({
        ...budgets,
        ...codec,
        connection: fixture.connection,
        get maxAgeMs(): number {
          throw new Error('private configuration');
        },
        deliver: async (_client, command) => completed(command, 1),
        reconcile: async (_client, key) => ({ key, state: 'missing' }),
      });
      throw new Error('Expected invalid options.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_OPTION' });
      expect(error).not.toHaveProperty('cause');
    }
    expect(fixture.observers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
