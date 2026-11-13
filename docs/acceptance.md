# First-slice acceptance evidence

M3 readiness requires actual evidence for M0–M3, not just source presence. The developer has now
authorized execution, commit/push and a PR. See [actual local results](verification-2026-11-12.md):
131 tests and local build/size/docs/smoke/stress pass on Node 22.22.3, while Node 24 target verification,
packed checks and browser/device acceptance remain open. Version/publication decisions stay explicit.

| Check | Existing command / method | Current evidence |
|---|---|---|
| Lint | npm run lint | Passed; final M3 rerun recorded in task handoff |
| Production/browser/test/config/fixtures | npm run typecheck | Passed including source M3 probes; final rerun recorded in handoff |
| Source line coverage >=80% | npm run test:coverage | Passed on Node 22: 131 tests, 89.73% lines; Node 24 pending |
| ESM/declarations | npm run build | Passed locally; target-runtime validation pending |
| Emitted gzip budgets | npm run size | Passed; all emitted JS 22.4 kB gzip; externals excluded |
| Package metadata/types/import graph | npm run check:exports | Blocked at missing version; direct checkPackage.mjs graph/import check passed |
| Packed Node/browser/types | npm run check:consumers | Blocked at initial-version guard; no isolated installs |
| Node unary playground | npm run playground:smoke | Passed on Node 22 |
| Real browser connect/call/stream/close | npm run playground | Server/HTML/module HTTP passed; browser host unavailable, UI pending |
| Slow/malformed peers and retained memory | npm run test:stress | Passed on Node 22; 35 cycles and malformed peers; bounded regression only |
| Public API docs | npm run docs | Passed with zero warnings |
| Android device | fixtures/expo/README.md | Pending; physical device and exact artifact required |
| iPadOS device | fixtures/expo/README.md | Pending; physical device and exact artifact required |
| Shared CI / hooks | PR into dev; shared lefthook.yml | Written, not executed/installed |

## Manual scenarios and required observations

- Handshake: reject wrong token, expired/revoked token, forbidden Origin, absent Origin without
  explicit permission, incompatible versions, second/concurrent hello and parallel pre-auth calls.
  No app operation runs before ready. No credential appears in a URL, exception/log or snapshot.
- Calls: nested input/output/errors remain typed. Abort before sending and during a handler, enforce
  deadlines, then disconnect after mutation commit but before response. Observe OUTCOME_UNKNOWN,
  a single mutation execution and no replay after reconnect. Cancellation never promises rollback.
- Streams: first item, completion, handler error, caller abort, unsubscribe during connect/retry and
  close during delivery. Pause one stream past each capacity while another call/stream remains
  healthy; overflow must report BACKPRESSURE, not silent data loss or a growing upstream queue.
- Lifecycle: concurrent connect/close, credential re-read, auth terminal failure, heartbeat failure,
  retry exhaustion/reset, old-epoch callbacks, proactive expiry and session revocation. Managed
  resubscription opens once per new epoch and reports a gap before items; unsubscribe never reopens.
- Isolation: separate server handles use separate credentials/contexts; one malformed peer or
  disposed adapter does not break healthy peers or the host's unrelated HTTP routes.
- Hygiene: repeat at least 30 connect/stream/close cycles and inspect socket/listener/timer counts.
  Stress observations include heapUsed/external/arrayBuffers/rss, workload/config and time series.

## Stress interpretation

test:stress starts an ephemeral loopback host, runs 35 connections with slow streams and malformed
peers, verifies healthy calls survive, and samples memory after warmup with explicit GC. It records
fixtures/.artifacts/stress.json even on a failure. The initial retained heap/external regression
envelope is 32 MiB between first/last samples. This catches some leaks; it does not prove exact
per-stream/process bounds or a stable long-run plateau. Review the full series, extend workloads,
vary payloads/subscription counts, test binary/malformed frames and inspect raw decoding queues.
Do not report simultaneous 256-item/1-MiB limits proven merely because this budget passes.

## Evidence record to complete after execution

For each row record timestamp, operator, Git commit plus dirty diff/reference, command, exit code,
environment and sanitized output location. Packed runs retain artifact SHA-256, version, lockfile
hashes, browser graph and measured bytes in fixtures/.artifacts/consumer-*/evidence.json. Native
records additionally include device/OS/Expo/runtime/JS engine, endpoint policy and exact artifact.
Do not attach secrets, URLs with credentials, payload logs, npm auth config or native error causes.

Shared CI is pinned to integr8-config commit 7f7144a23e065ec064c56c7920c88d32c61cc7ce. Its reusable
workflow_call inputs were checked from that exact Git object and it runs lint/typecheck/coverage/
build/size/export checks. A supplemental job runs packed consumers, stress and TypeDoc, retaining
artifacts. Access to the private shared workflow must be enabled by the repository owner if needed.
No workflow was pushed/triggered. Hook configuration extends config 1.2.0, but no Lefthook binary
or Git hooks were installed; installing a new development dependency still needs version approval.

No release workflow, npm token, version bump, tag or publication is created here. Keep private:true
until the developer explicitly decides the first release, license/metadata and trusted publishing.

## Approved M4 acceptance — runtime results pending

The two /client additions are approved and written. Compile fixtures cover heterogeneous child
schemas/required context, exact keys, readonly registry/progress and byte output. Their unit/native
cases passed within the 131-test run on Node 22; target Node 24/packed/device evidence stays separate:

| Check | Developer-run method | Current evidence |
|---|---|---|
| Registry validation, safe states/results, reentrant and partial-failure cleanup | npm test -- src/client/createRpcClientGroup.test.ts | Passed in full Node 22 coverage run |
| Distinct auth/schema/version sessions under group ownership | npm test -- src/client/independentHandles.test.ts | Passed in full Node 22 coverage run |
| Byte budgets/offsets/copies/pacing/progress/read/callback cancellation | npm test -- src/client/chunkBinary.test.ts | Passed in full Node 22 coverage run |
| Actual encoding overhead still enforces frame caps | npm test -- src/client/peerClient.test.ts | Passed in full Node 22 coverage run |
| Installed declarations, grouped Node RPC and binary replies; full browser JS graph/cost | npm run build then npm run check:consumers | Pending version/build and developer execution |
| Browser helper/typed binary example | npm run playground; Inspect binary chunks | Not executed |
| Native byte helper/group ownership | Expo probe; localBinaryBytes must be 3 | Physical Android/iPadOS unrun |
| Native Blob encoding and application replies | Expo probe with verifyBinaryRpc:true; binaryRpcBytes must be 3 | Physical Android/iPadOS unrun |

The default native probe leaves binaryRpcBytes:null, meaning not checked, never a native binary pass.
Preserve negative compatibility results without casts or fabricated evidence. Test cancellation during
native reads/progress and scope/group shutdown in addition to the basic probe. Progress measures
locally prepared bytes/EOF; neither helper completion nor the memory regression budget proves
delivery, persistence, resume/ack behavior or whole-transfer retained memory. Existing size budgets
and the packed complete-JS ceiling include the new helpers and were not weakened or measured here.

## Approved M5 acceptance — source written, execution pending

M5 was approved on 2026-11-13 and implemented on feature/m5-offline-delivery. The existing helper
defaults and transport/wire contracts remain unchanged. New adjacent tests and fixtures are written;
the follow-up's npm run lint and full npm run typecheck now pass on Node 22.22.3. M5 unit/coverage,
build, size, export, consumer, stress, docs, playground and device checks remain unrun.

| Check | Existing command / method | M5 evidence |
|---|---|---|
| Boundary validation and byte accounting | npm test -- src/core/delivery.test.ts | Written; unrun |
| Queue bounds/FIFO/expiry/cancellation/epochs/reconciliation | npm test -- src/client/createRpcOfflineQueue.test.ts | Written; unrun |
| Scoped ledger races/retention/reservation/uncertainty/close | npm test -- src/server/createRpcDeliveryLedger.test.ts | Written; unrun |
| Lost actual socket response after commit; status under another identity | npm test -- src/client/offlineDelivery.test.ts | Written; unrun |
| Required per-call context and input/result declaration types | npm run typecheck | Passed full source check on Node 22.22.3; packed declarations unrun |
| Full suite and >=80% source lines | npm run test:coverage | M5 unrun; prior numbers are not M5 coverage |
| ESM/declarations and unchanged size/export gates | npm run build; npm run size; npm run check:exports | M5 unrun |
| Packed Node offline admission/ack, browser import graph | npm run check:consumers | Runner/examples expanded; unrun |
| Browser offline admission followed by Connect | npm run playground; Queue an increment before Connect | Written; UI unrun |
| Android/iPadOS number-array application mapping | Expo runDevice; offlineAcknowledgedTotal >=1 | Written; physical devices unrun |
| Stress/smoke/API docs and formatting/lint | npm run test:stress; npm run playground:smoke; npm run docs; npm run lint | M5 verification unrun |

Manually exercise expiry while offline, callback timeout ignoring abort, cancel during dispatch,
close during reconciliation, terminal auth failure, and server restart after an uncertain mutation.
Missing status must never resend. Authenticate/authorize every command/status route; a second user
must not retrieve the first user's result. Server handlers observe the ledger shutdown signal;
aborting a single RPC observer does not cancel this opt-in process-local execution lifetime.

Retain the exact artifact, commit/dirty diff, commands/environment and safe results. Server restart,
close, another worker and retention expiry end deduplication protection. Existing finite stress
budgets and source tests do not prove durability, exactly-once execution or total process bounds.

## Approved M6 acceptance — source written, install and verification pending

Developer approval covers the three-hook /react contract and six exact dependency pins. Run
npm install first and retain the regenerated package-lock; the old lockfile cannot be used with
npm ci for this manifest. Approved dependencies/an updated lockfile were already present for the
follow-up. Lint and full source typecheck now pass on Node 22.22.3; tests/build/pack/SSR/browser
remain unrun. The agent did not install or edit the lockfile during this follow-up.

| Check | Existing command / method | M6 evidence |
|---|---|---|
| Cached state/StrictMode/handle replacement and SSR hydration | npm test -- src/react/useRpcSnapshot.test.ts | Written; unrun |
| Manual reads/default isolation/cache replacement/cancellation/no retry | npm test -- src/react/useRpcQuery.test.ts | Written; unrun |
| Explicit offline fail-fast/no replay/concurrency/caller cancellation | npm test -- src/react/useRpcMutation.test.ts | Written; unrun |
| Safe key/scope/duration boundaries | npm test -- src/react/queryIdentity.test.ts | Written; unrun |
| Five exports, retained use-client directive and baseline graph isolation | npm run check:exports | Written checks; unrun |
| Required context and typed variables/results/unknown errors | npm run typecheck | Passed full source check; required and void mutation arguments covered; packed check unrun |
| Full suite and >=80% source lines | npm run test:coverage | M6 unrun; earlier coverage is not current evidence |
| Build/API docs and original plus React size gates | npm run build; npm run docs; npm run size | Config/source written; unrun |
| No-peer runtime/types, React SSR, full baseline/React JS graphs | npm run check:consumers | Four isolated consumers written; unrun |
| Actual React UI and manual lifecycle behavior | npm run playground:react | Source written; browser unrun |
| Formatting/lint | npm run lint | Passed: 108 files, zero errors/warnings; no lint-rule changes |

Record StrictMode unmount/remount without connection closure, live handle replacement without old
cache data, offline manual failures, explicit cancellation, focus/online/reconnect/invalidation
without calls, and OUTCOME_UNKNOWN without retry. The actual React page must display typed lookup
and explicit increment only after user actions. No stream hook or native React support is claimed.

The separate packed React graph may include React/Query but never server/Node/Expo code. Baseline
browser remains 150 KiB gzip, React complete JS 300 KiB, React emitted entry 10 kB excluding peers;
all existing total/library budgets remain. Preserve measured bytes, exact tarball/lock hashes,
commit/dirty diff, environment and safe command logs. SSR no-fetch probes and declaration typing
are not browser/device verification. No persisted/hydrated Query delivery guarantee is implied.
