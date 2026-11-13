# M5 offline delivery contract proposal

Status: **approved by the developer, 2026-11-13**. Prepared on `feature/m5-offline-delivery`,
branched from local `dev` at `dd2b5a3`. Approval covers the two exports and the in-memory queue,
receipt/deduplication, expiry, cancellation and reconciliation contracts below. Source and
verification status are recorded separately in SPEC Progress. No dependency or existing
transport/default change is authorized or required.

## Intent and scope

Allow an application to explicitly submit bounded unary commands while disconnected, dispatch
them through its existing typed oRPC procedures when ready, and reconcile uncertain results.
Deduplication must be scoped to the authenticated application identity and operation. No
exactly-once, durable delivery, rollback or cross-process deduplication promise is made.

Recommended first M5 delivery: an in-memory client queue and an in-memory server receipt ledger.
The application owns procedure schemas, authenticated scope selection, serialization and storage.
There is no filesystem/database/browser-storage implementation or persistence adapter in this
delivery. Reload/process restart loses memory state. Durable restoration requires a separately
reviewed contract, not serialization of callbacks, credentials or connection handles.

Existing `client` calls remain fail-fast offline. Existing uncertain calls are never replayed.
The queue is opt-in through a separate helper; creating one never connects or closes its borrowed
connection. Streams, file-transfer policy and M6 integration are excluded.

## Approaches

1. **Separate queue and application-routed receipt ledger (recommended).** Reuses the existing
   connection owner and typed procedures. Explicit enqueue makes changed delivery semantics visible.
   Requires the application to expose validated command/status procedures and choose identity scope.
2. Transparently intercept all client procedures. Rejected: changes existing call behavior and
   cannot safely infer replay eligibility, identity, serialization or acknowledgement semantics.
3. Durable outbox with external storage/atomic deduplication adapters. Useful for restart-safe work,
   but needs storage failure, transaction, recovery and multi-worker contracts. Defer rather than
   implying in-memory helpers provide those guarantees.

## Proposed public additions

Exactly two named function exports, using existing entry paths:

- `/client`: `createRpcOfflineQueue`.
- `/server`: `createRpcDeliveryLedger`.

Root and Fastify exports, package export map, connection handle/options, error-code union,
reserved transport procedures and transport version remain unchanged. No new dependencies.
New option/return shapes appear in declarations without additional named barrel exports.

Each queue/ledger handles one typed command family. Separate instances support distinct schemas;
do not erase heterogeneous procedures behind a string method name or `unknown` result proxy.
The client callback receives the original typed application client, preserving required per-call
context and application error inference at the call site. No upstream private API is required.

## Client queue surface

Proposed construction options:

- `connection`: an existing RpcClient handle, borrowed, not owned.
- `encode(input): Uint8Array` and `decode(bytes): input`: synchronous application codec.
- `decodeResult(bytes): result`: application validation/decoding of a completed receipt.
- `deliver(client, command, signal, input)`: invoke the application's typed command procedure.
  The fourth argument is a fresh decoded TInput for local validation/use; command.payload remains
  encoded bytes. Callbacks may omit that parameter. The decoder never mutates retained bytes.
- `reconcile(client, key, signal)`: invoke the application's read-only receipt/status procedure.
- Required positive integer `maxEntries`, `maxBytes`, `maxEntryBytes`, `maxAgeMs`, `attemptTimeoutMs`.
  Counts range 1..10,000; byte values must be safe integers, maxEntryBytes <= maxBytes;
  durations range 1..2,147,483,647 ms. No implicit offline budget or infinite timeout.

Proposed returned methods:

- `enqueue(input, { key, signal? })`: synchronously validate/admit a command and return a frozen
  ticket `{ key, result: Promise<result>, cancel(): void }`.
- `reconcile(key): Promise<void>`: explicitly request a status lookup for an uncertain command;
  it does not authorize another execution.
- `getSnapshot()` and `subscribe(listener)`: frozen counts, retained byte count and per-ticket
  key/state/expiry/safe error code only; never input/output/credentials/URLs or raw errors.
- `close(): Promise<void>`: idempotent terminal local cleanup, without closing the connection.

Keys are caller-generated opaque non-secret strings matching `[A-Za-z0-9_-]{1,128}`. The application
must not reuse a key for a different logical command. The queue rejects duplicate active keys with
INVALID_OPTION; it does not invent UUIDs or infer identity from a token/session ID.

### Admission, expiry and resource accounting

- Encode once, check actual byte length, then copy to detach mutable caller input. Retain only
  bounded bytes and decode a fresh copy for dispatch. Failed admission has no listener/timer side
  effects. Reject oversize input with PAYLOAD_TOO_LARGE and count/aggregate overflow with
  LIMIT_EXCEEDED; malformed options/codec output use INVALID_OPTION.
- Accounting includes queued, dispatching and uncertain tickets, including their UTF-8 keys and
  fixed-size command metadata. The formula is payload bytes + UTF-8 key bytes + 16 metadata bytes;
  the ledger additionally includes UTF-8 scope bytes and reserves maxEntryBytes for the result.
  Application codec execution, transient copies, transport encoding overhead, JS object overhead
  and data retained by callers are outside this retained-byte budget.
- FIFO among never-dispatched commands, one delivery attempt at a time per queue. Uncertain
  tickets do not block later unsent work, but continue consuming capacity until settled/expired.
  No payload eviction, silent dropping, unbounded completed-ticket cache or automatic rollover.
  A callback that ignores abort/timeout blocks later callbacks until it actually settles; ticket
  expiry and local close still work. This prevents overlapping application callbacks after timeout.
- Expiry is absolute `expiresAt = admissionTime + maxAgeMs`, safely representable. Check before
  dispatch and use an owned nearest-expiry timer while tickets exist. No polling or idle timer.
  Expiry before dispatch rejects TIMEOUT and proves this queue did not dispatch it. Expiry after
  dispatch rejects OUTCOME_UNKNOWN; it does not prove the mutation stopped.
- Construction installs only a connection observer; it creates no socket or timer. Application
  code explicitly calls connection.connect(). No second reconnect/retry owner is introduced.

### Dispatch, acknowledgement and uncertainty

The application command schema carries `{ key, expiresAt, payload: Uint8Array }`. A receipt carries
the same key/expiry and one of `pending`, `completed` (with encoded result bytes), `uncertain` or
`missing`. Missing carries only key/state because no expiry is known. These are helper-boundary
values: applications map Uint8Array to their chosen validated wire representation. oRPC 1.16.2's
default JSON serializer does not preserve Uint8Array; examples use bounded number arrays instead.
Receipts are never new raw oRPC frames
or new reserved transport methods. The application chooses and versions its procedure schema.

- Dispatch only after an authenticated ready snapshot; validate again immediately before calling
  deliver. Once the callback is invoked, conservatively treat transport/timeout/cancellation failure
  as possibly dispatched, even if failure occurred before a frame actually left the socket.
- Resolve a ticket only on a validated matching completed receipt, after decoding its result.
  A send, local enqueue, pending receipt or helper completion is not acknowledgement of commit.
  Mismatched keys/expiry or malformed receipts fail INVALID_MESSAGE without replay.
- A pending receipt retains the ticket as uncertain. An application procedure rejection is delivered
  unchanged and never automatically replayed; a handler rejection may follow a committed mutation.
- On OUTCOME_UNKNOWN, disconnect or attempt timeout after invocation, retain an uncertain ticket.
  On each later ready epoch, perform at most one read-only reconciliation per uncertain ticket,
  serially with other queue work. No status polling/backoff loop. Explicit reconcile allows another
  bounded lookup. A lookup failure leaves the ticket uncertain until expiry/cancellation/close.
- A completed status resolves; pending/uncertain/missing do not cause resubmission. In particular,
  missing is not proof that an old mutation cannot still complete. No automatic retry of an invoked
  command in this delivery. Applications reconcile or explicitly submit a new logical operation.
- Authentication failure or protocol mismatch terminates unsent tickets with that safe code and
  settles already-invoked tickets OUTCOME_UNKNOWN. A new identity requires a new connection/queue;
  applications must never change the authenticated principal behind a queued connection handle.

### Cancellation and cleanup

Before dispatch, abort/cancel removes the ticket and rejects CANCELLED. After invocation, abort
the owned signal, reject CANCELLED locally and release ticket capacity; cancellation does not
delete the server receipt or prove rollback. Application status procedures remain available for
later reconciliation by key. No arbitrary abort reason appears in snapshots or transport errors.

close commits terminal state before callbacks, stops new admission/dispatch, rejects unsent tickets
CLOSED and invoked tickets OUTCOME_UNKNOWN, aborts owned work, detaches listeners/timers and
releases local references. It settles without waiting for uncooperative application callbacks;
observe/discard late results and rejections. It never closes the borrowed connection. Closing the
connection directly triggers equivalent queue cleanup. Observer exceptions are isolated and late
old-epoch results cannot overwrite a completed/cancelled ticket.

## Server receipt ledger

Proposed construction options: required `maxEntries`, `maxBytes`, `maxEntryBytes`, `retentionMs`,
`maxCommandAgeMs`, plus synchronous `encodeResult`/`decodeResult` callbacks for the typed result.
Counts/bytes/durations use the client ranges. maxCommandAgeMs <= retentionMs. No socket starts.

Proposed returned methods:

- `execute(scope, command, run): Promise<receipt>`: atomically admit/join a command and run the
  typed application handler once for that live scoped key; run receives decoded application input
  through the application's wrapper and a ledger-owned shutdown signal.
- `lookup(scope, key): receipt`: return a copied immutable status/result record or missing.
- `close(): Promise<void>`: terminal local shutdown; abort owned work and stop new admission.

The application derives scope from **current authenticated context** and a stable operation name,
not from client-provided scope, token bytes or transient session ID. Scope is a non-secret bounded
string of 1..256 UTF-8 bytes. Command/status routes must authenticate and authorize every call,
including duplicates/lookups; the helper does not bypass the existing session guard.

### Deduplication, retention and acknowledgements

- Use collision-free tuple identity (scope, key), not concatenation with an ambiguous delimiter.
  Before running user code, reserve count/bytes and store a pending record synchronously. Compare
  exact copied input bytes and expiry on duplicates. Different content for the same scoped key
  rejects INVALID_MESSAGE without invoking user code or replacing the original record.
- Concurrent identical submissions join the existing execution. A dropped client response or caller
  abort stops that observer's wait, not the ledger-owned execution or deduplication record. This
  opt-in execution lifetime is separate from ordinary cancellable procedures. Server/ledger close
  still requests cooperative cancellation. The application must explicitly review this behavior
  when wrapping handlers that normally use the per-call AbortSignal.
- Reject stale commands before execution with TIMEOUT; reject expiry farther than maxCommandAgeMs
  in the future with INVALID_MESSAGE. Clock skew can reject valid work; require reasonably aligned
  clocks and document this as application deployment responsibility.
- A completed receipt is stored only after run resolves and its encoded result fits the reserved
  byte budget. Reserve room for maxEntryBytes of result before execution, plus actual input/key/
  scope/metadata bytes, so concurrent completions cannot exceed maxBytes. Oversize result or codec
  failure leaves an uncertain tombstone, never an executable empty slot; the mutation may commit.
- Original handler rejection propagates to the invoking procedure unchanged. Retain an uncertain
  tombstone (without the raw exception) and never run that scoped key again within retention.
  This avoids retaining arbitrary errors or pretending rejection proves rollback. Reconciliation
  may need the application's authoritative mutation record to determine the business outcome.
- Retain completed/uncertain entries until at least `max(expiresAt, settledAt) + retentionMs`.
  Pending entries are pinned until settlement, even past expiry; an uncooperative handler can
  exhaust capacity, so new work must fail LIMIT_EXCEEDED rather than evict it and execute twice.
  Prune expired settled records on access/admission, without periodic background timers.
- Restart, process replacement, a second ledger instance or early close loses deduplication.
  The application must not route the same scope to multiple independent ledgers and claim global
  deduplication. Durable/multi-worker execution requires an application transaction/atomic store.
  After retention expires, this helper makes no deduplication guarantee; expired command envelopes
  are still rejected. Reusing a key with a new expiry after eviction is a new application decision.
- Receipt means the handler resolved and its result was retained in this process. Only the handler
  can establish business persistence/commit. No exactly-once or durable acknowledgement claim.

## Implementation and verification after approval

1. Write private queue/ledger state-machine tests first with internal clock/scheduler injection;
   no publicly exported test seam. Implement the two helpers and only the approved barrel exports.
2. Client cases: opt-in/default isolation, exact byte/count limits, immutable codec snapshots,
   FIFO, expiry offline/online, cancellation before/during dispatch, close during callbacks,
   reentrant observers, old epochs, terminal auth, missing/pending/mismatched receipts and no
   resend after an uncertain mutation. Test an uncooperative callback without leaked timers.
3. Server cases: auth-scoped keys, same-key races, payload conflicts, stale/future commands,
   capacity reservation, oversized result, handler rejection, retention boundaries, pinned pending
   work, process-local limitations and shutdown. Never erase a pending record to admit new work.
4. Add a real oRPC/Fastify fake-token integration: commit once, lose its response, reconnect and
   reconcile the retained receipt without a second mutation; test unauthorized status lookup.
5. Extend public/packed inference fixtures for input/result/required context; browser/Node examples
   and Expo probe demonstrate the same application-defined command/status schema without native
   dependencies. Update README, errors, CHANGELOG, compatibility and acceptance docs.
6. Developer-run existing scripts: `npm run lint`, `npm run typecheck`, `npm run test:coverage`,
   `npm run build`, `npm run size`, `npm run check:exports`, `npm run check:consumers`,
   `npm run test:stress`, `npm run playground:smoke`, `npm run docs`. Actual browser/device records
   remain separate from compile/CI evidence. No command execution is authorized by this proposal.

## Approval record

The developer explicitly approved the proposal in this session on 2026-11-13. Approval covers the
two exports, memory-only scope, mandatory budgets, application-routed receipt schema, process-local
deduplication/retention, separate execution lifetime, and reconciliation without automatic replay.
No new dependency/version decision is needed. Implementation checks remain developer-run under
AGENTS; approval of the design is not runtime, browser, packed-consumer or device evidence.
