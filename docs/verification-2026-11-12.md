# Local verification — 2026-11-12

The developer authorized running the missing commands, committing, pushing and opening a PR into
dev. Scope is all source on feature/m0-scaffold (M0–M4). This is verification evidence, not a release,
an assertion of all milestone acceptance, or an npm publication.

## Environment and unresolved decisions

- Actual local execution: Windows, Node v22.22.3. The target is Node 24; only Node 20/22 were found
  installed. Approval was requested for portable official Node v24.22.3 (37.8 MB Windows ZIP) with
  no global/default-runtime change. It has not been downloaded or run without that approval.
- The package is private with no initial version. Approval was requested for initial 0.1.0, but
  no version selection/bump was performed. Packed checks intentionally stop at that missing input.
- These pending decisions are not inferred from elapsed time or the request to push a PR.

## Executed commands

| Command | Actual result on Node 22.22.3 |
|---|---|
| npm run lint | Passed, 82 files, no diagnostics after formatting |
| npm run typecheck | Passed all production/browser/test/tool/playground/fixture projects |
| npm run test:coverage | Passed: 21 test files, 131 tests; 89.73% source lines, 86.4% statements, 78.62% branches, 89.69% functions |
| npm run build | Passed ESM/declarations; no source maps; deprecated external option replaced with confirmed deps.neverBundle |
| npm run size | All budgets passed; complete emitted JS approximately 22.4 kB gzip, excluding external dependencies |
| npm run docs | Passed with zero warnings after inlining public handle/option documentation |
| npm run playground:smoke | Passed authenticated unary call, context, cross-entry RpcError identity and host-preserving disposal |
| npm run test:stress | Passed 35 native connection/slow-stream cycles and 35 malformed peers; all seven memory samples within the regression envelope |
| npm run playground | Started Vite/Fastify; HTML and transformed browser module returned HTTP 200; stopped afterward |
| node scripts/checkPackage.mjs | Passed actual dist export inventory, installed browser dependency graph and import-time WebSocket isolation |
| npm run check:exports | Blocked/failed at publint's npm pack: package must have name and version |
| npm run check:consumers | Blocked/failed at its explicit initial-version guard; no isolated installs performed |

Stress sample baseline/last retained heap: 18,354,688 / 19,424,248 bytes; external memory:
4,724,779 / 4,677,152 bytes. This finite 32 MiB regression envelope is not proof of exact per-stream
memory, total process-memory bounds or a long-run plateau. Raw stress output stays local in the
ignored fixtures/.artifacts/stress.json, which records the actual Node version and sample series.

## Browser and device limits

The browser automation host and native UI pipe both reported unavailable. No actual browser button
interaction or visual result is claimed from HTTP 200/module transformation. Android/iPadOS physical
devices were not available; native Expo/Blob behavior remains unverified. Do not substitute source
typing, the standard Node WebSocket implementation or local byte slicing for those required records.

## Documentation/build cleanup

TypeDoc now inlines the approved handles and options instead of adding unapproved type exports.
The internal generic Snapshots alias is explicitly intentionallyNotExported; its readonly per-name
shape is documented in the approved contract/README. Mermaid fencing is retained without a new
highlighting/rendering dependency. Existing validation/coverage/size limits were not weakened.

Personal .vscode preferences, local test logs, generated dist/docs/coverage, native stress data and
temporary packed artifacts are excluded from Git. No npm token, license/version choice, publishing,
tag, merge into dev/main, installed Git hook or new dependency is part of this handoff. A draft PR
records the incomplete target-runtime/packed/browser/device acceptance rather than hiding it.
