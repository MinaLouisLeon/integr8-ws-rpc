# Loopback smoke playground

After dependency installation, the developer can run `npm run playground:smoke` on Node 24.11+.
It builds and runs smoke.mjs: ephemeral loopback Fastify listener, explicit absent-Origin policy,
fake-token hello, authenticated unary context and adapter disposal preserving host ownership.
All resources close in finally. No credentials or request payloads are logged.

The example imports built server/Fastify/client entries, exercising shared internal server-handle
identity across output chunks. Type inference is checked separately by the transport fixture.
This script has not run. Packed consumers and Expo device evidence remain M3.

The M3 browser example is started by npm run playground (build then dev.mjs). It hosts Vite at
http://127.0.0.1:5173 and proxies /rpc to an ephemeral Fastify port. The proxy preserves the browser
Origin; the server explicitly permits that exact origin and absent Origin for Node. No allow-all
policy or query/subprotocol credentials. Ctrl+C closes both servers. The library transport is loaded
through built public entries; router.ts is only a type import in browser code.

The buttons exercise connect, typed lookup, a finite stream, unsubscribe and close. Output is bounded
and only example data/safe errors are rendered with textContent. Close is terminal; reload for another
handle. Disconnect/reconnect/gap, revoked credentials and browser developer-tools leak observations
still need the manual acceptance runs in docs/acceptance.md. No browser execution is claimed here.

M4 uses a static group as lifecycle owner. Inspect binary chunks demonstrates a small input budget,
two-byte slices and local prepared-byte progress, followed by replies from the application-owned
binarySize procedure. Its displayed local done flag is not an acknowledgement or persistence promise.
Real multi-server isolation is characterized separately with distinct typed/authenticated server
handles in independentHandles.test.ts; the browser example's single group entry is not that proof.
