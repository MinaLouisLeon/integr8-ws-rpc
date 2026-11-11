# @integr8-media/ws-rpc — implementation specification

Created 2026-11-11 for the repository folder `integr8-wc-rpc`.

**Status:** initial implementation baseline; no source, dependencies or runtime verification yet.
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
| createRpcServer | /server | Compose an application router with reserved handshake/health procedures and auth guard |
| registerRpcWebSocket | /fastify | Attach that server to a caller-owned Fastify instance and configurable path |

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

### M5 — opt-in offline delivery (follow-on)

Specify expiry, count/byte bounds, persistence ownership, cancellation, server acknowledgements,
idempotency keys/deduplication retention and outcome reconciliation first. No exactly-once promise.
Until this milestone is reviewed, offline calls continue to reject immediately.

### M6 — React and TanStack integration (follow-on)

Optional `/react` entry with React peer and Query integration only after actual consumer needs are
known. Keep hooks independent of product storage and state; no visual UI. Root/client imports stay
free of these optional peers. Review additions to the export/dependency contract before coding.

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
| M0 scaffold / compatibility | No | No | Dependency versions/roles and exact upstream type mapping pending |
| M1 authenticated calls | No | No | Not started |
| M2 streams / lifecycle | No | No | Not started |
| M3 consumers / first slice | No | No | Not started; Phase 02 gate pending |
| M4 multi-server / binary helpers | No | No | Follow-on |
| M5 offline queue | No | No | Follow-on |
| M6 React / Query | No | No | Follow-on |

No package version is selected, published or claimed. No tests, installs, builds or application
servers were run when these documents were created.
