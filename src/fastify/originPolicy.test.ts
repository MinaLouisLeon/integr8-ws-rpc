import { describe, expect, it } from 'vitest';
import { assertOriginAllowed } from './originPolicy.js';

describe('explicit upgrade origin policy', () => {
  it('requires a policy instead of silently permitting an upgrade', async () => {
    await expect(assertOriginAllowed(undefined, undefined)).rejects.toMatchObject({
      code: 'INVALID_OPTION',
    });
  });

  it('passes an absent Origin to the caller policy for an explicit native-client decision', async () => {
    const seen: Array<string | undefined> = [];
    await expect(
      assertOriginAllowed((origin) => {
        seen.push(origin);
        return origin === undefined;
      }, undefined),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([undefined]);
    await expect(
      assertOriginAllowed((origin) => origin === 'https://app.example', undefined),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('rejects a disallowed/malformed origin before invoking any socket or auth operation', async () => {
    await expect(
      assertOriginAllowed((origin) => origin === 'https://app.example', 'https://other.example'),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    let called = false;
    await expect(
      assertOriginAllowed(() => {
        called = true;
        return true;
      }, ['https://app.example']),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    expect(called).toBe(false);
  });

  it('supports async predicates and sanitizes their failures', async () => {
    await expect(
      assertOriginAllowed(async () => true, 'https://app.example'),
    ).resolves.toBeUndefined();
    await expect(
      assertOriginAllowed(async () => {
        throw new Error('fake-secret');
      }, undefined),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
