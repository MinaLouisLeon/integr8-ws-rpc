# M4 public contract proposal

Status: **approved by the developer in this session, 2026-11-12**. The approval covers both proposed
/client additions and their ownership/limits/progress/error contracts below. Implementation and
runtime verification are tracked separately in SPEC Progress. M0–M3 runtime gates remain open.

## Goal and chosen direction for review

Support applications that connect to several named servers and explicitly slice binary input while
preserving each server's typed router, credentials, state and cancellation. Keep file-transfer,
storage, routing/failover and delivery/acknowledgement policy with the application.

Recommended: a static, typed registry that owns existing RpcClient handles, plus a transport-neutral
binary chunk iterator. Existing handles already own connect/retry/heartbeat/subscriptions; a second
lifecycle engine would duplicate ownership and create replay/cross-server risks.

Alternative: a dynamic add/remove/replacement manager. It permits runtime discovery but adds
generation/replacement races, heterogeneous type-erasure questions and an ownership protocol that
M4 does not currently require. Defer it until a consumer supplies a concrete need.

Rejected for this scope: automatic failover/load balancing or a file-transfer engine with transfer
IDs, acknowledgements, persistence and resume. These would change routing/wire/delivery contracts
and overlap product policy and M5. No new dependencies are proposed.

## Proposed public additions

Add exactly two named functions to the existing `/client` barrel:

```ts
createRpcClientGroup(clients)
chunkBinary(source, options)
```

Keep root, `/server`, `/fastify`, the package export map and existing option/error/wire contracts
unchanged. Public return/options types appear in generated declarations but no additional named type
exports are proposed. No `/binary` subpath, React/native dependency or custom frame is introduced.

## createRpcClientGroup

Input is a static record of **already-created** package RpcClient handles:

```ts
const group = createRpcClientGroup({ catalog: catalogConnection, jobs: jobsConnection });
await group.connect('catalog');
await group.clients.catalog.client.lookup({ id: 'one' });
await group.clients.jobs.client.start({ priority: 2 });
```

The two client types remain distinct. Required per-call context, application errors and stream
items are preserved through the exact original handles; there is no unknown-result or any-cast
procedure proxy. The implementation uses a structural lifecycle constraint for generic inference,
not a NestedClient<ClientContext> bound that would exclude required caller context.

Proposed return surface, with K being the exact input keys and T the exact input record:

```ts
{
  readonly clients: Readonly<T>;
  connect(name: K): Promise<void>;
  connectAll(): Promise<Readonly<Record<K,
    | { readonly status: 'fulfilled' }
    | { readonly status: 'rejected'; readonly code: RpcErrorCode }
  >>>;
  close(name?: K): Promise<void>;
  getSnapshot(): Readonly<{ [P in K]: ConnectionSnapshot }>;
  subscribe(listener: (snapshot: Readonly<{ [P in K]: ConnectionSnapshot }>) => void): () => void;
}
```

### Ownership, limits and transitions

- Construction is lazy: no connect, socket or timer. Copy/freeze the registry; do not mutate input.
- Construction transfers lifecycle ownership to the group. The application may call procedures
  and subscribe through the exposed original handles, but should close through the group. Closing
  one child directly is reflected by the group's observer and never closes siblings.
- Require a plain own-property record with 1..32 distinct handle objects. Names must match
  `[A-Za-z][A-Za-z0-9_-]{0,63}`. Reject getter-valued entries, duplicate handle aliases, symbol keys
  or malformed handles as INVALID_OPTION before installing listeners. No dynamic add/remove/replace.
- Each child retains its own URL, token provider, retry policy, socket, timers, epoch and streams.
  The group never shares a credential/connect promise or reroutes/replays a call to a sibling.
- connect(name) delegates to that child and preserves its existing concurrent-connect semantics.
  Unknown runtime names fail INVALID_OPTION; CLOSED after terminal whole-group close.
- connectAll starts every child concurrently and returns a frozen per-name settled report. One
  failure neither closes nor rolls back healthy children. Reports expose only safe error codes;
  unexpected non-RpcError lifecycle exceptions map to INTERNAL. No raw error/cause is published.
- close(name) closes only that child and retains its final closed entry. It cannot be reopened or
  replaced. Whole-group close is idempotent, commits terminal state before callbacks, detaches
  owned child listeners, closes all children, and waits for all cleanup attempts before settling.
  A cleanup failure must not skip a sibling; reject with a safe RpcError after all settle.
- Whole-group close stops new connect/connectAll and emits the final aggregate snapshot before
  removing observers. getSnapshot remains available. Child closure is terminal under current rules.
- Freeze the aggregate snapshot and each copied entry; never include credentials, endpoints or
  application payloads. Observer exceptions/rejections are isolated. Reentrant subscribe/close and
  delayed child notifications must not publish stale aggregate state after terminal shutdown.
- subscribe observes future transitions only, matching the existing client; callers read the
  current value with getSnapshot. connectAll can publish each child's transition independently;
  it does not batch or invent an atomic all-ready transition.
- Existing child subscriptions deliver their own data/gaps. No extra group-level stream replay,
  resubscription, heartbeat, retry or aggregate-ready state is invented.

The 32-handle/name bounds and ownership transfer are new M4 decisions presented for review, not
previously approved defaults. They bound aggregate observer work; they do not limit how many
independent handles an application can create outside this helper.

## chunkBinary

Proposed signature:

```ts
chunkBinary(
  source: Blob | Uint8Array,
  options: {
    readonly maxBytes: number;
    readonly chunkBytes?: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: Readonly<{
      producedBytes: number;
      totalBytes: number;
      done: boolean;
    }>) => void | PromiseLike<void>;
  },
): AsyncIterableIterator<Uint8Array>
```

### Input, memory and cancellation

- maxBytes is required, a safe integer in 0..Number.MAX_SAFE_INTEGER. Reject input whose known
  byte length exceeds it with PAYLOAD_TOO_LARGE before reading a Blob or yielding bytes.
- chunkBytes defaults to 65,536 and must be an integer in 1..1,048,576. These are proposed helper
  defaults/ranges, not changes to the transport's message/high-water/pending-stream defaults.
- Validate options and known input size synchronously when constructing the helper, before any
  asynchronous read or observer callback. Unsupported source/options throw INVALID_OPTION.
- The iterator is pull-based. Read at most one source slice at a time; yield nonempty, independent
  Uint8Array copies of at most chunkBytes. A view slices its actual byteOffset/byteLength, not its
  entire backing allocation. Empty input yields no chunks and reaches normal completion.
- No whole-input copy/concatenation, read-ahead, worker, internal queue, file access or Node Buffer
  import. An existing input Blob/array may already retain the entire input: this helper does not
  promise whole-transfer memory bounds or bound chunks retained/requested by the caller.
- The caller must not mutate an array source while iterating. Mutating one yielded chunk must not
  change the source or later chunks. The helper does not take a whole-input immutable snapshot.
- Pre-abort and abort during read/progress stop local delivery with CANCELLED, without retaining
  the caller's arbitrary abort reason. Blob reads cannot necessarily be physically interrupted;
  late read completion is observed/discarded and must not deliver a chunk or emit completion.
- return/unsubscribe prevents further reads and releases owned signal listeners. There are no
  timers. It must settle local cancellation even when an observer/read is not cooperative.
- Source-read failures become a safe INTERNAL error without platform cause/payload. User progress
  callback failures stop iteration and preserve the original callback exception as application
  behavior. An explicit abort remains CANCELLED if a late callback subsequently rejects.

### Progress and serialization semantics

- onProgress is optional, awaited, and sequential. Emit an initial frozen `{0,total,false}` on
  first pull; then a frozen produced-byte update immediately before each chunk is yielded.
- producedBytes measures locally prepared output only. It does not mean encoded/sent, received,
  persisted, acknowledged or committed. The application owns acknowledgements and transfer state.
- Emit `{total,total,true}` only when the consumer pulls through natural iterator completion,
  including the zero-byte case. No done:true on abort, return or failure. A consumer that stops
  after the last yielded chunk without completing the iterator gets no success notification.
- Awaiting the callback provides pull pacing; a callback cannot make the helper read ahead.
- No built-in procedure, transfer ID, chunk envelope, checksums, resume cursor or retry. The caller
  sends yielded bytes through its own typed procedures and the upstream-supported serializer.
  A raw chunk-byte limit does not prove an encoded frame fits: transport limits still validate
  actual oRPC messages and overhead in either direction. This helper never bypasses those limits.

## Files and verification after approval

- Implement client/createRpcClientGroup.ts and adjacent tests, plus type fixtures for heterogeneous
  clients and required caller context. Add only its named export to client/index.ts.
- Implement client/chunkBinary.ts and adjacent tests; reuse the current internal cancellation
  machinery, safe errors and validators where appropriate. Add only its named client export.
- Extend packed consumer and browser/device examples without new runtime dependencies. Keep
  file-transfer/storage/UI policy outside the transport. Update TypeDoc/README/CHANGELOG/size checks.
- Tests: names/aliases/limits, separate auth/session data, one-child failure/revocation/shutdown,
  concurrent connect/close, reentrant observers, safe all-settled reports and cleanup failures.
- Binary tests: zero/exact/partial chunks, view offsets, copy isolation, byte budget before read,
  delayed/rejected Blob reads, abort during read/callback, early return, callback throw/rejection,
  monotonic local progress and absence of completion after failure/cancellation.
- Review actual encoded binary overhead with oRPC 1.16.2 and packed browser/Node consumers. Do not
  claim native binary support from source typing. Preserve all previously required M0–M3 gates.
- Prior session authorization covers lint/typecheck. Runtime tests, builds, package/device checks
  remain developer-run unless explicitly authorized. No publication or dependency install implied.

## Approval record

The developer approved both `/client` additions, static ownership/32-handle registry, helper byte/
progress semantics, validation/defaults and error behavior in this session. SPEC records the approved
extension; the implementation plan tracks source and verification separately. No runtime test,
build, dependency installation, publication or additional public entry point was authorized by it.

Implementation notes: demanded next calls serialize; there is no queue of produced chunks or
read-ahead. Local EOF is committed when a final pull observes all source bytes consumed, before
its completion notification. A callback cannot retract an event it already observed; its own
exception still propagates. Abort/return can release a pending EOF observer without undoing that
already-committed EOF. Before EOF, abort rejects CANCELLED and no later completion is emitted.
