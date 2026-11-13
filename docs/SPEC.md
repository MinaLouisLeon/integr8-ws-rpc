# @integr8-media/ws-rpc — implementation specification

Created 2026-11-11 for the repository folder `integr8-wc-rpc`.

**Status:** M0–M6 source is written; acceptance and current-checkout verification remain separate.
See Progress for chronological records; M5/M6 lint/typecheck pass, runtime/build acceptance is open.
The user approved the package boundary and Phase 02 scope. Concrete defaults and API names below
are design decisions recorded by this spec, not claims of previously approved versions or tested
behavior. M0 must confirm the dependency line and type mapping before transport implementation.
After that review, treat the public contract as locked except for the Progress section.

## 1. Purpose and scope

Provide reusable, typed calls and server-to-client event streams over WebSocket, built on oRPC and
Zod. A Node/Fastify server serves browser, Node and Expo clients. Workbench supplies its own agent
contracts, identity policy and persistence; another product can supply different ones.

### First delivery: M0–M3

- Authenticated/versioned connection handshake before application procedures can execute.
- Typed unary calls and server-to-client streams using oRPC's existing encoding and routing.
- Cancellation, timeouts, bounded resources, deterministic cleanup and explicit connection state.
- Reconnect with fresh credentials; opt-in stream resubscription with clear gap semantics.
- No automatic replay of calls whose outcome is uncertain; offline application calls fail fast.
- A runnable client/server playground and actual Node/browser/Expo consumer evidence.

M3 unlocks product Phase 03 once the developer records its acceptance evidence. It does not require
all later enhancements to ship. Phase 01 integration verification remains a project prerequisite;
creating these documents does not establish that evidence.

### Non-goals

No generic JSON-RPC 2.0 compatibility promise, HTTP API client engine, file-transfer engine, PTY,
pairing/discovery, token issuance/storage, Workbench method schemas, UI components, application
database, durable job delivery, exactly-once execution or hostile-code sandbox.

React/TanStack helpers, offline queues and high-level binary transfer are follow-ons. The initial
package has no dependency on integr8-ui, window-manager, Tauri or Expo native modules.

## 2. Architecture and dependency decisions

Use oRPC's WebSocket adapters, router/client types and serialization. Zod validates runtime
boundaries. Fastify is a server integration, not the source of product identity policy. Config is
development tooling, never a client runtime dependency.

Do not implement a second frame multiplexer, correlation-ID format or generic retry layer on top
of undocumented upstream internals. One owner controls reconnect; disable equivalent upstream
retries/reconnect where necessary. One owner controls each stream's resubscription.

The initial dependency ledger is deliberately **pending version approval**:

| Candidate | Role | Decision before use |
|---|---|---|
| @integr8-media/config | Presets and shared CI | Confirm available version and actual export/workflow names |
| @orpc/client, @orpc/server, @orpc/contract as needed | Typed transport/contracts | Choose one compatible release family; add only packages actually used |
| zod | Handshake/runtime validation | Match supported upstream range |
| fastify, @fastify/websocket, ws as needed | Node upgrade and socket integration | Confirm compatible versions and whether direct ws dependency is needed |
| TypeScript and test/build/doc/check tools | Development only | Prefer config-supported versions; approve direct dependencies |

Before manifest changes record versions, roles (dependency/peer/dev/optional), approximate size,
licenses and approval. No approvals or installs occurred during spec creation. Do not select a beta
or assume a major version because a current documentation example uses it.

Official references consulted for design on 2026-11-11:

- [oRPC WebSocket adapter](https://orpc.dev/docs/adapters/websocket)
- [oRPC migration guide](https://orpc.dev/docs/migrations/from-v1)

Current docs distinguish adapter APIs between major versions. Recheck the chosen version's API and
types in M0; document the mapping in `docs/transport-compatibility.md`. Upstream serialization is
the wire format. Do not describe oRPC frames as interchangeable with JSON-RPC 2.0.

## 3. Package layout and exports

```text
src/
  index.ts                  # platform-neutral errors, options and connection types
  core/                     # lifecycle, limits, retry scheduling, validation
  client/index.ts           # browser-compatible createRpcClient
  server/index.ts           # Node createRpcServer
  fastify/index.ts          # Node registerRpcWebSocket adapter
  react/index.ts            # optional React/Query hooks; isolated from initial runtime graph
playground/                 # server, Node client and browser client; no real credentials
fixtures/                   # clean Node/browser/Expo consumers and packed-export checks
docs/SPEC.md
docs/transport-compatibility.md
AGENTS.md
```

Public initial subpaths: package root, `/client`, `/server`, `/fastify`. The root and client must
not import Node built-ins, Fastify, ws, React, DOM globals at module initialization or native Expo
APIs. Accept a platform WebSocket factory instead of importing a global during module evaluation.
Server code must not import client platform adapters.

Approved M6 adds only optional `/react`. Existing entries must import and typecheck without its
optional React/Query/type peers; hooks are not re-exported through root/client.

ESM TypeScript; Node 24 server/tooling. Emit declarations and use strict/isolated-declaration
compatible exports. Runtime adapters select the appropriate implementation. Node clients supply
an approved socket implementation; Expo supplies its compatible WebSocket implementation.

Only `dist` is published, without source-containing maps. Export maps must expose only documented
paths, with browser-safe client resolution and no accidental development/source imports.

## 4. Public contract

M0 records exact upstream generic signatures in the compatibility document. Preserve inference of
the caller's oRPC contract/router: input, output, typed errors and stream item types must survive
the wrapper. Do not replace them with a string-method/unknown-result API. Do not add overloads or
exports just to expose all upstream internals.

| Export | Entry | Required behavior |
|---|---|---|
| RpcError, RpcErrorCode | root | Transport/lifecycle error with stable code, safe message and optional cause |
| ConnectionState, ConnectionSnapshot, RpcClientOptions | root | Readonly documented lifecycle/options types |
| createRpcClient | /client | Return a typed connection handle without opening a socket until connect() |
| createRpcClientGroup | /client | Own a static typed registry of independent client handles under the approved M4 contract |
| chunkBinary | /client | Pull bounded binary copies with explicit total byte budget and local-only progress under the approved M4 contract |
| createRpcOfflineQueue | /client | Explicit bounded in-memory unary submission and read-only outcome reconciliation under the approved M5 contract |
| createRpcDeliveryLedger | /server | Authenticated caller-scoped process-local receipt/deduplication ownership under the approved M5 contract |
| createRpcServer | /server | Compose an application router with reserved handshake/health procedures and auth guard |
| registerRpcWebSocket | /fastify | Attach that server to a caller-owned Fastify instance and configurable path |
| useRpcSnapshot | /react | Observe a caller-owned connection; stable idle SSR/hydration snapshot |
| useRpcQuery | /react | Manual-only typed Query reads; caller cache/connection ownership |
| useRpcMutation | /react | Explicit typed mutations without retry/offline pause/automatic replay |

### Client handle

- `client`: the inferred application procedure client; calls reject unless ready.
- `connect(): Promise<void>`: concurrent callers share one attempt; resolves only after auth and
  version negotiation. On terminal failure rejects with RpcError. After explicit close, rejects
  CLOSED; create a new handle to restart. No timers/sockets are created merely by importing.
- `close(): Promise<void>`: idempotent; stops reconnect, cancels requests/subscriptions and releases
  owned listeners/timers/sockets. Must work during handshake and reconnect, not only when ready.
- `getSnapshot(): ConnectionSnapshot`: immutable state snapshot without token/payload data.
- `subscribe(listener): () => void`: connection-state updates; unsubscribe removes the listener.
- `subscribeStream(open, observer, options)`: open receives the same typed application client and
  a package-owned AbortSignal and returns a typed AsyncIterable. Return a handle with idempotent
  `unsubscribe(): Promise<void>`. Callbacks are next/error/complete plus an optional gap event.
  Options include `resubscribe` (default false). An unsubscribed stream must never reopen.

Procedure calls preserve upstream per-call AbortSignal support. A package deadline and caller
abort are composed; disposal removes both listeners. Do not hide upstream typed application errors
inside a generic network failure. Throw RpcError for transport/lifecycle failures only.

### Server and Fastify handles

`createRpcServer` accepts the caller router, auth callback, supported application protocol versions,
limits and optional safe diagnostics. Authentication returns caller-defined principal/context and
optional expiry; application procedures receive that context only after handshake succeeds.

The server handle provides `disconnectSession(sessionId, reason): Promise<void>` for external
revocation and `close(): Promise<void>` for owned sessions. Session identifiers are random server
values, not tokens. External identity stores choose which sessions to revoke.

`registerRpcWebSocket` defaults to `/rpc` and returns `dispose(): Promise<void>`. Register it before
Fastify starts listening. Disposal removes/closes the adapter's resources and hooks as supported by
the selected Fastify version; it must not close the caller-owned Fastify server or unrelated routes.
If routes cannot be unregistered, disposed routes reject new upgrades and retain no live sessions.
Duplicate path ownership must fail visibly. Fastify shutdown invokes the same idempotent cleanup.

## 5. Wire handshake and authentication

Reserve router namespace `__integr8Transport`; reject application routers that collide with it.
Use oRPC procedures for `hello` and `ping`, not unrelated raw JSON frames injected into its socket.
Both client/server composition and routing types must be verified in M0 before freezing signatures.

1. Upgrade only an allowed origin/path using caller-specified origin policy; same-origin is not
   silently inferred. The server adapter requires an explicit origin predicate, including how
   absent Origin headers from native/Node clients are treated. Never default to allow-all origins.
2. On the new socket, only hello is allowed. It carries `transportVersion: 1`, an ordered bounded
   array of supported positive integer application protocol versions, and a token from the async
   credential provider. No token in URL/query strings, subprotocol identifiers or diagnostics.
3. Validate a token maximum of 8 KiB, at most 8 offered application versions and the handshake
   deadline before calling the auth adapter. Log only redacted error code/session correlation.
4. Authenticate through the injected callback, choose the highest mutually supported application
   version, and reply with transport version, selected application version, session ID, optional
   expiry and non-secret server capability metadata. The application chooses version support;
   Workbench's current/previous-version policy is not hard-coded into this library.
5. Expose ready only after success. Every application call/subscription is guarded against an
   unauthenticated, expired or invalidated session, including parallel calls during hello.

Reject a second hello on an authenticated socket; reconnect creates a new session and re-invokes
the credential provider. The package does not generate/refresh/store tokens. If credentials fail,
stop automatic reconnect and report AUTH_FAILED. A caller supplies new credentials through a new
connection handle; do not loop on revoked credentials.

On expiry or disconnectSession, abort active server work/streams and close the socket. Cleanup
must not depend on another request arriving. Race-test expiry/revocation against new calls and
stream emissions. Cancellation is cooperative: do not claim that disconnect rolls back an
application mutation already committed by its handler.

The package owns a pre-auth handshake timer and bounds pre-auth payloads/concurrency; only one
hello can authenticate a socket. The host owns per-IP upgrade/rate limits and TLS configuration.
Production remote credentials require wss; ws is for explicit development or caller-approved
local environments. Examples use fake tokens and loopback addresses only.

## 6. Lifecycle, reconnect and delivery semantics

States: `idle`, `connecting`, `authenticating`, `ready`, `reconnecting`, `error`, `closed`.
Snapshots include state, attempt number, negotiated version/session when ready and a safe last
error code. Notify only after the transition commits; observer exceptions do not break transport.

Defaults (configurable, validated as finite values within documented safe ranges):

| Setting | Initial default |
|---|---|
| Connection plus handshake deadline | 10,000 ms per attempt |
| Unary call timeout | 30,000 ms |
| Reconnect | Enabled after unexpected connection loss |
| Backoff | Full jitter from 0 to min(30,000, 500 * 2^(attempt-1)) ms |
| Consecutive retry limit | 10; reset only after a successful authenticated handshake |
| Heartbeat | Reserved ping every 15,000 ms when ready; reply timeout 10,000 ms |
| Encoded message limit | 1 MiB in either direction |
| In-flight calls | 100 per connection; excess fails with LIMIT_EXCEEDED |
| Active subscriptions | 32 per connection; excess fails with LIMIT_EXCEEDED |
| Pending stream data | At most 256 items AND 1 MiB per subscription |
| Outgoing socket high-water mark | 1 MiB queued bytes; reject/cancel before unbounded buffering |
| Offline call queue | Disabled; size zero |

Inject clock/random/socket facilities internally for deterministic tests; do not expose test-only
helpers publicly. Ensure upstream buffering does not bypass package limits; if a selected adapter
cannot enforce the limits, resolve that incompatibility in M0 rather than documenting false bounds.

Initial connect retries retryable connection failures under the same finite policy. Exhaustion
transitions to error; an explicit connect() starts a new attempt cycle. Invalid configuration,
authentication and unsupported versions are terminal. Explicit close never reconnects. Use a
connection epoch so delayed callbacks from old sockets cannot change the active state.

### Calls and uncertain outcomes

- Before ready/disconnected: reject DISCONNECTED; do not enqueue.
- After sending and losing the connection before the result: reject OUTCOME_UNKNOWN. Do not replay
  automatically, even if the method name looks like a read. Apps reconcile via their own contracts.
- Deadline: reject TIMEOUT and request upstream cancellation. It is not proof the server did not act.
- Explicit abort: reject CANCELLED and stop local delivery; propagate the abort to the server where
  supported. Handlers must observe AbortSignal for cooperative cleanup.

### Streams

Ordinary streams terminate on connection loss. Managed subscriptions with resubscribe:true open
once per new authenticated epoch; notify a gap before new items. New subscription does not mean
replay or lossless delivery. An application may include its own resume cursor in open(), but the
package never fabricates one. Ignore old-epoch items. Overflow fails that subscription with
BACKPRESSURE; never silently drop events or grow memory. A connection-wide send-buffer violation
closes the affected connection with BACKPRESSURE and aborts its work.

## 7. Error codes

Initial RpcErrorCode values:

`INVALID_OPTION`, `AUTH_FAILED`, `AUTH_EXPIRED`, `PROTOCOL_MISMATCH`, `HANDSHAKE_TIMEOUT`,
`DISCONNECTED`, `OUTCOME_UNKNOWN`, `TIMEOUT`, `CANCELLED`, `CLOSED`, `LIMIT_EXCEEDED`,
`BACKPRESSURE`, `PAYLOAD_TOO_LARGE`, `INVALID_MESSAGE`, `INTERNAL`.

Document code, recoverability and when outcome may be unknown. Socket reasons/diagnostics carry
bounded safe text, not raw exceptions, credentials, payloads or handler stack traces. Peer-malformed
messages close only that connection. Typed application errors remain distinguishable from RpcError.

## 8. Milestones and acceptance

### M0 — scaffold and compatibility review

- Approve exact dependency versions/roles and record actual upstream adapter/type mappings.
- Confirm router composition, per-socket auth context, abort propagation, payload/buffer controls,
  browser/Node/Expo socket support and single-owner reconnect feasibility.
- Create package/config/scripts, initial exported types and a fake-socket lifecycle test harness.
- Write README and transport-compatibility notes; record script names and initial size budgets.
- Gate: the developer reviews the contract mapping and runs scaffold lint/typecheck/build/export
  checks. Resolve unsupported assumptions before M1, including any necessary approved spec changes.

### M1 — authenticated calls

- Implement reserved handshake, origin policy, guarded app routing and the Fastify adapter.
- Preserve call inference/application errors; implement call deadlines, cancellation and limits.
- Gate: client/server playground authenticates and makes a typed call; rejected origin/token/version,
  hello race, timeout and parallel pre-auth calls are tested. No app handler runs before ready.

### M2 — streams and connection lifecycle

- Implement bounded streaming, managed subscription disposal/resubscription and gap notifications.
- Implement heartbeat, jittered retries, credential re-read, expiry/revoke and epoch isolation.
- Gate: deterministic disconnect/reconnect tests show no replayed mutation, no duplicate stream,
  no stale-epoch event and no live timer/listener/socket after disposal.

### M3 — real consumers and first-slice release readiness

- Node server/client and browser playground; actual Expo device fixture on Android and iPadOS.
- Clean packed consumers prove client entry isolation and type inference; malformed/slow peers and
  bounded-memory stress scenarios prove limits at the actual upstream/socket boundary.
- README includes setup, origin/auth policy, state diagram, cleanup, cancellation, uncertain outcomes,
  stream gaps, runtime support and migration notes. Add CHANGELOG, TypeDoc and shared CI/hooks.
- Gate: developer-recorded lint/typecheck/test coverage/build/size/export/fixture results; at least
  80% source line coverage, with explicit tests of auth/replay/lifecycle branches. Record actual
  runtime evidence; a compilation-only Expo fixture is not native runtime verification.
- Publication remains a developer action. If consumed before publishing, record the exact packed
  artifact/reference; do not claim an npm version exists. Phase 03 may start after this gate.

### M4 — multi-server and binary/progress helpers (follow-on)

Initial independent handles must already isolate sockets, auth and state. Add a named multi-server
orchestration API and binary chunk/progress helpers only with reviewed contracts. Never encode
Workbench file transfer policy or assume a chunk limit implies whole-transfer memory bounds.

M4 contract approved by the developer on 2026-11-12:
[client group and binary helpers](superpowers/specs/2026-11-12-m4-contracts.md).
It adds exactly createRpcClientGroup and chunkBinary to /client. The group owns 1..32 distinct
existing handles in a static named registry, preserves heterogeneous procedure/context types,
provides safe per-name connectAll results and supports targeted/whole-group cleanup. Names match
`[A-Za-z][A-Za-z0-9_-]{0,63}`. It never reroutes, shares credentials or adds a retry/replay layer.
chunkBinary accepts Blob/Uint8Array plus required maxBytes, optional signal/progress and chunkBytes
(default 65,536; integer 1..1,048,576). maxBytes is a safe nonnegative integer and known input size
is checked before reading. Progress reports local production/EOF, not wire size or acknowledgement.
These new helper limits do not change existing transport defaults, codes, wire/auth contracts,
package entry paths or runtime-support promises. No transfer protocol or whole-transfer memory
guarantee is implied. The linked approved contract defines the full lifecycle/error semantics.

### M5 — opt-in offline delivery (follow-on)

Specify expiry, count/byte bounds, persistence ownership, cancellation, server acknowledgements,
idempotency keys/deduplication retention and outcome reconciliation first. No exactly-once promise.
Until this milestone is reviewed, offline calls continue to reject immediately.

M5 contract approved by the developer on 2026-11-13:
[offline queue and receipt ledger](superpowers/specs/2026-11-13-m5-offline-delivery-design.md).
The two named helpers above are opt-in; ordinary client calls still fail fast and uncertain calls
are never replayed. Queue/ledger storage is in memory only. Required count/byte/expiry/attempt and
retention budgets, caller-authenticated scopes, application-routed acknowledgements, cancellation
and read-only reconciliation are defined in that contract. No transport version/procedure, error
code, connection default, package entry path or dependency changes. Durable/multi-process delivery
requires a separate reviewed contract and is not implied by M5.

### M6 — React and TanStack integration (follow-on)

Optional `/react` entry with React peer and Query integration only after actual consumer needs are
known. Keep hooks independent of product storage and state; no visual UI. Root/client imports stay
free of these optional peers. Review additions to the export/dependency contract before coding.

M6 contract and exact dependency proposal approved by the developer on 2026-11-13:
[React/Query hooks](superpowers/specs/2026-11-13-m6-react-query-design.md) and
[dependency ledger](m6-dependency-proposal.md). Exactly the three hooks above are added to /react.
Queries are manual; mutations explicit. No automatic connection ownership, query retry/refetch,
M5 enqueue, cache persistence or stream-to-cache buffer is introduced. The caller owns identity,
QueryClientProvider and connection lifecycle. Optional peers/dev pins, isolated package/build and
size gates are specified in the approved documents. Existing contracts/defaults remain unchanged.

## 9. Required verification scenarios

Write meaningful adjacent unit tests plus actual adapter integration fixtures:

- Handshake: missing/expired/revoked token, rejected origin, absent Origin policy, malformed/oversize
  hello, incompatible transport/application versions, two hellos and concurrent unauthorized call.
- Calls: inferred input/output/errors; abort before send and during handler; deadline; disconnect
  after a mutation commits but before response, proving no replay and OUTCOME_UNKNOWN.
- Streams: first item, completion, handler error, unsubscribe during connect/retry, slow consumer,
  overflow, repeated reconnect, resume cursor owned by app and explicit observable gaps.
- Lifecycle: concurrent connect/close, intentional shutdown, heartbeat failure, failed credential
  provider, retry exhaustion/reset, old socket completion and external invalidation of active work.
- Isolation: two independent server handles with distinct tokens, contexts and subscription data.
- Packaging: packed Node/browser/Expo client imports; no Node/React/Fastify imports in client bundle;
  no root-import socket side effects; server disposal leaves the caller's other Fastify routes alive.
- Hygiene: no tokens in URLs/errors/logs/snapshots; no leaks after repeated connect/close cycles.

Developer-facing scripts to establish in M0: `lint`, `typecheck`, `test:coverage`, `build`, `size`,
`check:exports`, `docs`, `playground:smoke`, `fixtures`. These names are planned, not currently runnable.
Do not silently substitute smoke/compile checks for the required real-device and stress evidence.

## 10. Progress

Update this section after each task; never infer verification from source presence.

| Milestone | Written | Developer/CI verified | Branch / evidence / remaining work |
|---|---|---|---|
| Specification and agent instructions | Yes | Documentation inspection only | Initial baseline; no manifest, code or runtime evidence |
| M0 scaffold / compatibility | Scaffold written; gate open | Lint/typecheck only | `feature/m0-scaffold` from local `dev` at `fd93759`; approved pins installed by developer and lockfile present. Initial version unset/private. Public generic/context compile fixtures pass; build/export/runtime/stream-bound acceptance remains open. |
| M1 authenticated calls | Public factories/integration and tests written; gate open | Lint/typecheck only | createRpcClient/createRpcServer/registerRpcWebSocket, guarded context/hello, safe transport-error mapping, Fastify origin/parser/path/disposal handling and loopback playground written. Public inference fixtures pass. Runtime tests/playground and compatibility acceptance remain required. |
| M2 streams / lifecycle | Client-handle foundations written; gate open | No | Finite retries, heartbeat, epochs, managed opt-in resubscription/gaps, retained iterator cancellation and pre-peer stream accounting written to implement the complete public handle. Stress, cleanup, lifecycle and platform acceptance remain unverified; not a completed M2 delivery. |
| M3 consumers / first slice | Consumer/playground/stress/release-tooling source written; gate open | Source compile/lint only; runtime pending | Packed Node/browser runner, declaration fixtures, Expo device probe, real browser playground, native stress scenarios, CHANGELOG/acceptance docs and pinned shared CI/hooks written. No packed install/build/browser/native/stress/coverage/CI execution; initial version and all runtime/device gates remain open. |
| M4 multi-server / binary helpers | Approved helpers, tests and consumer examples written; gate open | Compile/lint only; runtime pending | createRpcClientGroup/chunkBinary added only to /client under the approved contract. Typed fixtures preserve heterogeneous schemas/required context. Lifecycle/binary/encoded-limit/runtime/device and packed acceptance remain unrun. |
| M5 offline queue | Approved queue/ledger source, tests, fixtures and examples written; acceptance open | Lint/full source typecheck pass on Node 22.22.3 | `feature/m5-offline-delivery` from local `dev` at `dd2b5a3`; tests/runtime/packed/device acceptance remains open. Ordinary calls remain fail-fast; uncertain commands are reconciled without replay. |
| M6 React / Query | Approved hooks/tests/build/consumer/example source written; acceptance open | Lint/full source typecheck pass on Node 22.22.3 | Current feature/m5-offline-delivery retained with M5 edits. Approved dependencies and updated lockfile were already present for follow-up. Runtime/build/packed/browser acceptance remains open. |

The entries below are chronological task records; the table above describes current status.
Private initial version 0.1.0 is selected and unpublished. Chronological entries below retain past
states/evidence; older M0–M4 table rows need reconciliation with their later verification entries.
No current M5/M6 acceptance is inferred from earlier runs. No checks ran at initial spec creation.

M0 update (2026-11-11): see [dependency proposal](dependency-proposal.md),
[compatibility review](transport-compatibility.md) and
[implementation plan](superpowers/plans/2026-11-11-m0-scaffold.md).
Registry metadata and published package sources were inspected without installing or executing
them. At that initial review there were no npm scripts. No implementation checks were run.

After the developer's dependency approval, the approved pins were added to package.json.
Written files now include root error/lifecycle/options types, separated client/server/Fastify
entry boundaries, shared tooling configs, private fake-socket harness and adjacent tests,
upstream transport compile fixtures, package inspection scripts/tests, README and error notes.
Exact existing scripts: `lint`, `format`, `typecheck`, `test`, `test:coverage`, `build`, `size`,
`check:exports`, `docs`, `fixtures`. `playground:smoke` is not present; a real playground is later work.

Developer-run evidence: **none**. No installs, lockfile generation, lint, typecheck, test, build,
size/export/doc/fixture checks or application servers were run by the agent. Source self-review
only; no sub-agents, commits, pushes or PRs. Initial version remains a developer decision and is
unset; the incomplete manifest is private. M0 must resolve the recorded upstream buffering,
disposal and safe error-handling gaps and obtain actual gate evidence before M1. Public option
field names/type mapping are written for that M0 review, not claimed compile-verified or frozen.
No defaults, error codes, wire contract or runtime support requirements were changed.
At the end of that M0 task, M0 was not complete and M1–M6 had not started.

M1 start (2026-11-11, subsequent developer instruction): private source and tests are now written
in `src/core/{handshake,operation,socketLimits}.ts`, `src/server/{session,peer}.ts` and
`src/fastify/originPolicy.ts`. See the [M1 plan](superpowers/plans/2026-11-11-m1-authenticated-calls.md)
and updated compatibility/dependency notes. The request authorizes M1 source work, not a claim
that the M0 gate has passed. All public barrels, dependency pins and package version are unchanged.
No new runtime dependency was added. No installs, implementation commands, tests, servers or
playgrounds ran; review was source-only without sub-agents. Developer-run commands available for
this slice are `npm run lint`, `npm run typecheck` and `npm run test:coverage` after installation.
M1 is not complete; public integration, open compatibility decisions and actual acceptance
evidence remain required. M2–M6 have not started.

M1 client follow-up (2026-11-11): after explicit approval, @orpc/standard-server-peer 1.16.2 was
added as a direct runtime pin. `src/client/peerClient.ts` and `src/client/connection.ts` now compose
stable ClientPeer + StandardRPCLink for private typed unary calls, reserved hello, ready gating,
deadlines/cancellation, safe snapshots, listener cleanup, explicit fresh attempts and conservative
OUTCOME_UNKNOWN without replay. Hello reply validation, safe close-code handling, fake socket-pair
support, adjacent tests and owned-client/context compile fixtures were added. Public barrels,
default requirements, error-code set, wire contract and runtime support remain unchanged; no
experimental peer or private upstream field is used. This does not implement the public stream
handle, automatic retry or heartbeat, and does not establish per-stream queue bounds.

Developer-run evidence remains **none**. No dependency install, lockfile generation, lint,
typecheck, test, build, size/export/fixture run, server or playground was executed. Source review
only; no sub-agents, commits, pushes or publication. Exact available source checks after developer
installation: `npm run lint`, `npm run typecheck`, `npm run test:coverage` (typecheck includes the
compile fixture). The initial version and all milestone acceptance gates remain developer-owned.
M1 remains incomplete; M2–M6 have not started.

Public integration follow-up (2026-11-11, developer requested implementation of the pending
factories/Fastify/bounded-stream work): `src/client/createRpcClient.ts`,
`src/server/createRpcServer.ts`, `src/fastify/registerRpcWebSocket.ts` now implement the three
documented public exports. Related source includes `fastify/nodeSocket.ts`,
`server/serverBinding.ts`, `client/peerQuota.ts`, `core/{iteratorLifetime,limits}.ts` and updates
to peer/session/connection lifetime handling. Required auth context is mapped through upstream
router middleware; reserved-name collisions and safe transport error mapping are implemented.

The public client includes the full specified handle rather than a unary-only public substitute.
This entails M2 foundations: finite full-jitter retries, reserved heartbeat, connection epochs,
opt-in managed resubscription/gaps, unsubscribe and iterator abort lifetime. The stream strategy
meters public-codec events before ClientPeer queues them, using only upstream-generated IDs and
upstream abort encoding. Local response annotations never go onto the network. A separate raw
decoding backlog cap is connection-wide. No memory-bound or passing-compatibility claim is made;
see the current follow-up in [compatibility](transport-compatibility.md).

Written tests cover public hello/context/typed errors, factory laziness/shared connect, retry
credential reads, terminal auth rejection, resubscription gaps, reconnect shutdown, expiry during
stream consumption, capacity release, overflow isolation, binary codec preservation, Fastify origin
rejection/duplicate paths/host preservation and concurrent server close. Public compile fixtures,
browser-only tsconfig, API doc entrypoints and installed browser graph inspection were extended.
`playground/smoke.mjs` imports built public entries and performs a real loopback fake-token exchange
when the developer runs the new existing script `npm run playground:smoke` (build then smoke).

Branch remains `feature/m0-scaffold`. No dependencies were changed in this follow-up; existing
approved pins remain. No initial version decision, install, lockfile generation, lint, typecheck,
test, coverage, build, size/export/doc/fixture check, playground or application server ran.
Review was source-only, without sub-agents. No commits, pushes, PRs or publication. Exact
developer-run commands after installation: `npm run lint`, `npm run typecheck`,
`npm run test:coverage`, `npm run build`, `npm run playground:smoke`, `npm run size`,
`npm run check:exports`, `npm run docs`. Version selection precedes packed-package checks.

Final source review changed tsdown to the confirmed shared preset's neutral multi-entry graph,
keeping every export path unchanged. This avoids duplicate RpcError classes across platform builds
and preserves the shared server-binding WeakMap; Node built-ins remain external. The smoke asserts
cross-entry error identity, and size inspection includes shared chunks. @orpc/shared's existing
radash runtime re-export is included in the graph inspector's allowlist; no manifest dependency was
added. Fastify preClose cleanup is queued before an owned WebSocket plugin's shutdown wait.

Remaining decisions/evidence: initial package version; agreement on any additional non-loopback
local ws option (current validator permits remote wss and loopback ws only); compile-tested generic
router/auth composition; runtime/slow-peer/memory stress and lifecycle acceptance; M3 packed browser,
Node and device consumers. M0/M1/M2 gates are open; M3–M6 are not implemented by this follow-up.

Lint follow-up (2026-11-11): the developer explicitly authorized `npm run lint` and fixing all
reported issues. The initial run reported 36 errors and one warning. Biome's safe write mode
formatted/organized 29 files across source, adjacent tests, fixtures, scripts and JSON configs.
The playground's console success message now uses process.stdout.write, retaining safe CLI output
without suppressing the shared noConsole rule. No dependency, public contract or lint rule changed.

Fresh verification: `npm run lint` exited 0, checked 56 files, applied no fixes and reported no
errors or warnings. README and this progress record were then updated; the final lint rerun is
recorded in the task handoff. A lockfile/dependencies were already present at the start of this
follow-up; the agent did not install them. No typecheck, tests, build, playground, size/export/docs
or fixture commands were run. Milestone acceptance gates remain open. Branch is unchanged;
no commits, pushes or PRs.

Typecheck follow-up (2026-11-11): the developer explicitly authorized `npm run typecheck` and error
fixes. Corrected the private control-client object from an interface to a type alias so it satisfies
upstream NestedClient without an index-signature cast; explicitly typed the internal disconnect
code; preserved the socket's readyState literal union in the Node bridge and test helpers; added
the public tsdown UserConfig annotation for portable config inference; and imported the fixture
application as a runtime value where public server composition uses it. No any casts, weakened
router inference, public contract changes or dependency changes were introduced.

Fresh `npm run typecheck` exited 0: production, browser-without-Node-ambient-types, test/script/config
projects and the separate transport inference fixture all completed. Positive/negative public
input/output/error/stream/context fixtures now have compile evidence, including required auth and
per-call context. This does not establish runtime behavior, packaging or memory bounds. README
was updated and lint rerun after these changes. No runtime tests, builds, playgrounds, size/export
or API-doc commands ran. Milestone runtime/compatibility gates remain open; no commits or pushes.

M3 source start (2026-11-12, explicit developer instruction): see
[implementation plan](superpowers/plans/2026-11-12-m3-consumers.md) and
[acceptance/evidence matrix](acceptance.md). The existing branch is retained. This advances M3
source without asserting that M0–M2 runtime gates passed or that Phase 03 is unlocked.

Written files include `playground/router.ts`, `server.mjs`, `dev.mjs`, `browser/{index.html,main.ts}`
and a playground typecheck project. The router demonstrates typed input/output/errors and paced
finite events; the browser provides connect/call/subscribe/unsubscribe/close. Vite preserves the
exact permitted loopback Origin while proxying to the ephemeral Fastify endpoint. Example credentials
remain fake; no Workbench schema, authentication store or native/runtime dependency was introduced.

`fixtures/consumers/` adds public-only Node/browser clients and positive/negative declaration tests.
`scripts/{checkConsumers,consumerChecks}.mjs` and adjacent helper tests implement pack-file guards,
isolated consumer installation outside the repository, declaration compilation, native Node RPC,
browser graph/dynamic-chunk auditing and a 150 KiB complete-JS gzip fixture budget. Source seams
are typechecked separately; packed checks generate their own configs with no source aliases.
When explicitly run by the developer, the runner retains the exact tarball SHA-256, version,
consumer lockfiles, browser output/graph and command evidence in gitignored fixtures/.artifacts.
No initial version is invented: the runner fails clearly until the developer selects one.

`fixtures/expo/runDevice.ts` is a real runtime probe to invoke in an existing Expo app; it adds no
React/native dependencies here. The device guide requires the same actual artifact on physical
Android/iPadOS, reachable wss, compatible native socket types, safe result capture and separate
reconnect/background/unsubscribe observations. Its source compilation is not device evidence.

`src/client/transportStress.test.ts` adds native malformed/oversize-peer isolation, slow stream
item/byte cases with healthy calls/streams, independent handles and 30 fake lifecycle cleanup cycles.
`scripts/stressTransport.mjs` implements a finite 35-cycle native workload and GC memory samples,
with incomplete evidence on failure. Its 32 MiB retained heap/external regression envelope is not
a proof of exact stream/process memory bounds. All new runtime tests/stress remain unexecuted.

README now includes setup, state diagram, delivery/cancellation/cleanup/gap policies, target runtime
support and migration notes; CHANGELOG is unreleased. TypeDoc retains all four public entries.
lefthook.yml extends the installed config 1.2.0 preset without adding/installing a Lefthook binary.
PR CI targets dev and reuses the shared workflow at confirmed remote main commit
7f7144a23e065ec064c56c7920c88d32c61cc7ce; its exact workflow_call interface was inspected from Git.
The supplemental job covers packed consumers, stress and docs with artifact retention. Private
shared-workflow access remains owner configuration; no workflow was pushed or triggered.

No new dependencies, version/license selection, release automation, tokens, tags or publication.
New actual scripts: `playground`, `check:consumers`, `test:stress`; full typecheck now includes the
playground and source consumer/device probes. Previously authorized lint and typecheck are the
only implementation commands executed during this M3 task; final results are recorded in its
handoff. No installs, unit/coverage tests, build, packed checks, browser/server/playground/stress,
device, size/export/API-doc or CI commands were run. No sub-agents, commits, pushes or PRs.

Remaining gate evidence: initial version and release license/metadata decision; full coverage and
all M0–M3 runtime/build/package/size/export checks; actual Android/iPadOS records; slow-peer/memory
verification and Phase 01 integration prerequisite. M4–M6 remain untouched follow-ons.

M3 verification (2026-11-12): the expanded `npm run typecheck` exited 0, covering production,
browser, test/script/config, playground and both transport/source consumer/device fixture projects.
The new Node fixture uses upstream safe to retain its declared error union; no any/cast workaround.
Final `npm run lint` exited 0, checked 76 files, applied no fixes and reported no diagnostics.
These checks provide compile/lint evidence only. No new dependency install, runtime test, build, packed consumer, browser/server, stress,
device, size/export/docs or CI run occurred. All milestone runtime gates remain open.

M4 start (2026-11-12, developer requested implementation): inspected current handle/entry contracts
and M4's explicit requirement for reviewed contracts. Created the concrete
[M4 contract proposal](superpowers/specs/2026-11-12-m4-contracts.md): two proposed /client functions,
typed static group ownership/lifecycle/limits and pull-based binary chunks with explicit total
budget, local progress, cancellation and error behavior. This is proposed, not an approved extension
of the public contract. AGENTS requires approval before exports/types/default semantics change.

Added `src/client/independentHandles.test.ts` against existing APIs only: distinct router schemas,
credentials and application versions; separate session IDs/connect calls; targeted revocation and
shutdown leaving the sibling usable. The source typecheck passes; this runtime test was not run.
No production code, public barrels, dependency pins, wire contract or defaults changed. Approval of
the concrete design is required before implementing the new API; lint/typecheck remain the only
authorized executed checks. M0–M3 runtime evidence and M5–M6 remain unaffected/open. No install,
build, test execution, publication, agents, commits, push or PR.

M4 implementation after explicit developer approval (2026-11-12): approved the linked contract and
wrote `src/client/{createRpcClientGroup,groupSnapshot,chunkBinary}.ts`, adjacent group/binary tests,
and exactly the two new /client exports. Root/server/Fastify and the package export map are
unchanged. No dependencies, existing options/defaults/errors/wire/auth semantics were changed.

The group copies/freezes a validated 1..32-handle registry, projects only safe snapshot fields,
isolates observer failures, preserves child types and owns per-child connect/close promise sharing.
Connect failures and all-settled reports expose safe codes; one failed child does not roll back a
healthy sibling. Named close is terminal for that child; whole close commits before callbacks,
starts every child cleanup synchronously, awaits all cleanup attempts and emits a final snapshot.
No additional retry/heartbeat/failover/stream owner or automatic call routing/replay was introduced.

The binary iterator validates input budget/options synchronously, copies bounded view/Blob slices
on demand, serializes requested pulls without a produced-data queue, awaits local progress and
suppresses late reads/callback results after cancellation. Return interrupts uncooperative pending
work. Native read failures are sanitized; application progress failures retain their identity.
Local EOF is the completion linearization point: abort during its completion notification can
release that observer wait without undoing already-committed EOF. A callback cannot retract a
progress event it has already observed; no completion event is emitted for failures before EOF.
Caller-retained input/output and wire encoding overhead remain outside the raw chunk-byte bound.

Source/packed fixtures now cover distinct child schemas, required per-call context, exact names,
readonly registry/progress and binary output. Node/browser examples use the group and helper;
the application-owned example binarySize procedure demonstrates upstream Blob encoding, not a
library transfer protocol. An adjacent peer test checks that encoded frame limits still reject
messages whose raw chunks fit their helper budget. The Expo probe distinguishes local binary
bytes from opt-in native binary RPC (verifyBinaryRpc), which remains unverified on actual devices.

Tests were written first but not executed, per AGENTS. Source review covered safe config accessors,
typed-array override/copy isolation, async lifecycle error sanitization, shutdown/observer races
and early-return/late-read cancellation. Expanded typecheck and lint are the only executed checks;
final outputs are recorded in the handoff. Runtime/coverage/build/size/export/packed/browser/native
checks and earlier milestone gates remain open. No installs, agents, commits, pushes or publishing.

M4 verification: expanded `npm run typecheck` exited 0, including production/browser, tests/tools,
playground, transport and source/packed-consumer/device inference projects. `npm run lint` checked
82 files with no remaining diagnostics after formatting; the final plain run is recorded in the
handoff. These are source compile/lint checks, not a packed consumer or native execution result.
Existing emitted/complete-browser size budgets and TypeDoc public entry coverage are unchanged;
actual size/build/API-doc/runtime/coverage results remain developer-run and unverified.

Verification/PR task (2026-11-12): the developer explicitly authorized remaining commands, commit,
push and a PR into dev. Actual local Node is v22.22.3 (Windows), not the target Node 24. Coverage
passed all 21 files/131 tests with 89.73% source lines; this includes M4 group/binary, real socket
malformed/oversize/slow-peer and repeated cleanup cases. Lint/typecheck, ESM/declaration build,
size budgets (all emitted JS 22.4 kB gzip), TypeDoc, loopback smoke and 35-cycle native stress passed.
Direct dist/import graph/WebSocket import-isolation inspection also passed. Build deprecation and
TypeDoc warnings were corrected without adding exports or weakening validation/budgets.

Both packed commands were attempted and failed specifically because no initial package version
was selected: publint/npm pack in check:exports, and the explicit guard in check:consumers. Approval
was requested for private initial 0.1.0 and portable official Node 24.22.3 verification; neither
decision was assumed. No version bump/download/new dependency was performed without approval.
The playground server/HTML/browser-module HTTP checks passed; browser host/native UI pipe were
unavailable, so no browser-button or physical-device execution is claimed. Android/iPadOS remain
pending. Full exact results/limits are in [verification record](verification-2026-11-12.md).

The requested delivery is prepared as a draft PR with these explicit blockers, not a release or
completed first-slice acceptance. Personal editor preferences/generated outputs/local logs are
excluded. Branch remains feature/m0-scaffold from dev; no main/dev merge, publishing or tag.

Commit 815f3a5 was pushed and draft PR #1 was verified OPEN with base dev. Its initial CI attempt
failed before any jobs. GitHub metadata confirmed this repository is public, the shared-config
repository is private and its Actions access level is none. CI now uses a self-contained Node 24
OS-matrix job invoking approved package scripts/shared published presets. No private workflow
source was copied, access granted or repository visibility changed. The supplemental consumer/
stress/docs job is retained. This supersedes the earlier remote-call plan; CI success is not
assumed. Version selection remains outstanding.

The corrected CI then executed core Node 24 checks successfully on Linux/macOS through coverage,
build and size; export packing failed at the known unset-version guard. Windows lint exposed
CRLF checkout differences. Added repository .gitattributes to keep text LF on all OSes while
preserving shared Biome rules. Target runtime core evidence is now available from CI; packed,
full-matrix, browser/device and complete acceptance evidence are still not assumed.

PR #1 CI fix (2026-11-12): inspected head 0650902 and Actions run 43158038844.
All three Node 24 OS jobs pass lint, typecheck, coverage, build and size, then fail at
check:exports because npm pack requires a package version. The consumers job is skipped
through needs: checks. Windows LF checkout handling now passes.

After the proposed initial private 0.1.0 and delivery action were presented, the developer
directed fixing, committing and pushing with all checks on GitHub only. Added initial version
0.1.0 to package.json and both root lockfile metadata records; private remains true. No
dependency, public API, workflow check or acceptance gate was changed. No local implementation
checks ran for this fix. GitHub results are pending developer review; packed consumer/runtime
success and full milestone acceptance are not claimed. No publication, tag or release.

PR #1 consumer follow-up (2026-11-12): run 43235309171 at fc8a291 passes all three
Node 24 OS jobs, including packed export checks. The isolated Node consumer compilation fails
with TS2307: @orpc/shared 1.16.2 declarations import @opentelemetry/api unconditionally, but
upstream marks that peer optional and the clean install omits it. Proposed direct dependency
@opentelemetry/api 1.9.0 (Apache-2.0, approximately 1.22 MB unpacked, no dependencies) awaits
developer approval. No local implementation checks or installs ran. Consumer/browser/stress/docs
success is not established by this run.

Enabled include-hidden-files on the consumer artifact upload: its existing .artifacts directory
was excluded by the action default, so even retained failure evidence was not uploaded. The
upload remains restricted to fixtures/.artifacts and retains the existing 14-day policy.

Consumer fix delivery (2026-11-13): following the dependency proposal, the developer directed
commit and push. Added @opentelemetry/api 1.9.0 as a direct runtime dependency with matching
registry integrity/license/engine metadata in the lockfile, without a local install. This
satisfies the upstream declaration dependency for isolated consumers while preserving
skipLibCheck:false and the existing public/wire contracts. The artifact-upload correction is
included. No local checks ran; GitHub verification remains pending developer review.

M5 start (2026-11-13, developer requested a new branch from dev and implementation): verified a
clean checkout on local dev at dd2b5a3, then created feature/m5-offline-delivery. Read the current
client lifecycle/cancellation/server contracts and M5's requirement to specify delivery semantics
first. Wrote the concrete [M5 contract proposal](superpowers/specs/2026-11-13-m5-offline-delivery-design.md)
for a separate bounded in-memory queue, application-routed acknowledgements, authenticated scoped
server deduplication/retention and reconciliation without automatic uncertain-call replay.

The proposal is not approved and does not extend the locked public contract. AGENTS requires
approval before exports/types/default/delivery semantics change. No production code, public
barrels, manifest, lockfile, wire/auth contract or existing defaults changed. No dependencies,
sub-agents, implementation checks, commits, push, PR or publication. Review of the concrete
proposal is the next gate; M5 is started, not implemented or accepted. M6 remains untouched.

M5 implementation after explicit developer approval (2026-11-13): added exactly
createRpcOfflineQueue to /client and createRpcDeliveryLedger to /server under the approved linked
contract. Source is in src/client/createRpcOfflineQueue.ts, src/server/createRpcDeliveryLedger.ts
and private src/core/delivery.ts boundaries. No dependency pins, package entry paths, transport
frames/version/reserved methods, stable error codes, existing client options/defaults or native
runtime promises changed. The initial package version remains private 0.1.0.

The queue copies bounded encoded commands, dispatches unsent work FIFO only while authenticated
ready, owns one nearest-expiry timer, and distinguishes cancellation/expiry/close before and after
invocation. Uncertain work is retained for read-only reconciliation once per new ready epoch or
explicit lookup; missing status never authorizes resubmission. A callback ignoring abort keeps a
serialization fence until settlement, without preventing local ticket expiry/close. Safe frozen
snapshots omit payloads/credentials. The borrowed connection retains connect/retry/close ownership.

The ledger reserves input/identity/metadata and maximum result bytes before mutation, joins live
scoped duplicates, rejects conflicting payloads, pins running work and retains bounded receipts or
uncertain tombstones. Raw handler errors are propagated to active callers but not retained in
settled ledger task references. Ledger-owned shutdown is separate from a single RPC observer's
abort; wrappers must authenticate/authorize scope and explicitly opt into that execution lifetime.
No filesystem/database persistence, cross-worker deduplication or exactly-once promise is added.

Adjacent boundary/queue/ledger tests and a real Fastify/oRPC lost-response-after-commit integration
test are written. The latter closes the actual socket before the command handler returns and
reconciles on reconnect; another identity's status lookup cannot retrieve the first receipt.
These are unrun test sources. Public/source/packed declaration fixtures cover required per-call
context and typed queue inputs/results. Node/browser examples, the isolated consumer runner and
Expo probe include application-defined command/status flows. Helper Uint8Array data is mapped to
validated number arrays at the application wire boundary; installed oRPC 1.16.2 has no built-in
typed-array JSON serialization tag. Physical Android/iPadOS/browser behavior remains unverified.

README, CHANGELOG, error/compatibility/acceptance notes, the approved design and implementation
plan record exact contracts, byte accounting, limitations and pending evidence. Source self-review
and read-only git diff inspection were performed; npm run format was used on the explicit changed
source/config files. No M5 lint, typecheck, tests/coverage, build, playground/smoke, size/export,
packed-consumer, stress, TypeDoc, CI or device command ran. Existing scripts for developer-run
verification are npm run lint, npm run typecheck, npm run test:coverage, npm run build, npm run size,
npm run check:exports, npm run check:consumers, npm run test:stress, npm run playground:smoke and
npm run docs; manual browser/device observations remain separate. See docs/acceptance.md for M5
cases. All M5 acceptance gates remain open. Branch feature/m5-offline-delivery; no install,
sub-agents, commits, pushes, PRs, tags, release or publication. M6 is untouched.

M6 start (2026-11-13, developer requested implementation): inspected the spec, existing borrowed
client lifecycle, query/stream examples and adjacent React 19 consumer manifests. Preserved all
uncommitted M5 source on feature/m5-offline-delivery; no branch switch, stash, commit or acceptance
claim. Wrote the concrete [M6 contract proposal](superpowers/specs/2026-11-13-m6-react-query-design.md)
and [dependency proposal](m6-dependency-proposal.md). Proposed exactly useRpcSnapshot/useRpcQuery/
useRpcMutation in an optional /react entry, with manual queries, explicit mutations, isolated cache
identity and no connection ownership, automatic replay or product storage/UI.

Official npm metadata and exact published Query 5.107.1 source were inspected read-only; Context7
references covered external-store snapshots, SSR/hydration, retries and network/cancellation
behavior. Six direct peer/dev dependency candidates include exact versions, roles, licenses and
approximate unpacked sizes. No new dependency, manifest/lockfile, production source, public barrel,
export map, build config, wire/auth/default/runtime contract or size gate was changed by this start.
Approval is required under AGENTS before those concrete additions. No installs, implementation
checks, sub-agents, push/PR or publication. M6 is started, not implemented or accepted; M5 and
earlier runtime/browser/device acceptance gates remain open.

M6 implementation after explicit developer approval (2026-11-13): wrote
src/react/{index,queryIdentity,useRpcSnapshot,useRpcQuery,useRpcMutation}.ts, adjacent real
ReactDOM/jsdom hook tests and the private core/testing/reactHarness.ts utility. /react exports
exactly the three approved hooks; root/client/server/Fastify barrels and transport/auth/error/
connection defaults are unchanged. Snapshot uses cached external-store state and stable idle SSR/
hydration state. Query reads are manual-only, with explicit no-retry/no-refetch/no-pause policy,
empty initial/placeholder data and a fixed upstream hash. Mutations use public MutationObserver
per effective key to avoid old-handle render data; explicit caller actions retain typed variables/
outputs and original unknown errors. No any proxy or invented Promise rejection inference.

package.json contains the exact approved six dev pins and optional React/Query/type peers/meta.
No install or lockfile resolution ran: developer npm install must regenerate package-lock before
npm ci/CI or checks. The unchanged old lockfile does not establish the new dependency graph.
tsdown adds the optional neutral entry, explicit external peers and a targeted use-client banner;
package inspection requires that first directive and exactly five subpaths while preserving the
strict root/client graph allowlist. Browser typecheck and TypeDoc include /react. The 10 kB React
entry and separate 300 KiB complete React consumer budget leave all existing budgets unchanged.

Packed runner source now creates isolated no-peer, Node, baseline-browser and React consumers;
the first three omit/assert absence of optional React peers. It compiles public declarations,
executes no-peer import and React SSR probes, and audits complete React/baseline graphs separately.
Required caller context and query/mutation input/output negative cases are written. The existing
Expo helper import is normalized through a sibling source seam so the copied probe resolves the
application helper inside its isolated consumer. No native dependency/support change is made.

playground/react provides caller-owned StrictMode/QueryClient UI with explicit connect/refetch/
mutate/close; existing dev runner selects it via --react. New actual script: npm run playground:react.
README, CHANGELOG, fixtures/playground guides, errors, compatibility and acceptance describe the
approved policy and limitations. New hook/package/graph/consumer tests are source only, unrun.
Source review is inline without sub-agents; only formatting/read-only diff inspection is performed.
No npm install, lint, typecheck, tests/coverage, build, size/export/consumer/API-doc checks,
playground/server/browser/SSR execution, CI, commits, push, PR or publication. All M6 acceptance
gates and remaining M5/earlier platform acceptance remain open on feature/m5-offline-delivery.

M5/M6 lint/typecheck follow-up (2026-11-13): the developer explicitly authorized both commands and
fixing all reported issues. Approved dependencies and a modified package-lock were present at
task start; no agent install, lockfile edit, new dependency or version change was needed. Actual
local runtime is Node v22.22.3; target Node 24 runtime acceptance is separate.

Initial lint reported four errors and two warnings. Replaced optional-chain warnings, organized
the Query import, moved React test probes to module scope and memoized mutation keys/options.
Typecheck exposed Query 5.107.1's conditional mutation-argument tuple versus the observer's required
argument. The adapter now accepts the exact upstream rest tuple and uses the same narrow
TVariables argument bridge as upstream useMutation; no any or router/output inference cast.
Public compile fixtures verify required mutation variables cannot be omitted while void variables
can be omitted. Corrected test-only ReactElement/unknown annotations and moved a multiline
@ts-expect-error directly onto the intentionally forbidden enabled property. No public contract,
wire/auth/default policy, shared preset or lint rule changed.

Fresh npm run lint exited 0: 108 files, no errors/warnings or applied fixes. Fresh npm run typecheck
exited 0 through production isolated declarations, browser, tests/config/scripts, playground and
both transport/consumer source fixture projects, including React/device probes. README/acceptance
records updated to distinguish these checks from runtime evidence. No unit/coverage execution,
build, pack/exports/size, consumers, stress, docs, playground/server/browser/device or CI run.
No sub-agents, commits, push, PR or publication. M5/M6 runtime acceptance gates remain open.

PR #2 consumer CI follow-up (2026-11-13): inspected run 43433335998 at bb869f8. All three
Node 24 OS jobs pass lint/typecheck/coverage/build/size/exports. The consumer job passes its
no-peer and Node probes, then fails loading Vite/Rolldown in the baseline browser consumer:
the runner's --omit=optional removed @rolldown/binding-linux-x64-gnu. React consumer, stress
and docs were not reached. This is an install-policy error in the fixture runner, not a package
transport or TypeScript failure.

Developer directed fixing, committing and pushing, with verification on GitHub only. The runner
now omits optional dependencies only for noPeers/Node probes and explicitly includes them for
browser/React builds. Existing optional React-peer absence assertions and all graph/size/type
checks remain enabled. No dependencies, public contracts, budgets or workflow gates changed.
No local install, lint, typecheck, tests, build, pack/consumer, stress, docs or server command ran
for this fix. GitHub results for the new commit remain pending; no CI pass is assumed.

PR #2 next consumer follow-up (2026-11-13): run 43434702330 at 707bee5 passes all three
Node 24 OS jobs plus no-peer/Node consumers and the baseline browser build (44.40 kB gzip).
The native-binding fix is effective. React consumer installation then omits TypeScript and fails
at require.resolve('typescript/bin/tsc'), before React compilation/SSR/build, stress or docs.

Root cause: the preceding in-process Vite production build sets process.env.NODE_ENV=production;
the next npm install inherits it and defaults to omitting development dependencies. Added explicit
--include=dev to every isolated consumer install. Existing optional-dependency distinctions,
React-peer absence assertions and all budgets/checks stay enabled. No dependency pins, root
lockfile, runtime/API behavior or CI gates changed. Continuing the developer-authorized fix/
commit/push flow; no local CI, install or implementation checks run. New GitHub results pending.
