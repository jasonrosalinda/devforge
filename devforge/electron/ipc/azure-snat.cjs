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

module.exports = {
  SNAT_KEYWORDS,
  SNAT_CHART_TITLES,
  normalizeTitle,
  findSnatDetector,
  parseSnatDetector,
  detectGrainMs,
  fetchSnatCharts,
};
