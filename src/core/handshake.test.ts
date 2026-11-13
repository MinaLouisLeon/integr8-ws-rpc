import { describe, expect, it } from 'vitest';
import {
  negotiateProtocol,
  parseHello,
  parseHelloResponse,
  validateProtocolVersions,
} from './handshake.js';

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { transportVersion: 1, protocolVersions: [1], token: 'fake-token', ...overrides };
}

describe('hello boundary', () => {
  it('accepts the exact UTF-8 token bound but rejects one byte beyond it', () => {
    expect(parseHello(hello({ token: 'é'.repeat(4096) })).token.length).toBe(4096);
    expect(() => parseHello(hello({ token: `${'é'.repeat(4096)}a` }))).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }),
    );
  });

  it('rejects missing, non-string and empty credentials without exposing them', () => {
    for (const token of [undefined, null, 1, '']) {
      expect(() => parseHello(hello({ token }))).toThrow();
    }
  });

  it('distinguishes a well-formed unsupported transport from a malformed hello', () => {
    expect(() => parseHello(hello({ transportVersion: 2 }))).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }),
    );
    expect(() => parseHello(hello({ transportVersion: '1' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_MESSAGE' }),
    );
  });

  it('rejects excess/invalid versions and unknown hello fields', () => {
    for (const protocolVersions of [[], Array(9).fill(1), [0], [-1], [1.5], [Infinity]]) {
      expect(() => parseHello(hello({ protocolVersions }))).toThrow(
        expect.objectContaining({ code: 'INVALID_MESSAGE' }),
      );
    }
    expect(() => parseHello(hello({ extra: 'fake-secret' }))).toThrow(
      expect.objectContaining({ code: 'INVALID_MESSAGE' }),
    );
  });

  it('copies version preferences so callers cannot change a parsed hello', () => {
    const versions = [2, 1];
    const result = parseHello(hello({ protocolVersions: versions }));
    versions[0] = 3;
    expect(result.protocolVersions).toEqual([2, 1]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.protocolVersions)).toBe(true);
  });

  it('sanitizes input accessors that throw while the schema reads them', () => {
    expect(() =>
      parseHello({
        transportVersion: 1,
        protocolVersions: [1],
        get token(): string {
          throw new Error('fake-secret');
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MESSAGE' }));
  });
});

describe('application protocol negotiation', () => {
  it('selects the highest common version regardless of offered order', () => {
    expect(negotiateProtocol([1, 3, 2], [2, 1])).toBe(2);
    expect(negotiateProtocol([1, 1], [1])).toBe(1);
  });

  it('rejects incompatible versions before authentication can start', () => {
    expect(() => negotiateProtocol([1], [2])).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }),
    );
  });

  it('rejects malformed server configuration with INVALID_OPTION', () => {
    for (const versions of [[], [NaN], [0], [1.1], [Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => validateProtocolVersions(versions)).toThrow(
        expect.objectContaining({ code: 'INVALID_OPTION' }),
      );
    }
    expect(validateProtocolVersions([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('hello response boundary', () => {
  const response = { transportVersion: 1, protocolVersion: 2, sessionId: 'server-session' };

  it('accepts only a version offered by the client and transport version 1', () => {
    expect(parseHelloResponse(response, [1, 2]).protocolVersion).toBe(2);
    expect(() => parseHelloResponse(response, [1])).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }),
    );
    expect(() => parseHelloResponse({ ...response, transportVersion: 2 }, [2])).toThrow(
      expect.objectContaining({ code: 'PROTOCOL_MISMATCH' }),
    );
  });

  it('rejects malformed responses without retaining peer fields in the error', () => {
    expect(() => parseHelloResponse({ ...response, token: 'fake-secret' }, [2])).toThrow(
      expect.objectContaining({ code: 'INVALID_MESSAGE' }),
    );
    expect(() => parseHelloResponse({ ...response, sessionId: '' }, [2])).toThrow(
      expect.objectContaining({ code: 'INVALID_MESSAGE' }),
    );
  });

  it('permits capability metadata and expiry without adding them to a connection snapshot', () => {
    const result = parseHelloResponse(
      { ...response, expiresAt: 10, capabilities: { feature: true } },
      [2],
    );
    expect(result.expiresAt).toBe(10);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
