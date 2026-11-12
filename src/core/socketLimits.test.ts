import { describe, expect, it } from 'vitest';
import { assertMessageSize, assertSendCapacity } from './socketLimits.js';

describe('encoded socket boundary', () => {
  it('counts UTF-8 bytes and checks the exact encoded limit', () => {
    expect(assertMessageSize('éé', 4)).toBe(4);
    expect(() => assertMessageSize('ééa', 4)).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
  });

  it('counts only a binary view, rather than its larger underlying allocation', () => {
    const buffer = new ArrayBuffer(20);
    expect(assertMessageSize(new Uint8Array(buffer, 5, 3), 3)).toBe(3);
    expect(assertMessageSize(new Blob(['abcd']), 4)).toBe(4);
    expect(() => assertMessageSize(buffer, 4)).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
  });

  it('rejects unsupported message types without coercing or logging peer objects', () => {
    expect(() => assertMessageSize({ toString: () => 'fake-secret' }, 100)).toThrow(
      expect.objectContaining({ code: 'INVALID_MESSAGE' }),
    );
  });

  it('rejects the next send before it would exceed the socket high-water mark', () => {
    expect(() => assertSendCapacity(3, 1, 4)).not.toThrow();
    expect(() => assertSendCapacity(3, 2, 4)).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
    expect(() => assertSendCapacity(0, 5, 4)).toThrow(
      expect.objectContaining({ code: 'BACKPRESSURE' }),
    );
  });

  it('rejects invalid configuration and malformed socket bufferedAmount values', () => {
    for (const limit of [0, -1, NaN, Infinity, 1.1]) {
      expect(() => assertMessageSize('x', limit)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTION' }),
      );
    }
    expect(() => assertSendCapacity(NaN, 1, 10)).toThrow(
      expect.objectContaining({ code: 'INVALID_MESSAGE' }),
    );
  });
});
