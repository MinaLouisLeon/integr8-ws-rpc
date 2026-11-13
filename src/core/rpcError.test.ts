import { describe, expect, it } from 'vitest';
import { RpcError } from './rpcError.js';

describe('RpcError', () => {
  it('keeps transport failures distinguishable from application errors', () => {
    const error = new RpcError('OUTCOME_UNKNOWN');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RpcError);
    expect(error.code).toBe('OUTCOME_UNKNOWN');
    expect(new Error('Application failure')).not.toBeInstanceOf(RpcError);
  });

  it('keeps a secret-bearing cause out of the message and JSON diagnostics', () => {
    const cause = new Error('fake-token-do-not-log');
    const error = new RpcError('AUTH_FAILED', { cause });

    expect(error.cause).toBe(cause);
    expect(error.message.length).toBeGreaterThan(0);
    expect(error.message).not.toContain('fake-token-do-not-log');
    expect(String(error)).not.toContain('fake-token-do-not-log');
    expect(JSON.stringify(error)).not.toContain('fake-token-do-not-log');
    expect(Object.keys(error)).not.toContain('cause');
  });
});
