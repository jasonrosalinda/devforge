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

module.exports = {
  RESTART_KEYWORDS,
  RESTART_CHART_MATCH,
  restartTotals,
  fetchRestartCharts,
};
