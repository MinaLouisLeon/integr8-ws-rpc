# M3 consumers and release readiness implementation plan

> Execute inline under AGENTS.md: no sub-agents or new dependencies. Existing approved SPEC is
> the design authority; the developer explicitly requested M3 source work. Lint/typecheck remain
> authorized from prior turns. Tests, builds, installs, servers, devices and package checks remain
> developer-run. Checkmarks mean source written unless execution evidence is explicitly recorded.

**Goal:** Make the first transport slice reviewable through real consumers, stress scenarios and
release tooling without claiming a release or inventing native-device evidence.

**Architecture:** Preserve the four public entries. Share a typed fake-token sample router between
playgrounds and clean consumer fixtures; client imports of its type erase server code. A developer-run
runner packs the built package, installs it into isolated Node/browser consumers, checks declarations,
executes Node RPC and builds/audits the browser bundle. An injectable device probe runs in an existing
Expo app against a developer-supplied wss endpoint. No new runtime dependencies or public contracts.

**Tech stack:** Existing oRPC 1.16.2/Zod/Fastify; approved Vite 8.3.8/TypeScript 6.0.3/shared presets.
**Spec:** [SPEC](../../SPEC.md), M3 and required verification scenarios.

## Decisions and constraints

- Use approved Vite for the browser rather than introducing another bundler/test browser dependency.
- Keep native UI/bootstrap in an existing Expo app; adding an Expo project would require dependency
  version approval. Cost: device evidence requires the developer's existing app and real devices.
- Initial package version is still the developer's decision. Packed checks fail clearly until set.
- Pin shared CI to remotely advertised main commit 7f7144a23e065ec064c56c7920c88d32c61cc7ce;
  its reusable workflow was inspected with git show. Private-repository Actions access is host-owned.
- Provide shared hook configuration without installing a new Lefthook dependency or hooks.
- Do not add release publishing automation, version bumps, tags, app schemas or M4–M6 features.

## Task 1: Consumer contract, playground and device probe

- [x] Write shared typed example router (calls, typed error, bounded finite stream).
- [x] Write Node real-socket consumer and browser connect/call/subscribe/dispose controls.
- [x] Write Expo probe with safe results and cleanup, plus device evidence instructions.
- [x] Use explicit loopback origin policy for browser and absent-Origin policy for Node.

## Task 2: Packed consumer checks

- [x] Write isolated consumers and positive/negative declaration checks through public imports.
- [x] Write developer-run packing/install/typecheck/Node RPC/browser build driver.
- [x] Write inspection of browser module graph, static/dynamic imports, emitted gzip bytes and forbidden Node
  adapters/React/server code. Record tarball SHA-256, resolved lockfile and environment.
- [x] Write adjacent tests for artifact validation and path/graph rejection helpers.

## Task 3: Upstream/socket stress coverage

- [x] Add malformed-peer isolation, simultaneous slow/healthy consumers and repeated cleanup tests.
- [x] Add real native socket stress runner with finite workload and retained-memory observations.
- [x] Keep stress observations distinct from proof of all memory bounds; require developer evidence.

## Task 4: Release documentation, CI and hooks

- [x] Expand README with setup, state diagram, lifecycle, gaps, policies, support and migration.
- [x] Add unreleased CHANGELOG, manual acceptance/evidence matrix and exact commands.
- [x] Add pinned shared PR CI targeting dev, supplemental M3 checks and shared hook extension.
- [x] Keep TypeDoc on the public entry points; update SPEC progress with written vs verified status.

## Verification and review

- [x] Run previously authorized lint and full typecheck; fix new diagnostics without widening types.
- [x] Source self-review only (AGENTS prohibits sub-agents).
- [x] Leave tests/build/pack/browser/server/native execution to the developer and record no pass
  claims for unrun checks. M0/M1/M2 gates remain open; M3 cannot pass on compilation alone.

## Execution record — 2026-11-12

All task checkmarks denote source written. Only lint and typecheck executed: the expanded full
typecheck exited 0, including browser-free-of-Node ambient types, test/scripts/config, playground,
transport and new source consumer/device probes. Lint safe fixes formatted/organized new files;
the final plain lint result is recorded in SPEC/handoff. No runtime/unit tests, build, install,
packed consumer run, browser/server, stress/device or CI execution occurred. No agents or commits.

Ruling: use oRPC safe for the Node fixture's typed application rejection, because isDefinedError
cannot recover a typed error union from catch(unknown). No casts or router type weakening.

Ruling: install packed consumers in separate temporary directories outside the repository, because
nested fixtures can accidentally resolve undeclared dependencies from root node_modules. Retain
tarball/lock/graph/browser-output records under fixtures/.artifacts, not entire dependency installs.

Ruling: leave native/UI/bootstrap and new hook-binary dependencies in the developer's existing tools;
source probes and config are provided without selecting unapproved package versions. Physical-device
and hook-install evidence remains pending. The initial package version/license is not selected here.

Source self-review corrected proxy target path duplication, observer error typing, browser entry
tree-shaking risk, consumer dependency fallback, and stress pass recording before cleanup. These
runtime-sensitive paths still require developer-run checks; compilation does not verify them.
