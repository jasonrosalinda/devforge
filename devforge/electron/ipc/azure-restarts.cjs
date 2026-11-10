// App Service Diagnostics — application restart events.
//
// The portal's "Application Restart Analysis" detector answers a question nothing
// else on the card can: the process died, and why. A Kudu kill is someone with a
// browser, an App Crash is the application faulting, and Platform Healing is Azure
// restarting the worker because it decided the app was unhealthy — three very
// different findings that all look identical from the outside as a gap in traffic.
//
// Per site, not per plan: a frontend restarting while its API stays up is exactly
// the distinction worth seeing, so the FE and the API are queried separately.

const { fetchDetectorCharts } = require('./azure-detectors.cjs');

/** Ordered strongest-first — see findDetector. */
const RESTART_KEYWORDS = ['app restart', 'restart analysis', 'web app restart', 'webappstart', 'restart'];

/**
 * Which datasets count as the restart timeline.
 *
 * Not a pinned title list: the detector that actually answers on real sites is
 * `webappstart`, whose chart is titled differently from the `apprestartanalyses`
 * one, and pinning the title dropped the chart entirely. Matching loosely keeps
 * whatever timeline the detector publishes.
 */
const RESTART_CHART_MATCH = /restart|stop|event|timeline/i;

/**
 * Restart timeline plus the detector's written findings for one site.
 * Null when the site publishes no restart detector.
 */
async function fetchRestartCharts(token, siteResId, startIso, endIso, timeGrain) {
  return fetchDetectorCharts(token, siteResId, {
    keywords: RESTART_KEYWORDS,
    titleMatch: RESTART_CHART_MATCH,
    startIso,
    endIso,
    timeGrain,
    label: 'restarts',
  });
}

/**
 * Total restarts per cause, from the timeline series. Pure.
 *
 * The chart's series names are the causes ("Kudu Kill(w3wp)", "App Crash",
 * "Platform Healing Your App"), and each point is a count in that bucket, so the
 * sum per series is the count of that kind of restart in the window.
 */
function restartTotals(charts) {
  const chart = (charts ?? []).find(c => /restart/i.test(c.title)) ?? (charts ?? [])[0];
  if (!chart) return { total: 0, byCause: [] };
  const byCause = chart.series
    .map(s => ({ cause: s.name, count: s.series.reduce((sum, p) => sum + (p.count ?? 0), 0) }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count);
  return { total: byCause.reduce((sum, c) => sum + c.count, 0), byCause };
}

// ── Restarts as prose ────────────────────────────────────────────────────────
// On real sites the `webappstart` detector publishes no timeline chart: every fact is in
// one written paragraph ("We analyzed 3 Kudu Kill Events… Kudu Kill(w3wp) Around
// 11/10/2026 12:21:51 (UTC), on Instance WN0SDWK000M2U…"). These mirror the fallback in
// src/components/azure/restartSection.tsx so the investigation counts what the page counts.

const CAUSE_NAMES = ['Platform Healing Your App', 'Kudu Kill(w3wp)', 'Kudu Kill', 'App Crash', 'Site Stopped', 'Config Change'];
const CAUSE_ALT = CAUSE_NAMES.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

function canonicalCause(raw) {
  const t = String(raw ?? '').trim();
  if (/kudu/i.test(t)) return 'Kudu Kill(w3wp)';
  if (/crash/i.test(t)) return 'App Crash';
  if (/healing/i.test(t)) return 'Platform Healing Your App';
  return t;
}

/** "11/10/2026 12:21:51" (UTC) → ISO, or '' when it does not parse. */
function usDateToIso(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return '';
  const ms = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}

/** The detector's findings as one string, minus the boilerplate advice block. */
function proseOf(restarts) {
  return (restarts?.insights ?? [])
    .flatMap(f => (f.items ?? []).filter(i => !/additional information/i.test(i.name)).map(i => i.text))
    .join(' ');
}

/** "We analyzed `6` Kudu Kill Events, `1` App Crash Event." → totals per cause. */
function parseRestartHeadline(text) {
  const out = [];
  // The detector wraps the figure in backticks, sometimes two of them (``3``).
  for (const m of String(text).matchAll(/`*(\d+)`*\s+([A-Za-z()\s]+?)\s+Events?\b/g)) {
    const count = Number(m[1]);
    const cause = canonicalCause(m[2]);
    if (count > 0 && cause) out.push({ cause, count });
  }
  return out;
}

/** Events named in the prose, newest first, undated ones last. */
function parseRestartProse(text) {
  const events = [];
  const dated = new RegExp('(' + CAUSE_ALT + ')\\s+Around\\s+(\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2})\\s*\\(UTC\\)[,\\s]*on Instance\\s+([A-Za-z0-9_-]+)', 'gi');
  for (const m of String(text).matchAll(dated)) {
    events.push({ t: usDateToIso(m[2]), cause: canonicalCause(m[1]), count: 1, instance: m[3] });
  }
  // "<Cause> On Instance X … occurred multiple times": Azure publishes no time for these.
  const undated = new RegExp('(' + CAUSE_ALT + ')\\s+On Instance\\s+([A-Za-z0-9_-]+)', 'gi');
  for (const m of String(text).matchAll(undated)) {
    const cause = canonicalCause(m[1]);
    if (events.some(e => e.cause === cause && e.instance === m[2])) continue;
    events.push({ t: '', cause, count: 1, instance: m[2], undated: true });
  }
  return events.sort((a, b) => (a.t && b.t ? (a.t < b.t ? 1 : -1) : a.t ? -1 : 1));
}

/** Individual restarts: the chart's non-empty buckets when there is one, else the prose. Newest first. */
function restartEvents(restarts) {
  const chart = (restarts?.charts ?? []).find(c => /restart/i.test(c.title)) ?? (restarts?.charts ?? [])[0];
  const events = (chart?.series ?? []).flatMap(s => s.series.filter(p => p.count > 0).map(p => ({ t: p.t, cause: s.name, count: p.count })));
  if (!events.length) return parseRestartProse(proseOf(restarts));
  return events.sort((a, b) => (a.t < b.t ? 1 : -1));
}

/** Total restarts per cause: the chart, else the prose headline, else the prose events. The same order the page uses. */
function restartSummary(restarts) {
  const fromChart = restartTotals(restarts?.charts);
  if (fromChart.total) return fromChart;
  const prose = proseOf(restarts);
  let byCause = parseRestartHeadline(prose).sort((a, b) => b.count - a.count);
  if (!byCause.length) {
    const counted = new Map();
    for (const e of parseRestartProse(prose)) counted.set(e.cause, (counted.get(e.cause) ?? 0) + e.count);
    byCause = [...counted.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count);
  }
  return { total: byCause.reduce((s, c) => s + c.count, 0), byCause };
}

module.exports = {
  restartEvents,
  restartSummary,
  parseRestartProse,
  parseRestartHeadline,
  RESTART_KEYWORDS,
  RESTART_CHART_MATCH,
  restartTotals,
  fetchRestartCharts,
};
