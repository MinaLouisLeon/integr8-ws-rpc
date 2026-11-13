# M6 dependency proposal

Status: **approved by the developer**, 2026-11-13. Registry metadata was inspected without
installing packages or executing their code. Exact pins/ranges below are approved for manifest edits.
See [contract proposal](superpowers/specs/2026-11-13-m6-react-query-design.md).

## Direct packages

Sizes are approximate **unpacked package bytes**, not gzip bundle costs or installed totals.
All listed direct packages report MIT in their official npm metadata.

| Package | Exact development pin | Proposed published role/range | Purpose | Approx. unpacked size | License |
|---|---|---|---|---|---|
| react | 19.3.1 | Optional peer ^19.0.0; also dev | useSyncExternalStore and hooks | 179 kB | MIT |
| @tanstack/react-query | 5.107.1 | Optional peer ^5.107.1; also dev | Query/mutation hooks and public inference | 1.80 MB | MIT |
| @types/react | 19.3.0 | Optional type peer ^19.0.0; also dev | React/Query declarations for TS consumers | 408 kB | MIT |
| react-dom | 19.3.1 | Dev only | Real hook mounting/StrictMode/SSR/hydration tests and example | 8.07 MB | MIT |
| @types/react-dom | 19.3.0 | Dev only | Typed ReactDOM tests and example | 33 kB | MIT |
| jsdom | 27.4.0 | Dev only | DOM for real React hook tests under Vitest | 3.31 MB | MIT |

All optional peers get peerDependenciesMeta.optional:true. JavaScript /react consumers provide
React/Query; TypeScript /react consumers also provide React types. Existing entries neither import
nor declare references to those peers. No ordinary production dependency is added for M6.

Transitive costs: react-query pins @tanstack/query-core 5.107.1 (MIT, about 3.90 MB unpacked);
react-dom brings scheduler ^0.28.0; React types bring csstype; jsdom has its own substantial DOM/
URL/CSS dependency graph. The sizes above exclude these dependencies. No canvas/native graphics
dependency is requested. Exact resolved transitive versions/integrities belong to the developer's
new package-lock after install, not guessed lockfile entries.

jsdom latest is 31.0.1, but its engine is ^22.22.2 || ^24.15.0 || >=26.0.0. Proposed 27.4.0 supports
^20.19.0 || ^22.12.0 || >=24.0.0 and avoids narrowing this package's existing Node >=24 tooling
contract. This choice is for the dev test environment; it changes no server/browser runtime support.
ReactDOM 19.3.1 requires React ^19.3.1; exact paired dev pins satisfy that. Query declares React and
React types ^18 || ^19; the proposed optional peers intentionally support the local React 19 family.

## Primary references and API inspection

- [React 19.3.1 registry metadata](https://registry.npmjs.org/react/19.3.1)
- [ReactDOM 19.3.1 registry metadata](https://registry.npmjs.org/react-dom/19.3.1)
- [React Query 5.107.1 registry metadata](https://registry.npmjs.org/@tanstack%2freact-query/5.107.1)
- [React types 19.3.0 metadata](https://registry.npmjs.org/@types%2freact/19.3.0)
- [ReactDOM types 19.3.0 metadata](https://registry.npmjs.org/@types%2freact-dom/19.3.0)
- [jsdom 27.4.0 metadata](https://registry.npmjs.org/jsdom/27.4.0)
- [React external-store hook](https://react.dev/reference/react/useSyncExternalStore)
- [Query retries](https://tanstack.com/query/latest/docs/framework/react/guides/query-retries)

Context7 supplied official React/Query references. The exact published react-query 5.107.1 archive
was downloaded into a temporary directory and its useQuery/useMutation/types source read without
installing/executing it. APIs accept options plus optional QueryClient and preserve generic data,
variables and error parameters. The existing oRPC line remains 1.16.2 and is not upgraded or
replaced with v2 examples. No @orpc/tanstack-query adapter or second RPC protocol is proposed.

Manifest pins/ranges are now written. The developer must run npm install and regenerate
package-lock.json before npm ci/CI or implementation checks. The lockfile is intentionally not
hand-edited with guessed transitive records. No npm install, lint, typecheck, tests, build,
playground, pack, size/export/API-doc or server command ran during implementation. The subsequent
explicitly authorized lint/typecheck follow-up passes with the already available dependencies;
the agent did not install or modify package-lock. See SPEC Progress for current verification.
