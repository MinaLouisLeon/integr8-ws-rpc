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

M5: press Queue an increment before Connect. The explicit queue retains bounded encoded input;
Connect dispatches it and a completed application receipt prints the acknowledged total. Pressing
Typed lookup while offline still fails immediately. Close disposes the queue before the connection.
The application's delivery.increment/status routes validate number arrays and derive scope from
authenticated context; helper bytes are mapped at that boundary. Receipts and deduplication live
only in this server process. Reload/restart loses them, and local cancellation does not prove the
mutation rolled back. The new browser flow has not run; real lost-response/reconciliation source
is in src/client/offlineDelivery.test.ts and remains developer-run.

M6 opt-in example: after installing approved dependencies and regenerating the lockfile, run
npm run playground:react. It uses the same loopback host/fake credentials and port 5173. The React
entry shows connection state, manual lookup and explicit increment under a caller-owned
QueryClientProvider/StrictMode root. Read/mutate before ready must fail immediately; connecting
afterwards must not replay those calls. Closing is terminal; reload creates a new handle.

Observe that focus, browser online/offline, rerender and transport reconnect never issue a lookup
or mutation without another explicit action. Pagehide unmounts React, clears the example cache
and closes its owned connection. The hooks themselves do not own that connection. The new flow
has not run; source typing, SSR probes and successful HTTP responses are not browser acceptance.
