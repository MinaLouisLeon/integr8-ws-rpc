# M6 React and Query Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. AGENTS prohibits sub-agents
> and implementation checks; write adjacent tests first and leave execution to the developer.

**Goal:** Add the three approved borrowed-connection hooks in an isolated optional /react entry.

**Architecture:** React observes existing immutable snapshots. Query reads remain manual and
mutations explicit, with fixed no-retry/no-offline-pause policy. Caller QueryClient and connection
ownership remain unchanged; cache identity includes an internal weak per-handle identifier.

**Tech Stack:** Existing TypeScript/oRPC 1.16.2/Vitest, approved React 19.3.1 and Query 5.107.1 pins.

**Spec:** `docs/superpowers/specs/2026-11-13-m6-react-query-design.md` (approved 2026-11-13).

## Global constraints

- Exactly useRpcSnapshot/useRpcQuery/useRpcMutation from ./react; initial runtime graphs stay isolated.
- No automatic calls on render, reconnect, focus, invalidation or retry. No implicit M5 queue.
- No UI exports, product storage, auth/wire/default changes, agents, install or verification commands.
- Preserve uncommitted M5 work on feature/m5-offline-delivery; no automatic commit, push or PR.
- Edit approved optional peers/dev pins only; the developer installs and regenerates package-lock.

## Review focus

- QueryClient defaults can re-enable suspense, query hash collisions, placeholder data or retries.
- Handle replacement must not render old cached/query/mutation results under a new identity.
- StrictMode/hydration must not own/close connections, leak listeners or initiate RPC calls.
- Query cancellation forwards the actual signal; mutation cancellation is caller-owned.
- A clean no-peer consumer must compile declarations and import root/client, not merely tree-shake.

## Task 1: Hooks and adjacent tests

Files: src/react/{index,queryIdentity,useRpcSnapshot,useRpcQuery,useRpcMutation}.ts; adjacent tests;
src/core/testing/reactHarness.ts.

- [x] Write real ReactDOM/act jsdom tests for state lifecycle/hydration, manual-only query execution,
  error/cancel behavior, global default overrides, handle replacement and explicit mutation policy.
- [x] Implement typed structural connection constraints and per-handle/scope key validation.
- [x] Implement useSyncExternalStore snapshots and fixed-policy Query/Mutation observation.
- [ ] Developer runs hook tests/typecheck/full coverage after approved dependencies are installed.

## Task 2: Build and package boundaries

Files: package.json, tsdown.config.ts, typedoc.json, tsconfig.browser.json, .size-limit.mjs,
scripts/packageChecks{,.test}.mjs/ts and scripts/consumerChecks{,.test}.mjs/ts.

- [x] Add exact approved dev pins and optional peers/meta; no lockfile guessing or install.
- [x] Add ./react ESM/types and retained use-client directive, external peers and 10 kB entry limit;
  preserve existing budgets and 65 kB total. Root/client no-peer graph checks remain strict.
- [x] Expand package/bundle tests for five entries and separate baseline vs React graphs.
- [ ] Developer runs build/size/exports/docs; no passing evidence inferred from configuration.

## Task 3: Consumers and example

Files: scripts/checkConsumers.mjs; fixtures/consumers/{react,noPeers,assertReactTypes}.ts/mts;
playground/react/{index.html,main.ts}; playground dev/config helpers and documentation.

- [x] Add isolated no-peer runtime/declaration consumer and separate packed React build/SSR probe.
- [x] Keep baseline browser at 150 KiB gzip; React complete JS at 300 KiB including peers.
- [x] Add optional playground with explicit connect/refetch/mutate and caller-owned cleanup.
- [x] Add positive/negative variable/output/required-context public compile fixtures.
- [ ] Developer runs packed consumers and actual React browser/manual lifecycle scenarios.

## Task 4: Documentation and source review

- [x] Record approval, signatures, install/lockfile requirements, ownership, manual Query policy,
  cache boundaries and original errors in README/CHANGELOG/SPEC/compatibility/errors/acceptance.
- [x] Source-review imports, declarations, defaults and cleanup. Format touched files only and
  inspect git diff; no unrun lint/type/test/build claims or independent agent review.

## Execution ledger

2026-11-13: Contract/dependency proposal explicitly approved. Inline work preserves M5 changes.
Verification and installation remain developer-owned. All runtime/compile acceptance is pending.
Decision: use the public TanStack MutationObserver per effective key, following useMutation's
documented observer pattern, to avoid exposing old-handle results before its reset effect runs.
Decision: pin hashKey, suspense:false, render-prefetch:false and throwOnError:false explicitly so
global Query defaults cannot undermine manual execution or cache identity. No user option spread.

Source tasks 1–4 are written; all developer-run install/verification checkboxes remain open.
No independent review was dispatched because AGENTS prohibits sub-agents. Inline review covered
the exact published Query/core 5.107.1 APIs, strict optional properties, borrowed lifetimes and
old-handle results. Empty initial/placeholder functions suppress global defaults without asserting
upstream types; an own undefined mutation scope disables inherited serialization queues. No any
cast is used. The hook's observer binding changes by render-state adjustment only when its key or
QueryClient changes; ordinary renders update options in an effect.

The packed runner copies the actual React playground, adds a separate SSR probe and source-free
type tests, and omits/asserts absence of optional peers in baseline consumers. The Expo sibling
helper seam also fixes the previously unresolved relative import in the isolated copied probe.
Formatter-only npm run format was executed on the explicit touched files, followed by read-only
git diff inspection. No install, lockfile regeneration, lint, typecheck, tests, builds, consumer/SSR/
browser checks, sizes, docs, servers, CI, commits or publication ran. M6 acceptance remains open.

2026-11-13 lint/typecheck follow-up: developer explicitly authorized both commands and fixes.
Both pass after fixing memoization/module-level probes, upstream conditional mutation argument
adaptation and test/fixture annotations. Required and void mutation argument cases compile.
108 files lint clean with no warnings. Full source typecheck passes on Node 22.22.3; runtime,
coverage, build, packed/browser and target-runtime evidence remain pending. No dependency or
public contract change; developer-installed dependencies/updated lockfile were preserved.
