# Transport errors

`RpcError` uses `new RpcError(code, { cause })` with a fixed safe message for each transport code.
The second argument is optional. The original cause is local debugging data and must not be logged
or sent to peers. Typed oRPC application errors remain separate; do not wrap them in RpcError.

The following describes implementation intent, not execution evidence; all checks remain unrun.

| Code | Recovery / meaning | Mutation outcome |
|---|---|---|
| INVALID_OPTION | Terminal; correct configuration | No send for invalid configuration |
| AUTH_FAILED | Terminal; create a new handle with valid credentials | No authorized app send |
| AUTH_EXPIRED | Session invalid; fresh authentication is required | Active work may already have committed |
| PROTOCOL_MISMATCH | Terminal; provide compatible application/transport versions | No authorized app send |
| HANDSHAKE_TIMEOUT | Handshake failed within the attempt deadline; retry only per finite policy | No app send before ready |
| DISCONNECTED | Rejected before send; connect and explicitly issue a new call | This rejected call was not queued |
| OUTCOME_UNKNOWN | Connection lost after send; reconcile through the application contract | Unknown; never automatically replay |
| TIMEOUT | Deadline elapsed; request cooperative cancellation | May already have committed |
| CANCELLED | Caller cancelled; stop local delivery and propagate abort | May already have committed |
| CLOSED | Terminal for this handle; create a new handle | Active work may already have committed |
| LIMIT_EXCEEDED | Capacity exceeded; caller may explicitly try after capacity frees | A call rejected before send did not execute |
| BACKPRESSURE | Fail the stream or close an over-buffered connection | Already-sent work may have committed |
| PAYLOAD_TOO_LARGE | Reject/close the affected operation or peer; fix payload/configuration | Do not infer rollback of other active work |
| INVALID_MESSAGE | Close only the malformed peer's connection | Other sent operations may be uncertain |
| INTERNAL | Transport failure; surface a safe code and clean up | Do not infer that sent work did not execute |

Retries are connection retries, not application call retries. Cancellation is cooperative and never
proof of rollback. Exact retry/error mapping and resource cleanup still require M1/M2 verification.

Server transport failures use upstream ORPCError frames with defined:false, a stable transport
code and fixed safe message; native causes are not serialized. The client maps recognized undefined
transport codes to RpcError. Defined application errors retain upstream identity/data even when their
code matches a transport code. Socket close reasons are restricted to known safe codes.

M4 group lifecycle failures are sanitized to existing RpcError codes; connectAll publishes only
fulfilled or rejected-with-code per child. Cleanup tries every child before reporting a safe failure.
No routing/failover/replay is added. The binary helper throws INVALID_OPTION for malformed config,
PAYLOAD_TOO_LARGE for input beyond the explicit budget, INTERNAL for platform reads and CANCELLED
for pre-EOF cancellation. Progress callback exceptions remain application exceptions. Local EOF
is committed before notifying it; a later abort can release the notification wait without undoing
EOF. None of these local progress/error states proves an application transfer was committed.

M5 adds no codes. Invalid queue/ledger options or local keys use INVALID_OPTION; malformed remote
commands/receipts or conflicting scoped-key content use INVALID_MESSAGE. Admission bounds use
LIMIT_EXCEEDED; input/result payload bounds use PAYLOAD_TOO_LARGE. Ledger result-codec failures
use safe INTERNAL and preserve an uncertain tombstone. Application handler/delivery errors retain
their identity, never become success acknowledgements, and never authorize replay.

Unsent queue expiry uses TIMEOUT; invoked expiry/close uses OUTCOME_UNKNOWN. Local cancel/abort uses
CANCELLED even if server work may already commit. Queue close uses CLOSED for unsent tickets;
ledger close rejects active observers CLOSED and requests cooperative handler shutdown. Terminal
AUTH_FAILED/PROTOCOL_MISMATCH rejects unsent tickets with that code and invoked tickets with
OUTCOME_UNKNOWN. Missing/pending/uncertain receipts leave a ticket unresolved until another bounded
reconciliation, expiry, cancellation or close. A status lookup failure does not resend the command.

M6 adds no error codes. Explicit query/mutation callbacks reject DISCONNECTED unless the borrowed
handle is ready, or CLOSED when explicitly closed. Cache scope/key/duration validation uses
INVALID_OPTION. Query and mutation errors remain the original unknown value for safe narrowing;
do not claim inference of Promise rejection types or wrap application ORPCError data. Query retry
and offline pause are disabled, so OUTCOME_UNKNOWN remains visible without replay. Query cancel
forwards its signal; mutation signals remain caller-owned variables. Neither unmount nor a query
error is evidence that a handler rolled back. These are source contracts, not executed M6 results.
