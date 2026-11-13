# M0 dependency proposal

Status: **approved by the developer in this session on 2026-11-11** for both M0 tables below.
The approved exact pins/roles are recorded in package.json and the developer-installed lockfile.
Deferred tooling and direct dependencies not in the approved tables still require approval.

Sizes are approximate decimal kB/MB from npm `dist.unpackedSize`, for each package alone.
They are not download, transitive installation or client bundle sizes. Native tool binaries and
transitive packages can make installation substantially larger. Actual size evidence follows build.

## Approved M0 development dependencies

| Package | Exact version | Purpose | Unpacked size | License |
|---|---|---|---|---|
| @integr8-media/config | 1.2.0 | Shared TS, Biome, Vitest, tsdown and size presets | 208 kB | MIT |
| typescript | 6.0.3 | Strict typechecking and declaration tooling | 24.3 MB | Apache-2.0 |
| @types/node | 24.10.0 | Node 24 tooling/server declarations | 2.52 MB | MIT |
| @biomejs/biome | 2.6.6 | Formatting and lint | 1.09 MB plus platform binary | MIT OR Apache-2.0 |
| vitest | 5.1.0 | Adjacent unit and inference tests | 2.88 MB | MIT |
| @vitest/coverage-v8 | 5.1.0 | Matching v8 coverage provider | 30 kB | MIT |
| vite | 8.3.8 | Satisfy Vitest's Vite peer | 2.41 MB | MIT |
| tsdown | 0.23.7 | ESM and declaration build | 185 kB plus transitive binaries | MIT |
| size-limit | 14.3.0 | Size budget runner | 51 kB | MIT |
| @size-limit/file | 14.3.0 | Measure emitted file sizes | 4 kB | MIT |
| publint | 0.3.25 | Packed package metadata checks | 117 kB | MIT |
| @arethetypeswrong/cli | 0.18.5 | Packed export/type resolution checks | 59 kB | MIT |
| typedoc | 0.28.20 | Public API docs | 2.18 MB | Apache-2.0 |

TypeScript 6.0.3 is intentional: TypeDoc 0.28.20's declared peer range stops at 6.0.x.
Registry `latest` currently resolves TypeScript 7.0.2; do not substitute it silently.
tsdown 0.23.7 requires Node 24.11 or newer on the Node 24 line. Proposed development setup:
Node 24.11+; review whether the eventual package engine declaration should be narrower than 24.
This does not change the spec's runtime support.

## Approved transport dependencies for the M0 compatibility fixture

| Package | Exact version | Proposed role and purpose | Unpacked size | License |
|---|---|---|---|---|
| @orpc/client | 1.16.2 | Runtime: client and WebSocket link | 142 kB | MIT |
| @orpc/server | 1.16.2 | Runtime: typed router, middleware, Node ws handler | 337 kB | MIT |
| zod | 4.6.7 | Runtime: handshake boundary schemas | 6.15 MB | MIT |
| ws | 8.22.2 | Runtime: Node socket integration; satisfies server adapter peer | 153 kB | MIT |
| @fastify/websocket | 11.3.7 | Runtime: Fastify upgrade integration | 105 kB | MIT |
| fastify | 5.12.8 | Peer + dev: caller-owned Fastify host and fixture | 3.02 MB | MIT |
| @types/ws | 8.18.2 | Dev: Node socket adapter declarations | 43 kB | MIT |

Propose exact Fastify peer 5.12.8 initially, widening only after compatibility evidence and approval.
oRPC 1.16.2 is the registry stable line observed in this review. All directly used oRPC packages
must use that same release. `@orpc/contract` 1.16.2 is already transitive (92 kB, MIT); do not add
it directly unless the reviewed contract-first fixture imports it. Router-first inference is the
initial proposal. Do not import transitive packages without separately approving a direct dependency.

No React, TanStack Query, Expo/native, optional ws acceleration or retry/reconnect package proposed.
No additional peer dependencies are proposed for the initial scaffold.

## Deferred tooling

Lefthook/shared hooks and shared CI are M3 work. If introduced then, the observed candidate is
`lefthook` 2.2.2 (dev, MIT, 29 kB wrapper plus platform binary), subject to approval at that time.
Playwright, browser bundling and actual Expo runtime tooling are not approved by this proposal.

## Approval and next step

The developer approved the M0 development and transport tables before manifest edits. Approval of
these pins does not settle the bounded-stream implementation or approve a different wire/public
contract. Manifest/config, initial types, tests and fixtures have been written; the developer
installs with npm and owns the generated `package-lock.json`. No lockfile has been fabricated.
The initial package version has been requested separately and remains unset; `private: true`
keeps this incomplete scaffold non-publishable. This does not select a release/version policy.

Metadata sources: version-specific npm registry records under
`https://registry.npmjs.org/<encoded-package-name>/<exact-version>`.
The config 1.2.0 published archive was also inspected for actual exports.

## M1 additional direct dependency — approved

| Package | Exact version | Role / purpose | Approximate unpacked size | License |
|---|---|---|---|---|
| @orpc/standard-server-peer | 1.16.2 | Runtime: use stable ClientPeer with StandardRPCLink to own inbound error handling, peer cancellation and cleanup while retaining upstream encoding/correlation IDs | 46 kB | MIT |

The developer approved this addition in-session after reviewing this proposal. It is now pinned in
package.json and imported by the private M1 client transport. Nothing has been installed.
The package was already a transitive dependency of approved @orpc/client 1.16.2; the earlier
approval tables did not include a direct declaration, so approval was obtained before adding it.
Registry metadata for the exact version reports 46,205 unpacked bytes, with @orpc/shared and
@orpc/standard-server 1.16.2 as dependencies. The developer owns npm installation/lockfile generation.

Why it is needed: the stock WebSocket RPCLink hides its ClientPeer, attaches anonymous listeners,
and calls `peer.message(message)` without awaiting/catching its rejection. A wrapper around those
listeners cannot catch that nested unobserved promise. The stable public ClientPeer API provides
`request`, awaited `message` and `close` while upstream still owns the codec and multiplexing.
StandardRPCLink/StandardLinkClient are public exports of the already-approved @orpc/client/standard.
No experimental class, private queue field, custom ID or alternative JSON-RPC protocol is proposed.

The approved client integration is written in `src/client/{peerClient,connection}.ts`, with
adjacent unrun tests and compile fixtures. It does **not** solve the separate per-subscription
item/byte queue limitation; that remains an open compatibility gate.
