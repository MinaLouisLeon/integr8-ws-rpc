# Consumer and acceptance fixtures

`transport/` is a compile-only characterization against source, run by npm run fixtures and the full
typecheck. It is not packed/browser/native runtime evidence.

`consumers/` imports only the installed public package entries. npm run check:consumers requires a
built dist and a developer-selected package version. It invokes npm pack with scripts disabled,
validates the file inventory, creates isolated Node/browser directories outside the repository, installs
the exact tarball plus the already approved tool versions, typechecks without source paths/aliases,
runs a real loopback Node exchange and bundles the browser entry. Installation intentionally occurs
only when the developer invokes this command; it does not change the repository's manifest/lockfile.

Browser graph inspection rejects server/Node/React/Expo modules, missing chunks and external imports,
including lazy chunks. The entry instantiates a lazy handle so tree-shaking cannot make the whole
client disappear. The complete emitted JS has an initial 150 KiB gzip fixture ceiling; the evidence
records measured bytes, not just the library entry. This is a regression budget, not a measurement
already obtained. Browser bundling is separate from the real-browser playground acceptance run.

Each run retains its tarball, browser output, copied consumer manifests/lockfiles and evidence.json
under .artifacts; installations stay in a separate retained temporary directory. This avoids fallback
to this repository's node_modules and avoids uploading installed dependencies as CI artifacts.
Evidence includes the
exact artifact SHA-256/version, Node version, command list, each lockfile hash and browser graph.
A failed execution stays incomplete. No cleanup deletes artifacts automatically; these files are
gitignored and never included in the npm package. Review/redact absolute local paths before sharing
logs. A pass record does not imply native-device or complete lifecycle/stress acceptance.

`expo/runDevice.ts` is a native runtime probe for an existing Expo app. It is also copied to the
packed browser consumer for typechecking, which is explicitly not native runtime evidence.
See [device instructions](expo/README.md) and [the acceptance matrix](../docs/acceptance.md).

No npm version, tarball hash, device result or fixture pass is invented. All new M3 runtime commands
remain developer-run until explicit authorization is given.

M4 extension: source and packed declaration assertions include heterogeneous groups, exact names,
required context and byte/progress types. The packed browser entry uses both new helpers so the
graph audit/complete-JS budget includes their runtime cost. The Node fixture uses group ownership
and sends helper slices as Blobs through the application's example binarySize procedure, checking
actual replies separately from local progress. These extensions are source/typecheck evidence only
until the existing packed runner is executed after build/version selection.
