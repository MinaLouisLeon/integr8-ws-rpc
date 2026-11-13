# @integr8-media/ws-rpc

Reusable typed WebSocket RPC transport using oRPC. Applications provide routers, authentication
and context. Server/tooling target Node 24; root/client imports must remain browser-safe.

## Implementation status

Source is written on `feature/m0-scaffold`, branched from local `dev` at `fd93759`:

- `/client`: `createRpcClient` with lazy authenticated connect, typed calls, safe snapshots,
  finite reconnect, heartbeat and opt-in managed resubscription with gap notifications.
- `/server`: `createRpcServer` with reserved hello/ping, required authentication context,
  namespace collision detection, deadlines, capacity, expiry and external session revocation.
- `/fastify`: `registerRpcWebSocket` with explicit origin policy, parser limits, duplicate-path
  detection and disposal that closes owned peers while preserving the host and unrelated routes.
- Stream item/byte accounting before ClientPeer queues events, cancellation lifetimes,
  adjacent regression tests, compile fixtures and a loopback smoke playground.

**Local checks now include 131 passing tests (89.73% line coverage), build, size, docs, smoke and
native stress on Node 22.22.3.** Node 24 target verification and packed-package checks remain open;
see [verification results](docs/verification-2026-11-12.md). M0/M1 gates remain open. The complete
client handle requires lifecycle/stream foundations associated with M2; M2 is not complete either.
M3 consumer/tooling and approved M4 helper sources are written; runtime acceptance and M5–M6 remain pending.
No package version is selected; the
manifest remains private with its version unset. A package-lock.json is present. This branch is
prepared for a draft PR into dev; no publication or completed release gate is claimed.

See [SPEC and progress](docs/SPEC.md), [dependency approvals](docs/dependency-proposal.md),
[compatibility](docs/transport-compatibility.md), [errors](docs/errors.md) and
[M1 plan](docs/superpowers/plans/2026-11-11-m1-authenticated-calls.md).

## Using the API

Supply `RouterClient<typeof router>` from oRPC as the client factory's type argument. The factory
returns the typed application client alongside connect/close/getSnapshot/subscribe/subscribeStream.
Calls reject before ready; calls are never queued or replayed. Losing a dispatched response yields
OUTCOME_UNKNOWN. Cancellation is cooperative and cannot undo a committed mutation.

Authentication returns `{ context, expiresAt? }`, with expiry in epoch milliseconds. Context must
satisfy the application's required router context. `disconnectSession` invalidates a server-issued
random session ID, never a token. Register the Fastify adapter before listen/ready; its origin
predicate is mandatory, including its decision for absent Origin. Dispose retains a rejecting route
because Fastify cannot unregister it; it does not shut down the host.

See `fixtures/transport/inference.ts` for compile-only input/output/error/stream/context checks and
`playground/smoke.mjs` for an exchange through built public entries with fake loopback credentials.
The root exports RpcError, RpcErrorCode, ConnectionState, ConnectionSnapshot and RpcClientOptions.
Typed application errors retain their upstream data. Never log full errors/causes or credentials.

## Configuration and bounds

Defaults remain those in SPEC. Both pending-stream bounds apply together. The implementation meters
encoded events before upstream buffering, with a separate connection-wide raw decoding backlog cap.
Memory/stress/platform evidence remains required; do not treat source accounting as proven bounds.

Validation ranges: integer timeout/heartbeat/backoff milliseconds 1..2^31-1; backoff base <= maximum;
retryLimit 0..1000; message/socket/pending-stream byte limits 1..64 MiB; in-flight calls 1..10,000;
subscriptions 1..1024; pending items 1..65,536. URLs allow remote wss or loopback ws for development,
and reject user-info, query strings and fragments. Additional local-network ws support needs agreement
on its public configuration. No new runtime-support promise is made by these fixtures.

## Developer-run checks

AGENTS.md reserves installs and implementation commands for the developer. Use Node 24.11+ for the
approved tooling. Set the initial version before relying on packed-package checks; npm install
creates the required package-lock.json. Existing commands are listed below. Lint and the full
typecheck (including browser/test/config projects and inference fixtures) pass under the developer's
explicit overrides. Runtime tests, builds and the other checks remain unrun by the agent.

```sh
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run playground:smoke
npm run check:consumers
npm run test:stress
npm run size
npm run check:exports
npm run docs
```

`format`, `test` and `fixtures` also exist. Typecheck covers production isolated declarations,
a browser project without Node ambient types, tests/config/scripts and compile-only fixtures.
`playground:smoke` builds and starts an ephemeral loopback Fastify/Node-client exchange, checking
context and adapter disposal through built entries, with cleanup in finally.

Build output is separate dist/browser and dist/node ESM .mjs/.d.mts, without source maps. Only dist
is explicitly packaged; npm also includes README automatically. Export checks include publint,
packed type resolution and traversal of the installed browser dependency graph. This conservative
inspection is not a bundled browser/Expo consumer or a device test; those remain M3. Size budgets
measure emitted gzip bytes and exclude external dependency costs.

## Setup and playground

After the developer installs the approved dependencies, `npm run playground:smoke` exercises a
loopback Node client/server through built entries. `npm run playground` builds then starts the real
browser example at http://127.0.0.1:5173. Connect, make a typed lookup, subscribe, unsubscribe and
close. A closed handle is terminal; reload the example to create another. The server accepts only
that exact browser Origin or an explicitly permitted absent Origin for Node, and fake example
credentials. It binds loopback and is not a production authentication or remote-access service.

Minimal browser client (the application owns its router type and credential provider):

```ts
import { createRpcClient } from '@integr8-media/ws-rpc/client';
import type { ExampleClient } from './router.js';

const connection = createRpcClient<ExampleClient>({
  url: 'ws://127.0.0.1:5173/rpc',
  protocolVersions: [1],
  getToken: async () => 'playground-fake-token', // Fixture only.
  createWebSocket: (url) => new WebSocket(url),
});
await connection.connect();
const result = await connection.client.lookup({ id: 'example' });
await connection.close(); // Also call on component/app disposal, not just successful calls.
```

See [example router](playground/router.ts), [server integration](playground/server.mjs) and
[packed Node consumer](fixtures/consumers/node.mts) for complete typed/context/error/stream examples.
Applications normally close in finally and detach state listeners. Register the adapter before
Fastify ready/listen. An externally installed WebSocket plugin must enforce a parser maxPayload
at least as strict as this server's configured message cap. Hosts own TLS and upgrade/rate limits.

## Connection state and delivery

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> connecting: connect
  connecting --> authenticating: socket open
  authenticating --> ready: hello accepted
  connecting --> reconnecting: retryable failure
  authenticating --> reconnecting: retryable failure
  ready --> reconnecting: unexpected loss
  ready --> error: revoked credentials or terminal failure
  reconnecting --> connecting: finite jittered retry
  connecting --> error: terminal or exhausted
  authenticating --> error: terminal or exhausted
  reconnecting --> error: exhausted
  error --> connecting: explicit retry if nonterminal
  idle --> closed: close
  connecting --> closed: close
  authenticating --> closed: close
  ready --> closed: close
  reconnecting --> closed: close
  error --> closed: close
```

The application client is never an offline queue. Before ready a call rejects DISCONNECTED. After
dispatch, a lost reply can report OUTCOME_UNKNOWN even if the server committed; reconcile with the
application's own contract, never automatically replay. Deadlines and abort request cooperative
cancellation, not rollback. Defined upstream application errors retain code/data; transport failures
use RpcError. Snapshots and diagnostic events contain safe state/codes/session IDs, never tokens.

Use subscribeStream for managed subscriptions. Its open callback receives the typed client and
owned signal; pass that signal to the procedure. Awaiting observer.next applies local consumption
backpressure. If the peer outpaces both pending limits the stream fails BACKPRESSURE. A socket-wide
send high-water violation closes that connection. Ordinary iterators end on loss. Managed
resubscribe:true opts into one fresh stream per authenticated epoch and gap before new items;
there is no implied replay or fabricated resume cursor. Unsubscribe aborts delivery and never reopens.

## Runtime and release evidence

| Consumer | Intended environment | Evidence required |
|---|---|---|
| Server/tooling | Node 24 (24.11+ for approved tools) | Native Node fixtures, coverage/build/export results |
| Browser | Compatible standard WebSocket factory | Real browser playground plus packed bundle graph |
| Node client | Compatible caller-provided socket | Packed native unary/error/stream/disposal exchange |
| Expo Android | Existing app's compatible socket | Physical Android artifact-specific runtime record |
| Expo iPadOS | Existing app's compatible socket | Physical iPadOS artifact-specific runtime record |

These are targets, not a claim that runtime/device acceptance has passed. The Expo probe adds no
React/native dependencies here; it runs in an existing app against reachable wss. Typechecking a
probe cannot establish native compatibility. See [consumer instructions](fixtures/README.md),
[Expo device guide](fixtures/expo/README.md) and [acceptance matrix](docs/acceptance.md).

After version selection and build, `npm run check:consumers` explicitly packs and installs into
isolated temporary consumers outside the repo and retains records in fixtures/.artifacts; it does
not modify the root lockfile or publish.
It checks public declarations, executes Node RPC, and audits all browser chunks with a complete-JS
150 KiB gzip fixture budget including dependency costs. Its source typecheck seams are separate
from these installed-artifact checks. `npm run test:stress` requires dist and measures a finite
native workload with explicit GC, retaining memory samples; its regression envelope is not proof
of exact per-stream/process bounds. All runtime/device results still need actual execution.

PR CI targets dev using the pinned shared config workflow; the supplemental job adds M3 consumers,
stress, docs and retained artifacts. Shared workflow access is repository-owner configuration.
lefthook.yml extends the confirmed config preset, but neither a new Lefthook dependency nor hooks
are installed automatically. Publication/trusted publishing and initial version/license metadata
remain developer decisions. See [unreleased changelog](CHANGELOG.md).

## Migration notes

No earlier published release is claimed. Consumers of an internal/private attempt primitive should
move to the documented public factories and own the returned handle's cleanup. Do not import src,
test helpers or internal built chunks. Select one compatible oRPC release line; these examples use
the approved 1.16.2 APIs, not v2 adapter examples. Keep server router imports type-only in clients.
For pre-publication use, record the exact tarball SHA-256 and lockfile rather than invent an npm
version. The approved M4 extension adds exactly the two /client helpers documented below. M5 offline
delivery and M6 React/Query remain follow-ons; no extra package subpaths are added.

## Named client groups (M4)

```ts
import { createRpcClientGroup } from '@integr8-media/ws-rpc/client';

// catalogConnection and jobsConnection are already-created, independently typed handles.
const group = createRpcClientGroup({ catalog: catalogConnection, jobs: jobsConnection });
const results = await group.connectAll(); // Each name: fulfilled, or rejected with a safe code.
await group.clients.catalog.client.lookup({ id: 'one' });
await group.close('catalog'); // Leaves jobs running; catalog cannot be reopened/replaced.
await group.close(); // Terminal, idempotent; waits for all child cleanup attempts.
```

The group takes lifecycle ownership of 1..32 distinct handles. Its copied registry is readonly;
names are 1..64 characters matching `[A-Za-z][A-Za-z0-9_-]{0,63}`. Invalid names, symbols, aliases,
getter entries or malformed handles fail before listener installation. Keep names nonsecret.
Read aggregate state with getSnapshot and observe future transitions with subscribe; both preserve
the exact registry keys and copied frozen snapshots. Individual child/client types are retained,
including required per-call context. One failed connection does not roll back healthy children.

No automatic routing, failover, shared authentication, extra retry or stream owner. Use group close
for lifecycle ownership; closing a child directly is reflected without affecting siblings. A failed
cleanup still attempts every sibling and reports a safe error. Aggregate snapshot entries reflect
the last observed actual child state, not an invented all-ready/all-closed state on cleanup failure.

## Binary slices and local progress (M4)

```ts
import { chunkBinary } from '@integr8-media/ws-rpc/client';

const source = new Uint8Array([1, 2, 3]);
for await (const chunk of chunkBinary(source, {
  maxBytes: 3,       // Required total input budget; validates before reading.
  chunkBytes: 2,     // Default 65,536; range 1..1,048,576.
  signal,
  onProgress: (event) => showLocalProgress(event),
})) {
  // Application-owned procedure/schema; upstream encoding and transport frame caps still apply.
  await client.binarySize(new Blob([new Uint8Array(chunk).buffer]));
}
```

Sources are Blob or Uint8Array views. maxBytes is a safe integer >=0; oversized known input throws
PAYLOAD_TOO_LARGE synchronously. Chunks are nonempty independent copies, produced on requested pulls.
An empty input produces no chunk. No whole-input copy, file access, transfer ID, acknowledgement,
resume cursor or retry is supplied. Do not mutate an array source during iteration.

Progress is a frozen `{ producedBytes, totalBytes, done }`: initial zero, each locally prepared
chunk, then local EOF when the consumer pulls through completion. It does not prove encoded/sent,
received/persisted bytes or completed transfer. An async callback is awaited; failures propagate
as application callback errors. Abort/early return stops local delivery, observes/discards late
results, and emits no later completion before EOF. EOF is committed before its notification;
abort can release an uncooperative completion observer without undoing that already-observed EOF.

The helper retains caller-owned input and cannot bound chunks retained/requested by the caller.
Raw chunk size is not encoded message size. Existing frame/high-water/stream limits stay active;
Node/browser example checks explicitly characterize this boundary. Source-read failures use safe
INTERNAL, caller cancellation uses CANCELLED. These helpers and native Blob compatibility still
need runtime/packed/device verification; no new runtime support promise is made.
