# M6 React and TanStack Query contract proposal

Status: **approved by the developer, 2026-11-13**, including the linked exact dependency proposal.
M5 remains uncommitted on feature/m5-offline-delivery and its acceptance is open. This task preserves
those edits and implements M6 source without claiming that M5 or earlier gates passed. Approval
does not authorize dependency installation or verification commands under AGENTS.

## Consumer grounding and scope

The current browser playground needs connection status, explicit typed lookup, explicitly triggered
application commands and independently owned streams. Adjacent integr8-ui/window-manager manifests
use React 19 peers. No actual React ws-rpc consumer is present in this repository; these are the
concrete first consumer flows proposed for approval, not evidence of product integration.

Build an optional /react entry with exactly three named hooks:

- useRpcSnapshot: observe an existing connection's immutable lifecycle state.
- useRpcQuery: cache an explicitly requested typed read through TanStack Query.
- useRpcMutation: run explicitly requested typed commands without retry/offline pause or replay.

The application owns its connection and QueryClient/QueryClientProvider. Hooks do not construct,
connect or close shared connections, issue credentials, choose product schemas, persist data or
create UI components. Streams continue through the existing subscribeStream API with a documented
effect/cleanup recipe; an additional stream hook is deferred until a consumer needs one.
No implicit integration with M5 queues: explicit offline submission remains a separate action.

## Approaches

Recommended: three borrowed-handle hooks with manual query triggering. This matches the existing
playground's explicit Call button and preserves the package's uncertain-outcome/no-replay policy.

Alternative: automatic ready-gated queries and background refetch. More conventional Query behavior,
but remount/readiness/online/focus transitions can issue another call after an uncertain outcome.
It needs a separate reviewed policy rather than silently inheriting Query's defaults.

Deferred: an owning provider, router proxy, generated hooks, stream-to-cache accumulation, optimistic
updates, persistence/hydration, Suspense and automatic query invalidation. They add lifecycle/cache
policy not established by the current consumers. No @orpc/tanstack-query package is proposed.

## Package and dependency contract

Add only ./react, with browser-safe ESM/declarations at dist/react/index.mjs and index.d.mts.
Mark the React entry as a client boundary for frameworks that honor 'use client'; preserve the
directive in built output and verify it. Existing root/client/server/Fastify exports remain unchanged.
Root/client must work at runtime AND typecheck when no React/Query/type peers are installed.

Optional peers: react ^19.0.0, @tanstack/react-query ^5.107.1, @types/react ^19.0.0. All are optional
for the package's existing entries; /react users supply the relevant peers, including React types
for TypeScript. The /react entry imports React/Query, so even snapshot-only imports from that entry
require both runtime peers in Node ESM. Tree shaking is not a substitute for this requirement.

Exact development/test pins, sizes, licenses, transitive notes and approval are proposed in
[dependency proposal](../../m6-dependency-proposal.md). No packages/manifests/lockfiles are changed
until approval. The developer installs; no dependency-install authorization is inferred here.
Node 24 remains the server/tooling target. No React Native/Expo integration claim is added.

## useRpcSnapshot

Proposed signature: useRpcSnapshot(connection): ConnectionSnapshot, where connection structurally
supplies the existing getSnapshot()/subscribe() surface. No provider required for this hook.

- Use React's useSyncExternalStore with stable subscription/read functions per handle.
- Return the existing cached frozen snapshot; do not allocate a fresh snapshot on every read.
- Subscribe after mount and detach on unmount or handle replacement. StrictMode's setup/cleanup
  must leave one live subscription after mount and none after unmount. Never close the handle.
- SSR and initial hydration use a single frozen { state:'idle', attempt:0 } server snapshot,
  independent of live connection state. After hydration, React reads the actual snapshot. No
  import/render-time socket, timers, DOM access or process-global connection is introduced.
- Query hooks require the caller's normal QueryClientProvider; this snapshot hook does not.

## useRpcQuery

Proposed options: { connection, cacheScope, queryKey, query, staleTime?, gcTime? }.
query receives (typedClient, AbortSignal) and returns PromiseLike<TResult>. It may capture the
application input/context, which must also be represented by the caller's queryKey/cacheScope.
Return UseQueryResult<TResult, unknown>; TResult is inferred from the callback. Error remains
unknown because Promise rejection types cannot be inferred from a callback. Preserve the original
application/RpcError value so callers can narrow it, without fabricating an error type or casting
away required per-call context. No select/initialData/placeholderData overloads in the first version.

- Manual only: mounting, rerendering, readiness changes, reconnect, focus, invalidation, remount
  and browser-online events never initiate this hook's query. Call returned refetch() explicitly.
- Fix enabled:false, retry:false, retryOnMount:false, refetchOnMount:false,
  refetchOnReconnect:false, refetchOnWindowFocus:false, refetchInterval:false,
  networkMode:'always' and no initial/placeholder data after user options. The implementation uses
  empty initial/placeholder data functions to satisfy upstream exact-optional declaration types.
  Do not expose an unrestricted Query options spread that can override these invariants.
- QueryClientProvider defaults must not re-enable retries, paused/offline execution or placeholder
  data from a previous handle. No Suspense/render-time execution. Manual refetch is a new explicit
  application request, including after OUTCOME_UNKNOWN; it is never automatic reconciliation.
- Immediately before the callback, require connection.getSnapshot().state === 'ready'; otherwise
  reject DISCONNECTED (CLOSED for an explicitly closed handle). No implicit connect or offline wait.
- Forward Query's per-execution AbortSignal; callers pass it to their existing typed procedure.
  Query unmount/cancel requests cooperative abort. Cancellation never proves a mutation rolled back.
- Validate staleTime/gcTime when supplied as finite nonnegative integers <=2,147,483,647 ms;
  otherwise leave the upstream values unchanged. Query cache retention is not a transport bound.
- QueryClient.prefetchQuery/fetchQuery/query, persistence plugins and arbitrary imperative Query
  APIs remain application-owned and outside the hook's automatic-execution guarantee. Applications
  must not persist/hydrate/replay these operations without their own reviewed delivery policy.

### Cache identity

cacheScope is a required non-secret string, 1..128 ASCII characters [A-Za-z0-9_-], chosen for the
application account/tenant/server boundary. queryKey is a required nonempty readonly QueryKey
containing all read inputs and relevant protocol/application distinctions. Never put tokens or
credentials in either: Query devtools/cache are application-visible.

Prefix the effective key with ['integr8-ws-rpc', cacheScope, localConnectionId, ...queryKey].
localConnectionId is an internal per-handle WeakMap identity assigned lazily by the /react module;
it is not a socket/session ID, exposed public option or credential. This prevents two handles using
the same caller key from accidentally sharing data within this loaded integration. A new handle
uses a fresh cache identity. The application still uses a separate QueryClient for each security
boundary and clears caches on identity logout. Do not mutate principal behind an existing handle.

No cache persistence, stable cross-process IDs or SSR query hydration/dehydration is promised by
this initial entry. SSR only renders the idle connection snapshot; reads remain manual. Do not
reuse a server-process QueryClient across user requests. Handle replacement must not display
previous-handle data or let an old in-flight result populate the replacement's effective key.

## useRpcMutation

Proposed options: { connection, cacheScope, mutationKey, mutation }.
mutation receives (typedClient, variables) and returns PromiseLike<TResult>. Variables and output
remain inferred independently per hook. Return UseMutationResult<TResult, unknown, TVariables>.
Use original errors and normal mutate/mutateAsync semantics; add no RpcError codes.

- Only mutate()/mutateAsync() initiates work. Check current ready/closed state immediately before
  the callback. Explicit calls while offline fail fast, never pause for later online execution.
- Fix retry:false and networkMode:'always'; use the same per-handle/scope key prefix. Ignore global
  Query retry defaults by supplying explicit values. No mutation scope queue, retry override,
  automatic invalidation, persistence, optimistic rollback or M5 enqueue integration is offered.
- Upstream mutations have no automatic AbortSignal. A caller needing cancellation includes its
  AbortSignal in typed variables and forwards it inside mutation; do not invent unmount rollback.
  Unmount unsubscribes UI observation without closing a connection or claiming server cancellation.
- Concurrent explicit mutations retain upstream semantics; each is an application request. A
  lost response surfaces OUTCOME_UNKNOWN and is never replayed by these helpers. Applications use
  M5/application status procedures explicitly when reconciliation is required.

## Proposed files and acceptance after approval

- src/react/{index,useRpcSnapshot,useRpcQuery,useRpcMutation,queryIdentity}.ts, with adjacent tests.
  Public functions have explicit return types/TSDoc; upstream types preserve inference, no any proxy.
- Add /react build/export/TypeDoc entry and browser-only typecheck coverage. Runtime React/Query
  imports stay external and exclusively reachable from /react. No root/client re-export of hooks.
- Update package-inspection tests for exactly five documented subpaths, add a no-peers root/client
  consumer, and a separate packed React consumer using exact approved peers/types. Existing
  browser budget remains 150 KiB; do not add React to its baseline bundle or weaken current limits.
- Proposed new entry-only emitted React budget: 10 kB gzip, excluding external peers; retain the
  existing total emitted 65 kB budget. Measure a separate complete React consumer bundle rather
  than reporting peer dependencies as free. Full consumer budget proposed: 300 KiB gzip JS.
- Add an opt-in React playground using the existing typed example router and fake credentials.
  It shows state, explicit refetch and explicit mutate; no UI component export or Workbench import.
- Hook tests run real ReactDOM/act in per-file jsdom environments. Cover StrictMode, unmount and
  handle replacement, cached snapshot identity, SSR/hydration idle state, no automatic calls under
  retry/online/focus/reconnect/invalidation, disconnected manual calls, Query cancellation,
  required per-call context, original errors, cache isolation and no mutation replay.
- Public compile fixtures include positive/negative input/result/context cases. Verify import
  isolation with optional peers absent, retained 'use client', packed declarations, current/new
  size gates, API docs and an actual React browser flow. Source typing is not browser/native proof.
- Existing developer-run scripts after install: npm run lint, npm run typecheck,
  npm run test:coverage, npm run build, npm run size, npm run check:exports,
  npm run check:consumers, npm run docs. New scripts, if needed, will be listed only when written.

## Approval record

The developer approved the three-hook /react surface, manual-only execution, cache/lifecycle
semantics, React 19 optional-peer ranges, exact development dependency pins and separate size gates.
Implementation uses the public MutationObserver per effective key so handle replacement cannot
show an old mutation result while an effect-based reset waits. Observer options update in an effect;
connection and QueryClient remain caller-owned. No passing check or completed M6 acceptance is
implied by this approval. Installation and all implementation checks remain developer-owned.
