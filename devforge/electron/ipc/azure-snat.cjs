// App Service Diagnostics — SNAT port detector.
//
// The card's other SNAT evidence is indirect: socket exception text from App
// Insights and the plan-level TCP counters in azure-signals.cjs. The actual port
// allocations are only published through App Service Diagnostics, which is where
// these four charts come from.
//
// The REST plumbing, detector discovery, title matching and grain measurement all
// live in azure-detectors.cjs — the restart detector is the same shape. What is
// specific to SNAT is only the keywords and the chart titles below.

const {
  findDetector,
  parseDetectorCharts,
  detectGrainMs,
  normalizeTitle,
  fetchDetectorCharts,
} = require('./azure-detectors.cjs');

/** Ordered strongest-first: a detector named for SNAT beats one that merely
 *  mentions it in a description. */
const SNAT_KEYWORDS = ['snat port', 'snat'];

/** Titles as the portal renders them. Order here is the order the UI draws them. */
const SNAT_CHART_TITLES = [
  'SNAT port usage for TCP protocol',
  'Pending SNAT connections',
  'Failed SNAT connections',
  'New SNAT connections established',
];

/** Kept as a named export because the SNAT tests and callers predate the generic
 *  module; both delegate rather than reimplement. */
function findSnatDetector(list) {
  return findDetector(list, SNAT_KEYWORDS);
}

function parseSnatDetector(payload, detectorName) {
  return parseDetectorCharts(payload, detectorName, { titles: SNAT_CHART_TITLES });
}

async function fetchSnatCharts(token, siteResId, startIso, endIso, timeGrain) {
  return fetchDetectorCharts(token, siteResId, {
    keywords: SNAT_KEYWORDS,
    titles: SNAT_CHART_TITLES,
    startIso,
    endIso,
    timeGrain,
    label: 'snat',
  });
}

// ── Summary for text consumers (incident report) ────────────────────────────
// Mirrors snatSummary / groupByInstance in src/components/azure/snatPortSection.tsx.

const COUNTER_WORD = /alloc|used|tcp|udp|snat|conn/i;

/** "wn0abc (TCP_Used)" or "TCP_Used (wn0abc)" → { instance, counter }. Pure. */
function splitSeriesName(name) {
  const m = /^(.+?)\(([^)]*)\)\s*$/.exec(String(name ?? ''));
  if (!m) return { instance: String(name ?? ''), counter: '' };
  const left = m[1].trim();
  const right = m[2].trim();
  return COUNTER_WORD.test(left) && !COUNTER_WORD.test(right)
    ? { instance: right, counter: left }
    : { instance: left, counter: right };
}

const chartOf = (snat, prefix) => (snat?.charts ?? []).find(c => c.title.startsWith(prefix));
const peakOf = (series) => series.reduce((best, s) => s.series.reduce((b, p) => (p.count > b.count ? p : b), best), { t: null, count: 0 });

/**
 * What the SNAT detector charts say, as plain numbers. A missing chart is null (unknown),
 * an empty one is a real zero. Pure.
 *
 * @returns {{ instances: {instance, peakUsed, peakAllocated}[], failed: {total, peak, peakAt, firstAt} | null,
 *            pending: {total, peak, peakAt} | null, created: {total} | null } | null}
 */
function snatSummary(snat) {
  if (!snat?.charts?.length) return null;
  const usage = chartOf(snat, 'SNAT port usage');
  const byInstance = new Map();
  for (const s of usage?.series ?? []) {
    const { instance, counter } = splitSeriesName(s.name);
    const row = byInstance.get(instance) ?? { instance, peakUsed: 0, peakAllocated: 0 };
    const peak = peakOf([s]).count;
    if (/alloc/i.test(counter)) row.peakAllocated = Math.max(row.peakAllocated, peak);
    else if (/used/i.test(counter)) row.peakUsed = Math.max(row.peakUsed, peak);
    byInstance.set(instance, row);
  }
  const counted = (prefix) => {
    const chart = chartOf(snat, prefix);
    if (!chart) return null;
    const total = chart.series.reduce((n, s) => n + s.series.reduce((m, p) => m + p.count, 0), 0);
    const peak = peakOf(chart.series);
    const first = chart.series.flatMap(s => s.series).filter(p => p.count > 0).map(p => p.t).sort()[0] ?? null;
    return { total, peak: peak.count, peakAt: peak.count > 0 ? peak.t : null, firstAt: first };
  };
  return {
    instances: [...byInstance.values()].sort((a, b) => b.peakUsed - a.peakUsed),
    failed: counted('Failed'),
    pending: counted('Pending'),
    created: counted('New SNAT'),
  };
}

module.exports = {
  splitSeriesName,
  snatSummary,
  SNAT_KEYWORDS,
  SNAT_CHART_TITLES,
  normalizeTitle,
  findSnatDetector,
  parseSnatDetector,
  detectGrainMs,
  fetchSnatCharts,
};
