'use strict';

// ─── Exception bucket classifiers (KQL fragments) ─────────────────────────────
//
// Single source of truth shared by the app health check (azure-metrics.cjs) and
// the incident report (incident-report.cjs), so the two features can never
// disagree about what counts as a socket failure.
//
// The three buckets are mutually exclusive and cover every exception row:
//   socket  → SOCKET_MATCH        transport failed, no connection established
//   timeout → TIMEOUT_ONLY_MATCH  connected, caller gave up waiting
//   oom     → OOM_ONLY_MATCH      the process ran out of memory
//   generic → GENERIC_MATCH       everything else
//
// Socket wins ties: a SocketException whose message says "timed out" is a
// transport failure, not an application timeout.

// NOTE ON `has` vs `contains` FOR TYPE NAMES
// `has` matches whole terms, and Kusto tokenizes a type name on the dots only:
// "StackExchange.Redis.RedisTimeoutException" yields the terms StackExchange,
// Redis, RedisTimeoutException. So `type has "TimeoutException"` matches
// System.TimeoutException but NOT RedisTimeoutException — measured as 0 of 21 on
// live telemetry. Type checks therefore use `contains` (substring) so vendor
// exception names that concatenate a prefix are caught: RedisTimeoutException,
// WebSocketException, SqlTimeoutException. Message checks keep `has_any`, where
// term matching is what we want.

// Transport layer. The inner exception is checked too because .NET wraps
// SocketException inside HttpRequestException — outerMessage alone misses real ones.
const SOCKET_MSG_PATTERNS = '"SocketException","No buffer space available","ENOBUFS","actively refused","Connection refused","ETIMEDOUT","SNAT","An attempt was made to access a socket"';
const SOCKET_MATCH =
  `(outerMessage has_any (${SOCKET_MSG_PATTERNS})` +
  ` or innermostMessage has_any (${SOCKET_MSG_PATTERNS})` +
  ` or type contains "SocketException" or innermostType contains "SocketException")`;

// Application level: SQL command timeouts, HttpClient.Timeout cancellations,
// Redis timeouts, explicit TimeoutException. A connection existed — the fix is
// query tuning or deadlines, not ports or pooling.
const TIMEOUT_MSG_PATTERNS = '"timeout","timed out","Timeout Expired","timeout period elapsed"';
const TIMEOUT_MATCH =
  `(outerMessage has_any (${TIMEOUT_MSG_PATTERNS})` +
  ` or innermostMessage has_any (${TIMEOUT_MSG_PATTERNS})` +
  ` or type contains "TimeoutException" or innermostType contains "TimeoutException")`;

// Memory exhaustion. Type-based first because that is unambiguous; the message
// patterns are the exact framework strings. Deliberately NOT matching a bare
// "memory", which would sweep in MemoryStream and cache errors.
const OOM_MSG_PATTERNS = '"OutOfMemoryException","Insufficient memory","Out of memory"';
const OOM_MATCH =
  `(type contains "OutOfMemoryException" or innermostType contains "OutOfMemoryException"` +
  ` or outerMessage has_any (${OOM_MSG_PATTERNS})` +
  ` or innermostMessage has_any (${OOM_MSG_PATTERNS}))`;

const TIMEOUT_ONLY_MATCH = `(not(${SOCKET_MATCH}) and ${TIMEOUT_MATCH})`;
const OOM_ONLY_MATCH     = `(not(${SOCKET_MATCH}) and not(${TIMEOUT_MATCH}) and ${OOM_MATCH})`;
const GENERIC_MATCH      = `(not(${SOCKET_MATCH}) and not(${TIMEOUT_MATCH}) and not(${OOM_MATCH}))`;

// Assigns every row to exactly one bucket. Column name is the caller's choice.
// Precedence matches the *_ONLY_MATCH predicates above: socket → timeout → oom →
// generic. Measured overlap between OOM and socket/timeout is zero on live data,
// so the order is a formality rather than a judgement call.
const BUCKET_EXPR = `iff(${SOCKET_MATCH}, "socket", iff(${TIMEOUT_MATCH}, "timeout", iff(${OOM_MATCH}, "oom", "generic")))`;

// ─── Dependency result codes that genuinely indicate a timeout ────────────────
// Each verified against observed p95 duration on live telemetry:
//   408       Request Timeout
//   504       Gateway Timeout                      (p95 ~60s)
//   524       Cloudflare "A Timeout Occurred"      (p95 ~147s)
//   Canceled  .NET HttpClient deadline elapsed     (p95 ≈ the configured timeout, ~30s)
//   -2        SQL Server timeout error code        (SqlClient command timeout, p95 ~30s)
// 500/502/503 are server errors, not timeouts, and are deliberately excluded —
// counting them made ad-server 500s and static-asset 502s read as timeouts.
// `Faulted` is an instant fault (p95 2ms), not a timeout.
const TIMEOUT_RESULT_CODES = '"408","504","524","Canceled","-2"';

module.exports = {
  SOCKET_MSG_PATTERNS,
  SOCKET_MATCH,
  TIMEOUT_MSG_PATTERNS,
  TIMEOUT_MATCH,
  TIMEOUT_ONLY_MATCH,
  OOM_MSG_PATTERNS,
  OOM_MATCH,
  OOM_ONLY_MATCH,
  GENERIC_MATCH,
  BUCKET_EXPR,
  TIMEOUT_RESULT_CODES,
};
