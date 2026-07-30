'use strict';

// ─── Shared Azure signal helpers ─────────────────────────────────────────────
//
// Pure downtime-detection and socket-metric definitions, shared by the app
// health dashboard (azure-metrics.cjs) and the incident report
// (incident-report.cjs). Both features must agree on what "down" means and on
// what caused it — before this module the report had its own crude
// `availability < 99.5%` point count while the dashboard ran a 4-condition
// detector with hysteresis and cause classification, so the same window could
// be an outage on one screen and clean on the other.
//
// azure-metrics.cjs exports only its IPC handler, so nothing inside it is
// importable. Same reasoning as exception-buckets.cjs: the shared rules live in
// their own module rather than being forked.

// App Service outbound socket / TCP state counters. Direct SNAT evidence — high
// TimeWait against Established means connections are not being pooled. Published
// on the App Service PLAN (Microsoft.Web/serverfarms), not the site; querying a
// site returns HTTP 400 "Failed to find metric configuration". Windows plans
// only; Linux reports no data and the metric is dropped.
const SOCKET_METRIC_NAMES = [
  'SocketOutboundAll',
  'SocketOutboundEstablished',
  'SocketOutboundTimeWait',
  'TcpEstablished',
  'TcpTimeWait',
  'TcpCloseWait',
  'TcpSynSent',
];

/**
 * Simple availability-threshold intervals. Opens below 95%, closes on the first
 * good point. Used for the chart overlay, where a single dip is worth showing.
 */
function extractDowntimeIntervals(series) {
  const intervals = [];
  let start = null;
  for (const p of series) {
    const down = (p.average ?? 100) < 95;
    if (down && start === null) {
      start = new Date(p.timeStamp).getTime();
    } else if (!down && start !== null) {
      intervals.push({ start, end: new Date(p.timeStamp).getTime() });
      start = null;
    }
  }
  if (start !== null) {
    const last = series[series.length - 1];
    intervals.push({ start, end: new Date(last.timeStamp).getTime() });
  }
  return intervals;
}

/**
 * Classify confirmed downtime by instance impact.
 * one instance affected → instance_crash
 * all instances affected → full_outage
 * instances healthy      → dependency_failure
 */
function classifyDowntimeCause(interval, { instanceHealthSeries }) {
  const { start, end } = interval;
  const total = instanceHealthSeries?.length ?? 0;
  if (total === 0) return 'outage';
  let affected = 0;
  for (const inst of instanceHealthSeries) {
    const bad = inst.series.some(p => {
      const t = new Date(p.t).getTime();
      return t >= start && t <= end && p.v < 50;
    });
    if (bad) affected++;
  }
  if (affected === total) return 'full_outage';
  if (affected >= 1)      return 'instance_crash';
  return 'dependency_failure';
}

/**
 * Strict 4-condition downtime detection.
 * DOWN only when ALL are true for 2+ consecutive points:
 *   1. availability < 100%
 *   2. failed (5xx) requests > 0
 *   3. 5xx dominant over 4xx (not auth/client errors)
 *   4. at least one probe failure (if probe data available)
 * Closes after 3+ consecutive clean points.
 */
function extractDowntimeIntervalsMultiSignal(availSeries, failedSeries5xx, http4xxSeries, probeSeries) {
  if (!availSeries || !availSeries.length) return [];

  const OPEN_THRESHOLD  = 2;
  const CLOSE_THRESHOLD = 3;

  const granMs = availSeries.length > 1
    ? new Date(availSeries[1].t).getTime() - new Date(availSeries[0].t).getTime()
    : 15 * 60_000;

  const fail5xxMap = new Map((failedSeries5xx || []).map(p => [p.t, p.count]));
  const fail4xxMap = new Map((http4xxSeries   || []).map(p => [p.t, p.count]));

  function probeFailAt(tMs) {
    if (!probeSeries || !probeSeries.length) return false;
    return probeSeries.some(inst => {
      if (!inst.series.length) return false;
      const closest = inst.series.reduce((best, s) =>
        Math.abs(new Date(s.t).getTime() - tMs) < Math.abs(new Date(best.t).getTime() - tMs) ? s : best
      , inst.series[0]);
      return Math.abs(new Date(closest.t).getTime() - tMs) < granMs && closest.v < 50;
    });
  }

  const intervals = [];
  let consecBad   = 0;
  let consecGood  = 0;
  let incidentStart = null;

  for (const p of availSeries) {
    const tMs    = new Date(p.t).getTime();
    const fail5  = fail5xxMap.get(p.t) ?? 0;
    const fail4  = fail4xxMap.get(p.t) ?? 0;
    const cond1  = p.v < 100;
    const cond2  = fail5 > 0;
    const cond3  = fail5 > 0 && (fail4 === 0 || fail5 >= fail4);
    const cond4  = (probeSeries && probeSeries.length) ? probeFailAt(tMs) : true;
    const isDown = cond1 && cond2 && cond3 && cond4;

    if (isDown) {
      consecBad++;
      consecGood = 0;
      if (consecBad === OPEN_THRESHOLD && incidentStart === null) {
        incidentStart = tMs - (OPEN_THRESHOLD - 1) * granMs;
      }
    } else {
      consecGood++;
      consecBad = 0;
      if (consecGood >= CLOSE_THRESHOLD && incidentStart !== null) {
        intervals.push({ start: incidentStart, end: tMs - (CLOSE_THRESHOLD - 1) * granMs });
        incidentStart = null;
      }
    }
  }

  if (incidentStart !== null) {
    intervals.push({ start: incidentStart, end: new Date(availSeries[availSeries.length - 1].t).getTime() });
  }

  return intervals;
}

// Human-readable labels for the classifyDowntimeCause verdicts, so the report
// and the UI describe the same cause the same way.
const DOWNTIME_CAUSE_LABEL = {
  full_outage:        'Full outage — every instance unhealthy',
  instance_crash:     'Instance crash — some but not all instances unhealthy',
  dependency_failure: 'Dependency failure — instances healthy, requests still failing',
  outage:             'Outage — no per-instance data available to classify',
};

module.exports = {
  SOCKET_METRIC_NAMES,
  DOWNTIME_CAUSE_LABEL,
  extractDowntimeIntervals,
  classifyDowntimeCause,
  extractDowntimeIntervalsMultiSignal,
};
