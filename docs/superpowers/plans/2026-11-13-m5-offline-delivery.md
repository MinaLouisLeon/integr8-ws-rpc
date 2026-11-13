# M5 Offline Delivery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. AGENTS prohibits sub-agents
> and implementation command execution; write tests first and leave execution to the developer.

**Goal:** Implement the approved explicit in-memory queue and scoped receipt ledger.

**Architecture:** Keep normal calls fail-fast. A separate queue borrows an existing connection,
owns bounded command tickets and reconciles through caller-provided typed procedures. A separate
server ledger owns process-local deduplication and execution lifetime, without new transport frames.

**Tech Stack:** Existing strict TypeScript/ESM, oRPC 1.16.2, Zod and Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-13-m5-offline-delivery-design.md` (approved 2026-11-13).

## Global constraints

- Preserve existing exports, wire/auth semantics, errors and defaults; add only the two approved exports.
- Required bounded count/bytes/durations, one delivery callback per queue at a time, no uncertain replay.
- No filesystem/database/native/React dependencies, storage adapters, credentials or application schemas.
- Adjacent tests first; no install/lint/typecheck/tests/build/servers unless separately authorized.
- Keep source changes on feature/m5-offline-delivery; no agents, pushes, PRs or publication.

## Review focus

- Synchronous callbacks can close/cancel/reenter; commit ownership before calling application code.
- Missing receipts cannot authorize a resend; stale callbacks cannot settle a replacement ticket.
- Uncooperative delivery/handler promises must not block local close or bypass byte/count bounds.
- A codec can mutate inputs/reenter/throw; reserve capacity atomically and retain detached bytes.
- Auth/session changes and external closure must not leak payloads or dispatch under a new identity.

## Task 1: Shared boundaries and server ledger

Files: `src/core/delivery.ts`, adjacent tests; `src/server/createRpcDeliveryLedger.ts`, adjacent tests.

- [x] Write tests for exact accounting/validation, copied receipts, same-key concurrency, scoped
  conflicts, capacity reservations, expiry, retention, pinned running work, result-codec failure,
  handler rejection and shutdown. Byte formula: payload + UTF-8 key/scope + 16 metadata bytes;
  ledger additionally reserves maxEntryBytes for result.
- [x] Implement private boundary types/validators plus `createRpcDeliveryLedger<TResult>(options)`
  returning execute(scope, command, run), lookup(scope, key), close. Callbacks receive the copied
  command payload and ledger-owned signal; caller parses/validates bytes inside run.
- [ ] Developer verification pending: targeted tests, typecheck and full coverage.

## Task 2: Client queue

Files: `src/client/createRpcOfflineQueue.ts`, adjacent tests, private lifecycle testing utility.

- [x] Write tests for offline admission, FIFO/immutable input, required byte budgets, expiry,
  terminal auth, disconnect uncertainty, reconciliation without replay, cancellation, reentrant
  observers/codecs, caller closure, uncooperative callbacks and old-epoch completion suppression.
- [x] Implement `createRpcOfflineQueue<TClient, TInput, TResult>(options)` returning enqueue,
  reconcile, snapshots/observer and close. Structural connection constraint preserves client types
  and required per-call context; internal scheduler is not a public option.
- [ ] Developer verification pending: targeted tests, typecheck and full coverage.

## Task 3: Public integration and consumer evidence source

Files: client/server barrels; `src/client/offlineDelivery.test.ts`; playground application router,
browser/Node examples; packed/source declaration fixtures and Expo probe.

- [x] Add only createRpcOfflineQueue and createRpcDeliveryLedger exports.
- [x] Write real socket lost-response/reconcile/identity isolation integration with one mutation,
  keeping ledger execution separate from aborted per-call observers.
- [x] Add public declaration negative cases and an application-defined command/status example;
  extend packed Node/browser/device probes without implying those probes have run.
- [ ] Developer verification pending: lint/typecheck/coverage/build/size/export/consumer/stress/docs/
  smoke, actual browser and physical Android/iPadOS records.

## Task 4: Documentation and source review

Files: SPEC, approved design, README, CHANGELOG, errors, compatibility and acceptance docs.

- [x] Record approval, exact surfaces/accounting, cancellation/execution lifetime, memory-only
  durability limits and developer-run commands. Separate written source from runtime evidence.
- [x] Self-review race boundaries, type declarations, capacity and auth ownership. No sub-agents.
- [x] Read-only diff/whitespace inspection; no unrun success claims or automatic commit/push.

## Execution ledger

2026-11-13: User approved the concrete M5 design. Proceed inline under AGENTS. Test execution and
sub-agent steps from the generic skills are superseded by the repository instructions.
Ruling: execute run(payload, signal), decoding only inside the first admitted execution; duplicates
never decode/re-run. Ledger result bytes round-trip through decodeResult before acknowledging.
Ruling: missing receipts carry the queried key but no expiry (no record exists); other receipt
states must match both key and expiry. Keys/scopes are non-secret identifiers.

Source status: Tasks 1–4 are written and source-reviewed. Every developer verification checkbox
remains open. Formatting uses the existing npm run format script on the explicit touched files;
this is not lint/typecheck/runtime evidence. No implementation verification commands ran.
Ruling: callbacks ignoring abort keep a dispatch fence until actual settlement, preventing
overlapping callbacks after local timeout; expiry/close still settle locally without waiting.
Ruling: the local decoded input is an optional-to-consume fourth deliver argument. Application
wire examples map helper Uint8Array payloads/results to bounded number arrays, because installed
oRPC 1.16.2 has no built-in typed-array JSON tag. No new custom codec or transport frame is added.
Source review added absolute-expiry checks after callbacks/codecs and before delayed server work,
an expiry timer generation guard, sanitized option getters/snapshot error codes, and removal of
settled task references so tombstones do not retain raw application exceptions.
