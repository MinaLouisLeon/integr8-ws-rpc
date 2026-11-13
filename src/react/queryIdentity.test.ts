import { describe, expect, it } from 'vitest';
import { effectiveKey, validateCacheDuration } from './queryIdentity.js';

describe('React query identity boundaries', () => {
  it('separates handles and scopes while retaining the same handle identity across calls', () => {
    const first = {};
    const second = {};
    const original = effectiveKey(first, 'account', ['read', 1]);
    expect(effectiveKey(first, 'account', ['read', 1])).toEqual(original);
    expect(effectiveKey(second, 'account', ['read', 1])).not.toEqual(original);
    expect(effectiveKey(first, 'other', ['read', 1])).not.toEqual(original);
    expect(Object.isFrozen(original)).toBe(true);
  });

  it('rejects malformed namespaces, keys and unbounded duration options', () => {
    expect(() => effectiveKey({}, 'contains a space', ['read'])).toThrowError();
    expect(() => effectiveKey({}, 'valid', [])).toThrowError();
    for (const value of [-1, 0.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => validateCacheDuration(value)).toThrowError();
    }
    expect(validateCacheDuration(0)).toBe(0);
    expect(validateCacheDuration(undefined)).toBeUndefined();
  });
});
