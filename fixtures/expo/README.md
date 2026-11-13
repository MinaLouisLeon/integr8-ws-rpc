# Expo device probe — Android and iPadOS

This is source for an existing Expo application, not a newly installed Expo project. It adds no
React/native dependency to the transport or this repository. Actual device checks are pending.

1. Build and run npm run check:consumers after choosing the initial package version. Retain the exact
   tarball and SHA-256 from evidence.json. Install that tarball into your existing Expo app using its
   package manager; use the same artifact on Android and iPadOS. Record its resolved dependency lock.
2. Copy runDevice.ts and playground/router.ts (named router.ts beside it) into that application.
   The router import in the probe is type-only; do not import its server value into the native bundle.
   The existing app's type tooling must resolve the matching oRPC/Zod declarations.
3. Host exampleRouter behind the public server/Fastify factories with the example fake-token auth
   policy. Provide a reachable wss endpoint with a trusted certificate and an explicit native
   absent-Origin policy. The local playground binds loopback; it is not reachable from a physical
   device by substituting a LAN ws URL (the client intentionally rejects that URL).
4. Invoke runDevice from an existing screen/control. Pass the actual platform, Expo/runtime version,
   artifact SHA-256, and RpcClientOptions with protocolVersions:[1], getToken returning only fixture
   credentials and createWebSocket using the app's real compatible WebSocket. Do not cast an
   incompatible native socket to the DOM type; record a compatibility failure if adaptation is needed.
5. Retain the returned safe result plus device model, OS version, Expo SDK/runtime, Hermes/JSC,
   physical-device vs simulator, network/TLS setup, artifact/lock hash and timestamp. A pass exercises
   authenticated unary, ordered finite stream, pre-abort and close. It does not prove every M2 branch.
6. Separately verify network loss/reconnect, gap notification, abort after first item, unsubscribe,
   app background/resume and repeated unmount/remount. Capture sanitized diagnostics only. Confirm
   there are no duplicate deliveries, late callbacks or continued socket/heartbeat activity after close.

Expected result on both physical Android and iPadOS: passed result with received:3 and a final closed
state. Do not fill the acceptance matrix until execution occurs. A compiler/browser build result
cannot be substituted for either real-device row.

M4 probe additions: group ownership and local Uint8Array slicing run alongside the existing checks;
localBinaryBytes:3 describes only local slicing. For native Blob/oRPC verification, run again with
verifyBinaryRpc:true against the updated exampleRouter. Expected binaryRpcBytes:3 is returned only
after real procedure replies; otherwise it stays null, explicitly meaning not checked. Preserve each
device's actual result or compatibility failure. Compilation and local slicing do not establish
native Blob support. Also test abort during reads/callbacks and unsubscribe in the native runtime.
