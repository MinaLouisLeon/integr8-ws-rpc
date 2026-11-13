# M0 transport compatibility review

## M6 source extension — 2026-11-13

Approved optional /react entry adds React 19 external-store observation and Query 5.107.1 manual
reads/explicit mutations. Published Query/core source was inspected again: useQuery forwards an
execution signal and supports fixed policy options; MutationObserver is public, binds its mutate
method and updates/reset options by key. The wrapper uses a fresh observer per effective key to
avoid old-handle data before a reset effect, without owning a connection or changing oRPC 1.16.2.

Root/client graphs still forbid React/Query imports. The build keeps peers external and emits a
targeted React client directive. Packed no-peer declarations/imports and React SSR/browser graphs
have new source probes; they have not run. Exact approved dependency pins are in the M6 ledger;
the developer must install/regenerate package-lock. No new upstream transport adapter or wire
version, auth behavior, server/node floor or native support claim is introduced.

Manual hooks disable Query's retry, automatic fetch/refetch, offline pause, Suspense/render-prefetch
and previous/initial data defaults. Empty data functions and own undefined mutation scope are used
to satisfy exactOptionalPropertyTypes without any casts. Cache identity uses a private weak handle
ID and caller non-secret scope/input keys; no credential/session identifier is used. QueryClient
ownership, direct fetching/persistence APIs and application global callbacks remain caller policy.

## M5 source extension — 2026-11-13

The approved createRpcOfflineQueue and createRpcDeliveryLedger helpers compose caller-owned
application procedures and add no transport frames, reserved namespace methods, upstream private
API, error codes or existing default changes. The dependency line remains oRPC 1.16.2. Installed
client serializer source and ClientOptions declarations were inspected again for M5; Context7's
nearest indexed v1 docs are 1.14.6 and are not substituted for the installed 1.16.2 declarations.

Important boundary: StandardRPCJsonSerializer has Blob and ordinary array support, but no built-in
Uint8Array type tag. M5 helper envelopes contain typed arrays locally; the example's application
Zod schemas send bounded number arrays and map them back explicitly. No unsupported typed-array
round-trip, custom upstream serializer or binary/native support claim is introduced.

Ledger-owned execution deliberately outlives an individual RPC observer's abort. The application
must wrap only operations for which this lifetime is intended, derive scope from authenticated
context on every route and use ledger shutdown for cooperative cancellation. Existing Session
still aborts ordinary per-call observers/streams. No session/auth guard is bypassed.

Queue deadlines/expiry, process-local retention and the socket lost-response/status integration
have new test source, not new runtime evidence. Expanded source/packed/native probes remain unrun.
Older source-history statements below must not be interpreted as fresh M5 verification.

Reviewed 2026-11-11. **Source inspection only; not a passing compatibility gate.**
Approved release line: oRPC **1.16.2** for every directly used oRPC package (session approval).
Published npm archives for client, server, standard-server-peer and config were extracted in a
temporary directory for read-only inspection; nothing was installed or executed.

Current evidence update (2026-11-12): developer-installed dependencies/lockfile are now present;
lint and the expanded typecheck pass. M3 adds a real browser playground, isolated packed consumer
runner, Expo device probe and native stress scenarios. They have not run. See
[acceptance](acceptance.md) and SPEC Progress for current status; the earlier source-inspection
statements below are historical, not claims that no compiler command has since executed.

Approved M4 source extension: /client now exports createRpcClientGroup and chunkBinary. The group
uses original typed handles, no new socket or retry/routing protocol. chunkBinary uses platform
Blob/Uint8Array slices and the existing internal operation cancellation boundary. No Node/React/
native dependency enters the browser graph. The example application's binarySize procedure uses
oRPC 1.16.2's existing Blob encoding; raw helper byte size is deliberately separate from encoded
frame size. Source characterization tests and packed/native probes are extended, but no actual
binary/device/bundle-size result is claimed. All previously open platform/memory gates remain open.

## Public integration follow-up — source written, unverified

The public createRpcClient/createRpcServer/registerRpcWebSocket factories are now written using
stable ClientPeer, StandardRPCLink and the manual server handler. The sections below retain the
earlier source-review proposals/history; their pending-source statements describe those earlier
slices. No implementation commands or acceptance checks have run.

The compile fixture now includes the public client and server, with required-context rejection,
input/output/error inference and typed managed stream items. The client owns finite reconnect,
heartbeat and opt-in managed resubscription because these are part of its complete specified handle.
These foundations overlap M2; neither M1 nor M2 is verified or marked complete.

`client/peerQuota.ts` uses exported request/response codecs to inspect IDs generated exclusively
by ClientPeer. It generates no IDs, routes no procedures, reads no private queues and imports no
experimental peer. Before incoming events enter ClientPeer, per-ID item/encoded-byte accounting
checks both stream bounds. Overflow closes that upstream ID with a safe error and sends the
upstream codec's abort. Unrelated calls stay active; consumption releases counters.

Initial responses receive a temporary correlation header only on the local adapter-to-peer path,
stripped before RPC value decoding. It is never transmitted to the network. Re-encoding uses the
same exported codec, preserving binary bodies and restoring the initial stream header with an
inert iterator that emits nothing. Tests cover this path, binary responses, overflow and caller
abort after iterator delivery; they remain unrun.

Raw asynchronous decoding has a separate connection-wide frame/byte cap derived from configured
capacities. This is not per-ID accounting before decoding. Stress tests must establish total
retained memory, simultaneous-stream and consumption races. Source accounting does not close the
bounded-stream compatibility gate or establish the consumer's total memory footprint.

Fastify configures ws maxPayload and disables compression when installing the plugin; an existing
plugin must already have a sufficiently strict cap. Origin policy is mandatory, including absent
Origin. Owned native bridges have bounded graceful-close fallback. Disposal closes owned sessions
and retains a rejecting route, preserving the caller's host. Tests and the loopback built-entry
smoke example have not run. The smoke exercises shared server-binding identity across output chunks.

Public URLs currently permit remote wss and loopback ws, without user-info/query/fragment. An
additional non-loopback local ws option requires public-contract agreement. No such option, new
runtime support, new dependency or wire/default/error-code change was added.

Package inspection now traverses installed ESM imports for approved browser dependencies, rather
than rejecting every external import as the initial M0 scaffold did. It rejects unknown/Node
imports, CommonJS require, computed imports and unsupported exports/remapping. This conservative
inspection still needs packed browser/Node/Expo consumers in M3 and actual device evidence.

The build now uses the confirmed shared preset's neutral platform with one multi-entry graph.
Browser/Node export paths remain unchanged, and Node built-ins remain external. A single graph
preserves RpcError identity between root/client/server/Fastify and the server-binding WeakMap
between server/Fastify. The smoke asserts cross-entry RpcError identity; graph inspection follows
shared chunks for client isolation. Size configuration includes a total emitted-chunk budget so
shared files outside platform folders cannot disappear from the measured cost. All remain unrun.

## Version-specific upstream mapping and earlier review history

Use the [v1 WebSocket documentation](https://v1.orpc.dev/docs/adapters/websocket).
The [main documentation](https://orpc.dev/docs/adapters/websocket) and
[v2 migration guide](https://orpc.dev/docs/migrations/from-v1) describe a different API line.
Published 1.16.2 declarations are authoritative for this proposal.

| Concern | Observed v1.16.2 API | Package design consequence |
|---|---|---|
| Client link | `RPCLink<T extends ClientContext>` from `@orpc/client/websocket`; constructor takes `RPCLinkOptions<T>` | Create one link per socket epoch, only during connect |
| Socket shape | `websocket: Pick<WebSocket, 'addEventListener' \| 'removeEventListener' \| 'send' \| 'readyState'>` | A factory/adapter must satisfy the actual event signatures; do not assume Expo compatibility |
| Client inference | `createORPCClient<T extends NestedClient<any>>(link: ClientLink<InferClientContext<T>>, options?: createORPCClientOptions): T` | Keep the upstream inferred client intact; upstream `any` shown here is quoted, not permission to use it in wrapper code |
| Router inference | `RouterClient<TRouter extends AnyRouter, TClientContext extends ClientContext = Record<never, never>>` from `@orpc/server` | Type-only router mapping; no Node server value import in client |
| Call options | `ClientOptions<T>` has `signal?: AbortSignal`, `lastEventId?: string \| undefined`, `context: T` | Preserve per-call signal/context and typed error/iterator results |
| Node adapter | `RPCHandler<T extends Context>` from `@orpc/server/ws` | Do not substitute a v2 constructor or fetch handler |
| Node attachment | `upgrade(ws: Pick<WebSocket, 'addEventListener' \| 'send'>, ...rest: MaybeOptionalOptions<HandleStandardServerPeerMessageOptions<T>>): Promise<void>` | Await attachment; context comes through handle options; it is not an application handshake |
| Router constructor | `constructor(router: Router<any, T>, options?: NoInfer<StandardRPCHandlerOptions<T>>)` | Compose reserved namespace into a router; enforce session guard before app procedures |
| Peer cancellation | Client/server peer exchange abort messages; server handler passes request signal to procedure execution | Compose deadline/caller/session cancellation; verify actual propagation and cleanup in fixtures |

The client factory's generic is a client type, not a router type. Proposed router-first mapping:
`RouterClient<TRouter>` supplies the client type used by `createORPCClient`. The exact wrapper
signature remains pending a compile fixture; do not claim inference proof from declarations alone.

The compile fixture is now written under `fixtures/transport/`, but has not been run. It exercises
the published router/client mapping, session context guard, typed error data, AbortSignal, stream
items, ws handler attachment and Fastify plugin/ws types. It does not test a package wrapper yet.

## Feasibility findings and unresolved gates

1. **Router composition/auth:** pass a fresh mutable session cell inside each socket's context.
   Hello may update it only once; app middleware must read it for every invocation and reject
   unauthenticated/expired/revoked sessions. This is a proposal requiring a typed composition
   fixture and concurrent-hello/pre-auth tests. Snapshotting the principal at upgrade is inadequate.
2. **Reconnect:** inspected client/server WebSocket adapters do not implement reconnect or replay.
   The package can own epoch/reconnect policy, but must reject application sends before ready:
   the upstream client otherwise waits for a connecting socket to open. Do not enable RetryPlugin.
3. **Stream bounds are unresolved:** `ClientPeer` uses an internal event iterator queue and exposes
   no queue item/byte limit. A bounded observer queue after oRPC decoding cannot bound upstream
   buffering. No stable documented mechanism has been established for the spec's simultaneous
   256-item/1-MiB per-subscription bound. Do not implement a second multiplexer or parse private
   correlation IDs. Resolve through a supported upstream mechanism or an approved design/spec
   change before M1; experimental no-codec peers are not selected by this proposal.
4. **Payload/send limits:** the stock WebSocket adapters have no maxPayload/high-water option.
   Fastify/ws can enforce inbound Node payload limits; an owned socket facade could validate
   encoded send size and bufferedAmount before forwarding. Browser inbound frames also need
   checking before upstream delivery. Prove these at the actual boundary, including binary data
   and pre-auth limits; source inspection does not prove the configured guarantees.
5. **Disposal/logging:** the auto-attaching adapters return no disposer. The Node handler catches
   peer failures with upstream `logError(error)`. Further source inspection confirms the stable
   `@orpc/server/websocket` API has manual `message(ws, data, { context })` and `close(ws)` methods.
   `src/server/peer.ts` now owns listeners, bounds frames/sends, awaits/catches manual-message
   failures and removes listeners before closing the upstream peer. It does not call upgrade().
   Tests are written but unrun. On the client, stock RPCLink hides its peer and fires inbound
   peer.message without observing rejection. The direct stable ClientPeer dependency is now approved;
   private owned client composition is written under `src/client/`, with unrun tests. Per-subscription
   queue control remains unresolved.
6. **Platform support:** browser structural signatures are documented; Node ws support exists.
   Expo event compatibility, binary behavior and cleanup remain unverified on Android/iPadOS.
   Do not advertise device support based on a TypeScript fixture alone.
7. **Fastify ownership:** verify plugin-before-route registration, explicit origin predicate
   (including absent Origin), duplicate paths and disposed routes rejecting upgrades. No route
   removal or caller-owned-server shutdown behavior has been proven. See
   [Fastify's WebSocket plugin](https://github.com/fastify/fastify-websocket).

## Shared config mapping

Published `@integr8-media/config` 1.2.0 exports confirmed:

- `@integr8-media/config/tsconfig/library.json`: NodeNext, declaration and isolatedDeclarations.
- `@integr8-media/config/biome`: shared formatting/lint rules.
- `@integr8-media/config/vitest`: `integr8Vitest`, Node environment, 80% coverage threshold.
- `@integr8-media/config/tsdown`: `integr8Tsdown`; ESM `.mjs` / `.d.mts`, maps disabled.
- `@integr8-media/config/size-limit`: `integr8SizeLimit`.
- `@integr8-media/config/lefthook/base.yml`: available; hooks deferred to M3.

Use separate browser-safe root/client and Node server/Fastify build configurations; inspect preset
merge behavior before implementation. Do not run two clean builds that erase each other's output.
The sibling config repository has reusable `.github/workflows/pr-checks.yml` with Node 24 and
`os-matrix`, `node-version`, `site-build` inputs. Its npm archive does not ship workflows; a usable
remote ref/access still needs confirmation before wiring CI in M3.

## Initial size targets (proposed, not measurements)

Root emitted JS: 5 kB gzip; client entry: 20 kB gzip; server entry: 30 kB gzip;
Fastify entry: 10 kB gzip. Measure emitted files with the shared size preset/file plugin initially.
These exclude external dependencies and do not establish consumer bundle size. Add a packed browser
consumer budget after its tooling is approved; never report excluded externals as zero runtime cost.
The size config also caps all browser JS (including shared chunks) at 25 kB and all Node JS at 40 kB.
Published `@size-limit/file` 14.3.0 source was inspected: it defaults to Brotli. The config explicitly
sets `gzip: true` after applying the shared preset so these budgets consistently use gzip.
No size command or measurement has been run.

## Written scaffold boundaries

- package.json contains the approved pins, dist-only export targets and real script commands.
  Initial version remains unset pending the developer's choice; the scaffold is private.
- Shared presets are used directly. Browser and Node tsdown builds clean separate output directories.
- Root exports the spec's initial symbols; option field names and error construction are recorded
  in source/README for M0 review. Production `tsconfig.json` keeps isolatedDeclarations enabled;
  a separate check project includes tests, scripts and tool configs.
- Private FakeSocket implements the approved client socket shape with controlled open/close/late
  messages, listener inventory, once/abort removal and queued-byte accounting. No real timers/socket.
- Adjacent tests and package-inspection tests are written. No red/green or coverage run is claimed.
- M0 package inspection follows relative root/client import graphs, rejects external runtime imports
  in this initial dependency-free client scaffold, rejects private/test/source/map artifacts in dist,
  and imports the entries with global WebSocket access trapped. This must evolve with an audited
  upstream browser graph in M1/M3; it is not a general clean packed-browser-consumer proof.
- Public runtime factories and stream buffering remain absent. Private hello/auth/client-connection
  foundations are written below. No bounded-stream claim or experimental upstream API is introduced.

## Gate evidence still required

Compile-tested generic/guard composition, supported bounded-stream strategy,
safe error/disposal strategy, scaffold lint/typecheck/build/export results and developer review.
No compatibility fixture, browser bundle, device run, stress run or runtime check has been executed.

## M1 source start, authorized by the developer

New private modules (not added to package entry exports):

- `core/handshake.ts`: strict hello shape, token UTF-8 bound, application version negotiation.
- `core/operation.ts`: deadline/caller/session signal composition; late-result suppression and
  timer/listener cleanup, preserving original application failure identity.
- `core/socketLimits.ts`: encoded frame size and next-send high-water checks.
- `server/session.ts`: synchronous hello lock, independent handshake deadline, guarded context,
  expiry/invalidation lifetime and bounded unary calls. Internal timer values use 1..2^31-1 ms;
  internal maxInFlightCalls accepts 1..10,000 (default remains 100). Final public configuration
  validation/ranges require the M0/M1 API review; these modules are not exposed as public options.
- `server/peer.ts`: stable manual server handler integration with removable listeners and safe
  peer-failure codes. Native host parser limits, pre-auth ingress task/concurrency bounds and
  final session/router integration still need implementation; byte checks alone do not prove them.
- `fastify/originPolicy.ts`: explicit predicate, including absent Origin; no inferred allow-all.

Adjacent tests include an in-memory real RPCLink/RPCHandler exchange covering hello, a guarded
typed app call, an application error and malformed/oversize messages. It is test source, not a
passing fixture, runnable playground or proof of public wrapper behavior. Cancellation is
cooperative; active application work may commit after local cancellation. There is no replay layer.

No new public type/export/wire/default or runtime-support change has been made. Client/server/
Fastify public factories, final safe transport-error wire mapping, reserved namespace collision
checks, route ownership and the M1 playground remain pending.

## Approved M1 client integration — source written, not executed

- `@orpc/standard-server-peer` 1.16.2 was approved before adding it as a direct dependency.
  `ClientPeer` is the stable public wrapper; no experimental class/private queue field is imported.
- `client/peerClient.ts` implements StandardLinkClient<TContext>, observes inbound peer.message
  failures, owns removable message/close/error listeners, and validates encoded size/send capacity.
  Upstream still owns request IDs and frames. Its send callback closes the peer on failure instead
  of rejecting detached upstream cancellation callbacks. Caller cancellation reasons and arbitrary
  remote close reasons are sanitized; typed application ORPCError values are not wrapped.
- `client/connection.ts` supplies a private typed unary connection: no socket/timer at creation,
  one concurrent connect attempt, fresh credentials per explicit attempt, hello reply validation,
  ready gating, frozen safe snapshots, call deadlines, cancellation, explicit close and old-attempt
  cleanup. Once transport dispatch begins, a lost response conservatively yields OUTCOME_UNKNOWN;
  this may include ambiguous send/encoding races. No operation is queued or replayed.
- This private connection is not the complete public handle: it has no automatic retry, heartbeat
  or subscribeStream, and it is not exported from `/client`. Root RpcClientOptions' M2 settings
  are not implemented by this private M1 primitive. Do not use it as evidence that defaults work.
- Its provisional internal endpoint validator allows wss or loopback ws and rejects user-info,
  query strings and fragments. The final caller-approved local-environment option/URL contract
  still needs review before public integration; no public URL-policy extension was added here.
- The private fixture socket pair carries safe close codes, permitting auth rejection/explicit
  shutdown to be characterized. Server peer disposal now accepts an optional internal code so it
  can preserve an authentication/expiry reason instead of replacing it with CLOSED.
- `peerClient.test.ts` and `connection.test.ts` use real upstream routing/codec with in-memory
  sockets. Written cases include typed app errors, signal propagation, malformed responses,
  close during credential acquisition, reentrant close from the socket factory, absolute deadline,
  capacity, server auth rejection, uncertain mutation outcome, fresh explicit attempts and stale
  old-socket events. None has been run. Compile fixtures include owned-client/connection typing.
  The connection generic uses the same bound as the upstream client factory, with a separate
  required-context compile case; constraining it to NestedClient<ClientContext> would incorrectly
  exclude clients whose call options require context. No router/client inference cast is used.

Native ingress parsing/concurrency limits, per-stream queue limits, full public factory lifecycle,
packed browser/Node/Expo imports and actual device/slow-peer evidence remain unverified/open.
