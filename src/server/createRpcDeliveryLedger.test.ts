import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RpcError } from '../core/rpcError.js';
import { createRpcDeliveryLedger } from './createRpcDeliveryLedger.js';

const options = {
  maxEntries: 2,
  maxBytes: 1024,
  maxEntryBytes: 16,
  retentionMs: 100,
  maxCommandAgeMs: 50,
  encodeResult: (value: number): Uint8Array => new Uint8Array([value]),
  decodeResult: (bytes: Uint8Array): number => bytes[0] ?? 0,
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('createRpcDeliveryLedger', () => {
  it('reserves a scoped key before running and joins concurrent identical commands', async () => {
    const ledger = createRpcDeliveryLedger(options);
    const command = { key: 'one', expiresAt: Date.now() + 40, payload: new Uint8Array([4]) };
    let finish: (value: number) => void = () => {};
    let executions = 0;
    const first = ledger.execute('user/op', command, async (payload) => {
      executions += 1;
      expect([...payload]).toEqual([4]);
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    });
    const duplicate = ledger.execute('user/op', command, async () => {
      throw new Error('replay');
    });
    expect(ledger.lookup('user/op', 'one')).toMatchObject({ state: 'pending' });
    await Promise.resolve();
    finish(7);
    expect(await first).toEqual(await duplicate);
    expect(executions).toBe(1);
    const receipt = ledger.lookup('user/op', 'one');
    if (receipt.state !== 'completed') throw new Error('Expected completed receipt.');
    receipt.result[0] = 99;
    expect(ledger.lookup('user/op', 'one')).toMatchObject({ result: new Uint8Array([7]) });
    expect(ledger.lookup('other/op', 'one')).toEqual({ key: 'one', state: 'missing' });
    await ledger.close();
  });

  it('rejects same-key conflicts, stale commands and future expiry before running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const ledger = createRpcDeliveryLedger(options);
    const command = { key: 'one', expiresAt: 1040, payload: new Uint8Array([4]) };
    await ledger.execute('scope', command, async () => 1);
    await expect(
      ledger.execute('scope', { ...command, payload: new Uint8Array([5]) }, async () => 2),
    ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    await expect(
      ledger.execute('scope', { ...command, key: 'stale', expiresAt: 1000 }, async () => 2),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(
      ledger.execute('scope', { ...command, key: 'future', expiresAt: 1051 }, async () => 2),
    ).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    await ledger.close();
  });

  it('pins pending work past expiry and retains completed receipts through retention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const ledger = createRpcDeliveryLedger({ ...options, maxEntries: 1 });
    let finish: (value: number) => void = () => {};
    const work = ledger.execute(
      'scope',
      { key: 'one', expiresAt: 1040, payload: new Uint8Array() },
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    vi.setSystemTime(1200);
    expect(ledger.lookup('scope', 'one').state).toBe('pending');
    await expect(
      ledger.execute(
        'scope',
        { key: 'two', expiresAt: 1240, payload: new Uint8Array() },
        async () => 2,
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    finish(1);
    await work;
    vi.setSystemTime(1299);
    expect(ledger.lookup('scope', 'one').state).toBe('completed');
    vi.setSystemTime(1300);
    expect(ledger.lookup('scope', 'one').state).toBe('missing');
    await ledger.close();
  });

  it('retains uncertainty after handler/result encoding failure without replay', async () => {
    const failure = new Error('application');
    const ledger = createRpcDeliveryLedger(options);
    const command = { key: 'one', expiresAt: Date.now() + 40, payload: new Uint8Array() };
    await expect(
      ledger.execute('scope', command, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(ledger.lookup('scope', 'one')).toMatchObject({ state: 'uncertain' });
    expect(await ledger.execute('scope', command, async () => 4)).toMatchObject({
      state: 'uncertain',
    });
    const oversized = createRpcDeliveryLedger({
      ...options,
      encodeResult: () => new Uint8Array(17),
    });
    await expect(oversized.execute('scope', command, async () => 4)).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
    });
    expect(oversized.lookup('scope', 'one').state).toBe('uncertain');
    await Promise.all([ledger.close(), oversized.close()]);
  });

  it('reserves result capacity before mutation and closes uncooperative work promptly', async () => {
    const ledger = createRpcDeliveryLedger({ ...options, maxBytes: 36 });
    const command = { key: 'k', expiresAt: Date.now() + 40, payload: new Uint8Array([1]) };
    // 16 metadata + 1 key + 1 scope + 1 payload + 16 result = 35 bytes.
    let ownedSignal: AbortSignal | undefined;
    const pending = ledger.execute('s', command, (_payload, signal) => {
      ownedSignal = signal;
      return new Promise<number>(() => {});
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(RpcError);
    await Promise.resolve();
    await expect(
      ledger.execute('s', { ...command, key: 'j' }, async () => 1),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    const closing = ledger.close();
    expect(ledger.close()).toBe(closing);
    await closing;
    await rejected;
    expect(ownedSignal?.aborted).toBe(true);
    await expect(ledger.execute('s', command, async () => 1)).rejects.toMatchObject({
      code: 'CLOSED',
    });
  });

  it('admits exactly the full reserved-byte budget and isolates ambiguous scope/key tuples', async () => {
    const ledger = createRpcDeliveryLedger({ ...options, maxBytes: 35 });
    const command = { key: 'k', expiresAt: 1040, payload: new Uint8Array([1]) };
    expect((await ledger.execute('s', command, () => 3)).state).toBe('completed');
    await expect(ledger.execute('s', { ...command, key: 'j' }, () => 4)).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
    const other = createRpcDeliveryLedger(options);
    await other.execute('a/b', { ...command, key: 'c' }, () => 1);
    await other.execute('a', { ...command, key: 'b_c' }, () => 2);
    expect(other.lookup('a/b', 'c')).toMatchObject({ result: new Uint8Array([1]) });
    expect(other.lookup('a', 'b_c')).toMatchObject({ result: new Uint8Array([2]) });
    await Promise.all([ledger.close(), other.close()]);
  });

  it('detaches admitted bytes before the caller mutates its command', async () => {
    const ledger = createRpcDeliveryLedger(options);
    const payload = new Uint8Array([4]);
    const command = { key: 'one', expiresAt: 1040, payload };
    const work = ledger.execute('scope', command, (bytes) => bytes[0] ?? 0);
    payload[0] = 9;
    expect(await work).toMatchObject({ result: new Uint8Array([4]) });
    await expect(ledger.execute('scope', command, () => 9)).rejects.toMatchObject({
      code: 'INVALID_MESSAGE',
    });
    await ledger.close();
  });

  it('sanitizes result codec failures and retains an uncertain tombstone', async () => {
    const ledger = createRpcDeliveryLedger({
      ...options,
      decodeResult: () => {
        throw new Error('private result');
      },
    });
    const command = { key: 'one', expiresAt: 1040, payload: new Uint8Array() };
    await expect(ledger.execute('scope', command, () => 1)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
    expect(ledger.lookup('scope', 'one')).toEqual({
      key: 'one',
      expiresAt: 1040,
      state: 'uncertain',
    });
    await ledger.close();
  });

  it('does not start a scheduled handler after reentrant terminal shutdown', async () => {
    const ledger = createRpcDeliveryLedger(options);
    const work = ledger.execute(
      'scope',
      {
        key: 'one',
        expiresAt: 1040,
        payload: new Uint8Array(),
      },
      () => {
        throw new Error('Handler must not start.');
      },
    );
    const result = expect(work).rejects.toMatchObject({ code: 'CLOSED' });
    await ledger.close();
    await result;
    expect(() => ledger.lookup('scope', 'one')).toThrowError();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks expiry immediately before starting admitted execution', async () => {
    const ledger = createRpcDeliveryLedger(options);
    const work = ledger.execute(
      'scope',
      {
        key: 'one',
        expiresAt: 1040,
        payload: new Uint8Array(),
      },
      () => {
        throw new Error('Expired work must not execute.');
      },
    );
    const result = expect(work).rejects.toMatchObject({ code: 'TIMEOUT' });
    vi.setSystemTime(1040);
    await result;
    expect(ledger.lookup('scope', 'one').state).toBe('uncertain');
    await ledger.close();
  });

  it('rejects invalid retention and sanitizes option getter failures', () => {
    expect(() => createRpcDeliveryLedger({ ...options, retentionMs: 49 })).toThrowError();
    try {
      createRpcDeliveryLedger({
        ...options,
        get retentionMs(): number {
          throw new Error('private configuration');
        },
      });
      throw new Error('Expected invalid options.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_OPTION' });
      expect(error).not.toHaveProperty('cause');
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});
