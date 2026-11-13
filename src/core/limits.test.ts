import { describe, expect, it } from 'vitest';
import { normalizeLimits } from './limits.js';

describe('transport limit validation', () => {
  it('rejects nonfinite, fractional, zero and unsafe resource limits', () => {
    for (const value of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => normalizeLimits({ maxPendingStreamBytes: value })).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTION' }),
      );
    }
  });

  it('keeps the documented simultaneous stream bounds and freezes normalized values', () => {
    const limits = normalizeLimits();
    expect(limits.maxPendingStreamItems).toBe(256);
    expect(limits.maxPendingStreamBytes).toBe(1024 * 1024);
    expect(Object.isFrozen(limits)).toBe(true);
  });
});
