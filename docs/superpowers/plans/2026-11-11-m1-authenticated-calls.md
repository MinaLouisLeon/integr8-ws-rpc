# M1 authenticated calls implementation plan

> Execute inline. AGENTS.md prohibits sub-agents and reserves all implementation commands for the
> developer. Test-first source writing does not constitute a verified red/green cycle.

**Goal:** Start M1 with the security and unary execution foundations, then integrate the public
factories after the open M0 transport compatibility decisions are settled.

**Architecture:** Zod validates hello before authentication. Each socket owns one session gate,
handshake deadline and cancellation lifetime; application calls acquire context through that gate.
Use oRPC 1.16.2's public router and adapter APIs for integration, never a parallel frame protocol.

**Tech stack:** Approved oRPC 1.16.2, Zod 4.6.7, strict TypeScript, Node 24 and shared tooling.

**Spec:** [SPEC.md](../../SPEC.md).

## Constraints and review focus

- Keep existing feature branch and all uncommitted M0 work; no installs/checks/servers or publication.
- No dependency or public contract changes without approval. Initial package version remains unset.
- Hello token bound is 8 KiB UTF-8, offered versions at most eight positive integers,
  transport version 1; select the highest common application version before auth context is exposed.
- Repeated/concurrent hello, late auth completion and callback rejection must not create a ready
  session or leak token/cause data.
- Expiry/revocation/caller abort/deadline must prevent further delivery and remove owned timers and
  listeners. Cancellation remains cooperative; no mutation rollback promise.
- No app handler runs before authentication; typed application errors pass through unchanged.

## Task 1: Hello validation / protocol negotiation

Files: `src/core/handshake.ts`, adjacent tests.

- [x] Write tests for wrong transport, malformed/missing token, exact/multibyte token bound,
  excess/invalid offered versions, highest-common selection and incompatible versions.
- [x] Implement internal `parseHello`, `validateProtocolVersions`, `negotiateProtocol` with typed
  RpcError failures. Validation happens before any authentication callback.
- [ ] Developer runs tests/typecheck; record actual results when supplied.

## Task 2: Abort/deadline execution boundary

Files: `src/core/operation.ts`, adjacent tests.

- [x] Write tests for pre-abort, deadline cancellation, late completion, application-error identity
  and parent-listener/timer cleanup on every settlement.
- [x] Implement internal scheduler and `runOperation<T>` that composes caller abort, owned session
  abort and optional deadline. No timers are started by importing.
- [ ] Developer runs tests/typecheck; record actual results when supplied.

## Task 3: Per-socket session / guarded unary execution

Files: `src/server/session.ts`, adjacent tests.

- [x] Write tests for concurrent hello, pre-auth calls, malformed auth results, auth deadline,
  late auth success, second hello, negotiated context, expiry/revocation and call capacity.
- [x] Implement private session gate with auth lock, safe errors and independent handshake timer;
  caller context becomes available only after successful validation/authentication.
- [ ] Developer runs tests/typecheck; record actual results when supplied.

## Task 4: Upstream composition and public transport integration (pending compatibility)

- [ ] Resolve bounded-stream peer strategy before claiming the M0 gate closed. The developer's
  instruction starts M1 source work; it is not evidence that M0 verification passed.
- [x] Write a server peer binding using public manual `message`/`close` to own event listeners
  and catch peer failures safely. Do not use the Node adapter's raw logError path.
- [x] Obtain direct ClientPeer dependency approval, pin 1.16.2, and write an owned StandardLinkClient
  adapter with inbound error handling, caller cancellation, byte/capacity limits and disposal.
- [x] Write the private typed unary connection with hello validation, ready gating, concurrent
  connect sharing, deadlines, close races, safe state observers and uncertain-outcome mapping.
- [x] Write owned-peer/connection integration tests and extend compile fixtures for required
  caller context as well as nested input/output/error inference. No execution evidence yet.
- [x] Write `createRpcServer`, `createRpcClient`, `registerRpcWebSocket` with preserved router
  inference and guards at every app entry; no substitute string-method/unknown-result API.
- [x] Write real upstream integration tests and loopback fake-token playground.
- [ ] Developer runs
  the M1 origin/token/version/hello-race/deadline/cancellation/uncertain-outcome acceptance cases.
- [ ] Record actual evidence in SPEC Progress. No claim of complete M1 before its gate.

## Additional first-slice source written

- `core/socketLimits.ts` and adjacent tests measure UTF-8/binary views/Blob frames and check
  next-send queue capacity before forwarding. Native parser and upstream queue bounds are not proven.
- `fastify/originPolicy.ts` and adjacent tests require an explicit policy, including absent Origin.
  They do not yet register a Fastify route or reject an actual HTTP upgrade.
- `server/peer.test.ts` uses real upstream RPCLink/RPCHandler with fake sockets: pre-auth app
  rejection, hello/context injection, typed app errors, malformed/oversize frame rejection and
  listener disposal. This source does not establish a passing integration or public wrapper.

## Execution record

Read-only review confirms the v1 browser-style server adapter exposes public manual message/close
methods with no internal logError call. This resolves the source-level listener/logging integration
choice, not its runtime evidence. Stream queue bounds and all M0 execution evidence remain open.
Keep first-slice modules private: no public export/signature/wire changes are required for them.

Checkmarks mean source written only. No implementation commands, tests or servers have run.
Source review added absolute-deadline checks (not just timer callbacks), sanitized callback/input
accessors, and checks after auth resolution so a closed/expired session cannot regain readiness.
No public client factory is exposed with the stock link's unobserved peer decoding failures.
At the end of the first M1 slice, the direct ClientPeer dependency was proposed but not yet added.

## Approved client integration follow-up — 2026-11-11

- Developer approval received for @orpc/standard-server-peer 1.16.2 as a direct runtime dependency.
  The manifest pin and dependency record were updated before using the package. No install/lockfile.
- New source: `src/client/peerClient.ts`, `src/client/connection.ts`, their adjacent tests and
  `src/core/testing/socketPair.ts`. Hello response parsing/tests were added to the core boundary.
- `src/core/rpcError.ts` gained an internal safe-code predicate; public root exports are unchanged.
  Internal server peer disposal/fake close events can carry a safe code so auth rejection is not
  erased by an unconditional CLOSED reason. No custom frame protocol was introduced.
- Source review addressed reentrant socket-factory close cleanup, absolute handshake deadlines,
  stale observer notifications and required per-call context. The generic upper bound is derived
  from the upstream createORPCClient return constraint; there is no any cast or untyped API fallback.
- Compile fixtures now include owned transport/connection factories and positive/negative required
  caller-context checks. All fixture functions remain unexecuted.
- Private connection choices are provisional: it has no automatic reconnect/heartbeat/managed
  streams and is not exported from `/client`. Public entry barrels remain unchanged until the
  remaining compatibility/public API gates are resolved. No M2 delivery is claimed.
- Written tests cover hello/typed app calls, application errors, cancellation, capacity, malformed
  frames, auth rejection, interrupted committed mutation, late credentials, old sockets and disposal.
  Developer commands: `npm run lint`, `npm run typecheck`, `npm run test:coverage` after installation.
- Ruling: keep the incomplete unary primitive private rather than expose an incomplete public
  handle or silently disable the spec's future reconnect/stream behavior. The cost is that public
  factory integration remains pending; no alternate contract is declared.
- Review was source-only and performed without sub-agents. No checks, servers or playgrounds ran;
  no commits/pushes/publication. Upstream per-stream queue bounds, full public factory/route/wire
  mapping and the runnable M1 playground remain open. M1 is not complete.

## Public factory integration follow-up — source only

The subsequent developer instruction authorized implementation of those remaining public pieces.
All three factory barrels now export the documented function. Fastify/native bridge/ownership code,
pre-peer exported-codec stream accounting, retained iterator lifetime and shared limits are written,
alongside public integration tests, public inference fixtures and playground/smoke.mjs.

The public client supplies its complete handle, including M2 retry/heartbeat/managed-subscription
foundations, rather than exporting a reduced unary substitute. This does not complete M2 or pass
the M0 compatibility gate. Source review found and corrected initial stream-marker re-encoding,
late-open cleanup and reentrant shutdown races. These corrections have no execution evidence.

Current authoritative progress and exact developer commands are in SPEC Progress and README.
All source checkboxes mean written only. No install, check, playground, server or sub-agent ran.
