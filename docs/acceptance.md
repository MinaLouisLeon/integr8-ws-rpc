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
