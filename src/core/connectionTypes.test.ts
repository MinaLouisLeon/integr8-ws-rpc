import { expectTypeOf, it } from 'vitest';
import type { ConnectionSnapshot, ConnectionState, RpcClientOptions } from '../index.js';

it('requires negotiated session metadata in a ready snapshot', () => {
  const ready = {
    state: 'ready',
    attempt: 1,
    sessionId: 'fake-session',
    protocolVersion: 1,
  } as const satisfies ConnectionSnapshot;

  expectTypeOf(ready.state).toMatchTypeOf<ConnectionState>();
  // @ts-expect-error Ready snapshots require negotiated metadata.
  const missingSession: ConnectionSnapshot = { state: 'ready', attempt: 1 };
  void missingSession;
});

it('makes snapshots and client configuration readonly', () => {
  type Ready = Extract<ConnectionSnapshot, { state: 'ready' }>;
  expectTypeOf<Ready['sessionId']>().toEqualTypeOf<string>();
  expectTypeOf<RpcClientOptions['protocolVersions']>().toEqualTypeOf<readonly number[]>();

  function check(snapshot: ConnectionSnapshot, options: RpcClientOptions): void {
    // @ts-expect-error Consumers cannot change lifecycle state.
    snapshot.state = 'closed';
    // @ts-expect-error Consumers cannot mutate version preference order.
    options.protocolVersions.push(2);
    // @ts-expect-error Options are immutable.
    options.url = 'ws://127.0.0.1:3000/rpc';
  }
  void check;
});
