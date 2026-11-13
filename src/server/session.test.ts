import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session, type SessionOptions } from './session.js';

interface Context {
  readonly userId: string;
}

const sessions: Session<Context>[] = [];
const input = { transportVersion: 1, protocolVersions: [1, 3, 2], token: 'fake-token' };

function makeSession(options: Partial<SessionOptions<Context>> = {}): Session<Context> {
  const session = new Session<Context>({
    protocolVersions: [1, 2],
    authenticate: async () => ({ context: { userId: 'fake-user' } }),
    createSessionId: () => 'fake-session',
    ...options,
  });
  sessions.push(session);
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
  vi.useRealTimers();
});

describe('per-socket authentication gate', () => {
  it('never invokes an application operation before hello completes', async () => {
    const auth = Promise.withResolvers<{ context: Context }>();
    const session = makeSession({ authenticate: () => auth.promise });
    let called = false;
    const operation = async (): Promise<void> => {
      called = true;
    };
    await expect(session.runUnary(operation)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const handshake = session.hello(input);
    await expect(session.runUnary(operation)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(called).toBe(false);
    auth.resolve({ context: { userId: 'principal' } });
    await handshake;
    await session.runUnary(operation);
    expect(called).toBe(true);
  });

  it('authenticates once and supplies only the negotiated principal context', async () => {
    const seen: number[] = [];
    const session = makeSession({
      authenticate: async ({ protocolVersion }) => {
        seen.push(protocolVersion);
        return { context: { userId: 'principal' } };
      },
    });
    const response = await session.hello(input);
    expect(response).toEqual({
      transportVersion: 1,
      protocolVersion: 2,
      sessionId: 'fake-session',
    });
    expect(await session.runUnary(async (context) => context.userId)).toBe('principal');
    await expect(session.hello(input)).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(seen).toEqual([2]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('locks the first hello before awaiting the authentication callback', async () => {
    const pending = Promise.withResolvers<{ context: Context }>();
    let authCalls = 0;
    const session = makeSession({
      authenticate: () => {
        authCalls += 1;
        return pending.promise;
      },
    });
    const first = session.hello(input);
    await expect(session.hello(input)).rejects.toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(authCalls).toBe(1);
    pending.resolve({ context: { userId: 'principal' } });
    await first;
  });

  it('validates token/version bounds before invoking authentication', async () => {
    let authCalls = 0;
    const authenticate = async (): Promise<{ context: Context }> => {
      authCalls += 1;
      return { context: { userId: 'principal' } };
    };
    await expect(
      makeSession({ authenticate }).hello({ ...input, token: 'a'.repeat(8193) }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    await expect(
      makeSession({ authenticate }).hello({ ...input, protocolVersions: [9] }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' });
    expect(authCalls).toBe(0);
  });

  it('expires a socket that never sends hello independently of incoming traffic', async () => {
    const codes: string[] = [];
    const session = makeSession({
      handshakeTimeoutMs: 10,
      onClose: (code) => {
        codes.push(code);
      },
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(codes).toEqual(['HANDSHAKE_TIMEOUT']);
    await expect(session.hello(input)).rejects.toMatchObject({ code: 'HANDSHAKE_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts stalled authentication and discards its late successful principal', async () => {
    const pending = Promise.withResolvers<{ context: Context }>();
    let signal: AbortSignal | undefined;
    const session = makeSession({
      handshakeTimeoutMs: 10,
      authenticate: (request) => {
        signal = request.signal;
        return pending.promise;
      },
    });
    const hello = session.hello(input);
    const rejected = expect(hello).rejects.toMatchObject({ code: 'HANDSHAKE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signal?.aborted).toBe(true);
    pending.resolve({ context: { userId: 'late' } });
    await Promise.resolve();
    await expect(session.runUnary(async () => 'unsafe')).rejects.toMatchObject({
      code: 'HANDSHAKE_TIMEOUT',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sanitizes credential-provider failures and rejects expired credentials', async () => {
    const session = makeSession({
      authenticate: async () => {
        throw new Error('fake-secret');
      },
    });
    await expect(session.hello(input)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    try {
      await session.hello(input);
    } catch (error) {
      expect(String(error)).not.toContain('fake-secret');
    }
    const expired = makeSession({
      authenticate: async () => ({
        context: { userId: 'expired' },
        expiresAt: 0,
      }),
    });
    await expect(expired.hello(input)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });

  it('checks the absolute auth deadline even before a queued timer can run', async () => {
    let now = 0;
    const pending = Promise.withResolvers<{ context: Context }>();
    const session = makeSession({
      handshakeTimeoutMs: 10,
      scheduler: { now: () => now, schedule: () => () => {} },
      authenticate: () => pending.promise,
    });
    const handshake = session.hello(input);
    const rejected = expect(handshake).rejects.toMatchObject({ code: 'HANDSHAKE_TIMEOUT' });
    now = 11;
    pending.resolve({ context: { userId: 'late' } });
    await rejected;
  });

  it('sanitizes malformed authentication result accessors', async () => {
    const session = makeSession({
      authenticate: async () => ({
        context: { userId: 'principal' },
        get expiresAt(): number {
          throw new Error('fake-secret');
        },
      }),
    });
    await expect(session.hello(input)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(() => session.getContext()).toThrow(expect.objectContaining({ code: 'AUTH_FAILED' }));
  });

  it('invalidates active work at expiry without waiting for another request', async () => {
    const session = makeSession({
      authenticate: async () => ({
        context: { userId: 'principal' },
        expiresAt: 10,
      }),
    });
    await session.hello(input);
    let signal: AbortSignal | undefined;
    const call = session.runUnary(async (_context, abort) => {
      signal = abort;
      return new Promise<void>(() => {});
    });
    const rejected = expect(call).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(signal?.aborted).toBe(true);
    await expect(session.runUnary(async () => 'late')).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces call capacity and releases it when the caller cancels', async () => {
    const session = makeSession({ maxInFlightCalls: 1 });
    await session.hello(input);
    const controller = new AbortController();
    const call = session.runUnary(() => new Promise<void>(() => {}), controller.signal);
    const rejected = expect(call).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(session.runUnary(async () => 1)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    controller.abort();
    await rejected;
    expect(await session.runUnary(async () => 2)).toBe(2);
  });

  it('retains the session signal through stream consumption and cancels at expiry', async () => {
    const session = makeSession({
      authenticate: async () => ({
        context: { userId: 'principal' },
        expiresAt: 10,
      }),
    });
    await session.hello(input);
    let streamSignal: AbortSignal | undefined;
    const stream = await session.runProcedure(async (_context, signal) => {
      streamSignal = signal;
      return (async function* () {
        yield 1;
        await new Promise<void>(() => {});
      })();
    });
    expect(await stream.next()).toEqual({ done: false, value: 1 });
    const rejected = expect(stream.next()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(streamSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('releases active stream capacity on return without closing the session', async () => {
    const session = makeSession({ maxSubscriptions: 1 });
    await session.hello(input);
    const open = () =>
      session.runProcedure(async () =>
        (async function* () {
          yield 1;
        })(),
      );
    const stream = await open();
    await expect(open()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await stream.return(undefined);
    const replacement = await open();
    expect(await replacement.next()).toEqual({ done: false, value: 1 });
    await replacement.return(undefined);
  });

  it('passes application failures through unchanged and closes idempotently during work', async () => {
    const closed: string[] = [];
    const session = makeSession({
      onClose: (code) => {
        closed.push(code);
      },
    });
    await session.hello(input);
    const applicationError = new Error('application');
    await expect(
      session.runUnary(async () => {
        throw applicationError;
      }),
    ).rejects.toBe(applicationError);
    const call = session.runUnary(() => new Promise<void>(() => {}));
    const rejected = expect(call).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    session.close('AUTH_FAILED');
    session.close();
    await rejected;
    expect(closed).toEqual(['AUTH_FAILED']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
