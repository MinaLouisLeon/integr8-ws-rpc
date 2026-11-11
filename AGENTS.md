# AGENTS.md — integr8-wc-rpc

This directory is the implementation repository for **@integr8-media/ws-rpc**, the reusable
WebSocket RPC transport in Phase 02 of Integr8 Workbench. The local folder is named
`integr8-wc-rpc`; keep the npm identity `@integr8-media/ws-rpc` from the approved project plan.
Do not rename the folder or publish a differently named package without the developer's direction.

## Start here

Read `docs/SPEC.md` fully before implementation. It defines the package boundary, proposed public
contract, first delivery, full backlog, verification cases and progress. The developer requested
this spec for implementation; no extra permission is needed to read it while working on this package.

Implement one milestone at a time: M0 scaffold and dependency decisions, then M1 calls/handshake,
M2 lifecycle/streams, M3 real consumers and packaging. M4–M6 are follow-ons, not prerequisites for
Workbench's first shell. Do not mark the entire feature backlog complete after M3.

## Working rules

- Read-only inspection and documentation edits are allowed. The developer runs dependency installs,
  lint, typecheck, tests, builds, playgrounds, fixtures, size/export checks and application servers.
  Write the tests and fixtures, but do not run those implementation commands unless the developer
  explicitly overrides this rule in the session.
- Before adding or upgrading a runtime, development, peer or optional dependency, present its name,
  proposed version, purpose, approximate size and license. Wait for approval; then edit the manifest
  and let the developer install. Naming a library in SPEC.md is not version approval.
- Confirm the oRPC release line and its actual adapter APIs before coding. Do not mix v1 and v2
  examples or invent a parallel JSON-RPC protocol.
- Preserve the spec's public contracts. Ask before changing exports, types, errors, wire contracts,
  authentication semantics, defaults or runtime support. Update the spec with an approved change.
- Routine internal implementation choices within the contract do not need another approval.
- Keep progress in the SPEC's Progress section after each milestone: files/code written, branch,
  developer-run evidence and remaining scope. Do not label unrun checks as passing.
- No Workbench imports, product schemas, persistence, pairing UI, token database, filesystem or PTY
  implementations in this package. Accept adapters and caller-provided context.
- Do not add React, TanStack Query or Expo/native dependencies to the initial runtime graph.
- Do not create sub-agents without explicit developer permission.

## Conventions

- Node 24 for server/tooling; strict TypeScript, ES modules and named exports only. Default exports
  are allowed only where a configuration file requires one.
- Use `@integr8-media/config` presets/workflows after its exact usable version and exports are
  confirmed. Follow the spec's entry-point separation; importing the client must not load Node code.
- Package manager: npm with package-lock.json, consistent with the existing standalone packages.
- Give public functions explicit return types and public exports TSDoc. Do not use `any` to bypass
  transport/router inference; use upstream types and boundary validation.
- Adjacent tests (`foo.test.ts` beside `foo.ts`); camelCase TypeScript filenames; `playground/`,
  `fixtures/`, `docs/` at the root. Public barrels contain exports, not startup side effects.
- Biome formatting: two spaces, 100-column width, single quotes in TypeScript, semicolons and
  trailing commas. Use the shared preset rather than reproducing it.
- Typed errors with stable codes; never throw strings or log credentials/full request payloads.
- Package only `dist`; exclude tests, playgrounds, fixtures and source-containing sourcemaps.

## Git and release

- Inspect actual repository state before git work. Work on `feature/*` from `dev`; do not invent an
  initialized repository, branch, remote, release or published version from an empty directory.
- Do not commit to main/dev. Ask before pushing or opening a PR; PRs target dev.
- Never automatically bump versions, tag, publish, merge into main/dev or add npm tokens.
- The developer controls first publication and configures trusted publishing. Shared CI runs on
  PRs into dev; release automation follows the confirmed shared config workflow contract.

## Task handoff

Report files changed, milestone progress, unresolved decisions and exact developer-run checks.
Only list scripts that actually exist. State clearly when checks were not run. Do not install,
implement later milestones or publish merely because this repository now has a spec.
