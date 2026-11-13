import { describe, expect, it } from 'vitest';
import { commandBytes, copyBytes, readCommand, readReceipt, validateBudgets } from './delivery.js';

describe('offline delivery boundaries', () => {
  it('accounts for UTF-8 identifiers and detaches mutable views', () => {
    const source = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
    const copied = copyBytes(source, 'INVALID_MESSAGE');
    source[0] = 8;
    expect([...copied]).toEqual([1, 2]);
    expect(commandBytes('key', copied, 'é')).toBe(23);
  });

  it('rejects malformed envelope fields without invoking accessors', () => {
    const command = { key: 'key', expiresAt: 100, payload: new Uint8Array([1]) };
    expect(readCommand(command)).toEqual(command);
    expect(() => readCommand({ ...command, key: 'unsafe key' })).toThrowError();
    expect(() => readCommand({ ...command, expiresAt: Number.NaN })).toThrowError();
    expect(() =>
      readCommand({
        get key() {
          throw new Error('secret');
        },
      }),
    ).toThrowError();
    expect(() => readReceipt({ key: 'key', state: 'completed', expiresAt: 100 })).toThrowError();
    expect(readReceipt({ key: 'key', state: 'missing' })).toEqual({ key: 'key', state: 'missing' });
  });

  it('rejects unsafe or contradictory count/byte budgets', () => {
    for (const overrides of [
      { maxEntries: 0 },
      { maxEntries: 10_001 },
      { maxBytes: Number.POSITIVE_INFINITY },
      { maxEntryBytes: 65 },
      { maxBytes: 1.5 },
    ]) {
      expect(() =>
        validateBudgets({ maxEntries: 2, maxBytes: 64, maxEntryBytes: 32, ...overrides }),
      ).toThrowError();
    }
  });

  it('ignores byte-length and iterator overrides when copying input', () => {
    const forged = new Uint8Array([1, 2]);
    Object.defineProperty(forged, 'byteLength', { value: 0 });
    Object.defineProperty(forged, Symbol.iterator, { value: () => [99][Symbol.iterator]() });
    expect([...copyBytes(forged, 'INVALID_MESSAGE')]).toEqual([1, 2]);
  });
});
