// Load-test traffic writes into production App Insights under its own role — prdmeduadm's
// `prdmeduadm-loadtest` sends requests, performance counters and custom metrics there — and
// skews every health figure. devForge's analyses leave any role ending in `-loadtest` out.
//
// One prelude, prepended to a query: each table is shadowed by a filtered copy of itself
// (`let requests = requests | where …;`). KQL scopes a `let` over every statement after it,
// so a batch of several statements is filtered too, and a table the query never reads costs
// nothing. Checked against the App Insights API on 2026-11-11.

const LOADTEST_ROLE_SUFFIX = '-loadtest';
const TABLES = [
  'requests', 'dependencies', 'exceptions', 'traces', 'pageViews', 'browserTimings',
  'customEvents', 'customMetrics', 'performanceCounters', 'availabilityResults',
];
const PRELUDE = TABLES.map(t => `let ${t} = ${t} | where cloud_RoleName !endswith '${LOADTEST_ROLE_SUFFIX}';`).join('\n');

/** `query` with every App Insights table filtered to exclude load-test roles. Pure. */
function withoutLoadTest(query) {
  return `${PRELUDE}\n${query}`;
}

module.exports = { withoutLoadTest, LOADTEST_ROLE_SUFFIX };
