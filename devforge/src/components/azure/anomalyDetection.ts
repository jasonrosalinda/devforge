// Correlated multi-metric anomaly detection, reproduced client-side from a KQL
// query built around `series_decompose_anomalies(v, sensitivity, -1, 'linefit')`
// run separately over CPU, Memory, DB CPU and DB Memory, then joined on timestamp
// into a composite severity. The dashboard already has these same per-bucket
// series in memory for charting, so this runs against that instead of executing
// Kusto — the point isn't to page anyone, it's to say more in the Remarks line
// than "crossed 80%" can.
//
// `linefit` mode means the KQL skips seasonal decomposition entirely and just
// fits a straight trend line per metric; anomalies are points whose residual
// against that line is large relative to the *other* residuals. That reduces to
// four steps per metric, all straightforward to hand-roll: OLS line fit, robust
// (MAD-based) standard deviation of the residuals, a z-score, and a signed flag.
// Kusto's own robust-stdev constant isn't published — 1.4826*MAD is the standard,
// well-documented estimator (the constant that makes MAD consistent with stdev
// under a normal distribution) and is called out here as an approximation for
// generating text, not a bit-exact port.

import type { AppMetrics, MetricSeries, EndpointPerfPoint } from '@shared/types/azureMetrics.types';
import type { RemarkResult, RemarkSeverity } from './appRemarks';

// Tuned per metric rather than one shared value. Lower = more sensitive (same
// convention as the source KQL's own `sensitivity` param — it's a z-score
// threshold, so a smaller number is easier for a residual to clear). CPU is
// watched closely since it's the most common actionable signal; DB Memory
// needs a much larger deviation before it's worth flagging at all.
const CPU_SENSITIVITY = 2.0;
const MEMORY_SENSITIVITY = 4.0;
const DB_CPU_SENSITIVITY = 2.5;
const DB_MEMORY_SENSITIVITY = 5.0;
// 4xx/5xx rates are spikier by nature (one retry storm from one client can move
// them hard) — parked between CPU and Memory rather than separately tuned per
// the four request-error signals until there's a reason to split them further.
const ERROR_RATE_SENSITIVITY = 3.0;
const DEFAULT_MIN_SAMPLES = 10;
// A relative floor here would risk suppressing exactly the case that matters most:
// a metric that barely moves (memory flat at 34-39%) still deserves to fire on the
// rare bucket that's genuinely different. An absolute floor near machine epsilon
// only guards against literal divide-by-zero on a perfectly flat/linear series.
const ROBUST_STDEV_EPSILON = 1e-9;
const MAD_TO_STDEV = 1.4826;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Ordinary least squares of `values[i]` against its own index — the 'linefit'
 *  trend the KQL fits per metric before scoring residuals against it. */
export function linefit(values: number[]): { baseline: number[]; slope: number; intercept: number } {
  const n = values.length;
  if (n === 0) return { baseline: [], slope: 0, intercept: 0 };
  if (n === 1) return { baseline: [values[0]!], slope: 0, intercept: values[0]! };
  const meanI = (n - 1) / 2;
  const meanV = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const di = i - meanI;
    num += di * (values[i]! - meanV);
    den += di * di;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = meanV - slope * meanI;
  return { baseline: values.map((_, i) => intercept + slope * i), slope, intercept };
}

export interface AnomalyDetectorResult {
  flags: number[];
  scores: number[];
  baseline: number[];
}

/**
 * `linefit` baseline + MAD-based robust z-score + signed threshold flag, matching
 * `series_decompose_anomalies(values, sensitivity, -1, 'linefit')`.
 *
 * Below `minSamples` the fit is statistically meaningless (a single point can
 * BE the median), so detection is skipped rather than producing a noisy,
 * single-point-driven flag — same-length all-zero arrays, so callers never have
 * to branch on "did detection even run."
 */
export function robustAnomalyFlags(
  values: number[],
  sensitivity: number,
  minSamples = DEFAULT_MIN_SAMPLES,
): AnomalyDetectorResult {
  const n = values.length;
  if (n < minSamples) {
    return { flags: new Array(n).fill(0), scores: new Array(n).fill(0), baseline: [...values] };
  }
  const { baseline } = linefit(values);
  const residuals = values.map((v, i) => v - baseline[i]!);
  // Centred on the residuals' own median rather than 0: OLS residuals average to
  // zero by construction, but a small run dominated by one big spike can leave the
  // MEDIAN residual off zero, which is exactly the situation a robust estimator is
  // for. This is the standard modified z-score: (x - median) / (1.4826 * MAD).
  const med = median(residuals);
  const robustStdev = MAD_TO_STDEV * median(residuals.map(r => Math.abs(r - med)));
  if (robustStdev < ROBUST_STDEV_EPSILON) {
    return { flags: new Array(n).fill(0), scores: new Array(n).fill(0), baseline };
  }
  const scores = residuals.map(r => (r - med) / robustStdev);
  const flags = scores.map(s => (s > sensitivity ? 1 : s < -sensitivity ? -1 : 0));
  return { flags, scores, baseline };
}

export type AnomalySeverity = 'Critical' | 'Warning' | 'Info';

export interface MetricSample { pct: number; flag: number; score: number }

export interface CorrelatedAnomalyRow {
  t: string;
  severity: AnomalySeverity;
  /** How many pressure signals (CPU/Memory/DB CPU/DB Memory) fired at this
   *  bucket — 4xx/5xx are excluded, since they drive severity through their own
   *  rule instead of this count. See `detectCorrelatedAnomalies`'s doc comment. */
  signalsFiring: number;
  compositeScore: number;
  /** Keyed by display name ('CPU', 'Memory', 'FE 4xx', ...) — only metrics that
   *  actually had a reading at this timestamp are present. */
  metrics: Record<string, MetricSample>;
  /** Best-guess "what's actually happening" hint from which specific flags
   *  fired — see `incidentType`. '' when none of the ported branches match. */
  incidentType: string;
}

export interface NamedMetricInput {
  /** Display name — becomes the key in each row's `metrics` and the label used
   *  in episode/remark text ('CPU', 'DB CPU', 'FE 4xx', ...). */
  name: string;
  series: MetricSeries['series'] | null | undefined;
  sensitivity: number;
}

/** Same keyed-by-timestamp alignment CombinedChart uses (azureMetricChart.tsx) for
 *  dbCpu/dbMemory: none of these share CPU's resource, so a missing bucket must
 *  not shift every later point the way positional indexing would. */
function byTimeDetection(series: MetricSeries['series'], det: AnomalyDetectorResult): Map<string, MetricSample> {
  const m = new Map<string, MetricSample>();
  series.forEach((p, i) => m.set(p.t, { pct: p.v, flag: det.flags[i] ?? 0, score: det.scores[i] ?? 0 }));
  return m;
}

/** The resource-pressure signals `signalsFiring`/the pure-pressure severity
 *  fallback count — CPU (the backbone) plus these. FE/API 4xx/5xx are deliberately
 *  excluded: 5xx errors escalate severity through their own rule below instead of
 *  being tallied alongside pressure, and 4xx never drives severity at all — both
 *  only ever narrow down `incidentType`. */
const PRESSURE_METRIC_NAMES = new Set(['Memory', 'DB CPU', 'DB Memory']);

/**
 * Surface-aware incident hint — which specific combination of flags fired, in
 * roughly "how actionable is this" order. Ported from a KQL `case()` waterfall:
 * first matching branch wins, so a genuinely dual-surface outage (branch 1)
 * never gets mis-labelled by a later, narrower branch. Uses `flag > 0`
 * throughout rather than the source KQL's `!= 0` — same reasoning as
 * `signalsFiring` above: a metric easing off isn't the thing this is trying to
 * name. Returns '' (not shown) for a state none of the ported branches cover.
 */
function incidentType(f: {
  cpuFlag: number; dbCpuFlag: number;
  feFourXxFlag: number; feFiveXxFlag: number;
  apiFourXxFlag: number; apiFiveXxFlag: number;
}): string {
  const { cpuFlag, dbCpuFlag, feFourXxFlag, feFiveXxFlag, apiFourXxFlag, apiFiveXxFlag } = f;
  if (feFiveXxFlag > 0 && apiFiveXxFlag > 0) return 'Both surfaces erroring — check shared middleware, auth, or Redis';
  if (feFiveXxFlag > 0 && cpuFlag > 0) return 'Frontend errors under CPU pressure — check Blazor SSR/render pipeline';
  if (feFiveXxFlag > 0) return 'Frontend errors, flat resources — check CDN, static assets, or WASM load';
  if (apiFiveXxFlag > 0 && dbCpuFlag > 0) return 'API errors + DB CPU pressure — likely slow query causing request timeouts';
  if (apiFiveXxFlag > 0 && cpuFlag > 0) return 'API errors under app CPU pressure — check middleware or heavy serialization';
  if (apiFiveXxFlag > 0) return 'API errors, flat resources — check downstream dependency or external API';
  if (feFourXxFlag > 0 && apiFourXxFlag === 0) return 'Frontend 4xx surge — check routing, auth redirects, or missing static files';
  if (apiFourXxFlag > 0 && feFourXxFlag === 0) return 'API 4xx surge — check auth tokens, request validation, or bad client deploy';
  if (feFourXxFlag > 0 && apiFourXxFlag > 0) return '4xx surge on both surfaces — likely auth/token expiry or bad deployment';
  if (cpuFlag > 0 && dbCpuFlag > 0) return 'Correlated CPU pressure, no errors yet — monitor, check for slow queries';
  if (cpuFlag > 0) return 'CPU spike, no user impact — likely batch job or scheduled task';
  return '';
}

/**
 * CPU is the backbone — every row is one of CPU's own bucket timestamps. Every
 * other metric is decomposed independently, exactly like the KQL (which runs
 * `series_decompose_anomalies` once per metric before ever joining them), then
 * joined onto CPU's timeline by exact timestamp. Only upward flags (`flag > 0`)
 * count as "firing" anywhere in this function: a correlated *drop* (e.g. CPU and
 * memory both easing off outside business hours) is the opposite of an incident,
 * not evidence of one — a deliberate divergence from the source KQL's
 * `flag != 0`, which counts both directions.
 *
 * Severity: 5xx always escalates, ahead of the plain pressure-signal count —
 * both surfaces erroring is Critical outright; one surface erroring alongside
 * CPU/DB CPU pressure is also Critical; one surface erroring alone (no
 * corroborating pressure) is Warning; only once no 5xx fired at all does it
 * fall back to counting pressure signals (CPU/Memory/DB CPU/DB Memory — 4xx
 * never drives severity, only `incidentType`). That fallback count is an
 * ABSOLUTE threshold (all 4 pressure signals for Critical, 2+ for Warning, CPU
 * alone for Info), not a ratio of however many metrics happen to be configured:
 * an app with no DB tier naturally caps its pressure-only case at Warning (it
 * can never reach all 4 with only CPU+Memory to draw on) exactly as it did
 * before this had more signals to draw on.
 *
 * `compositeScore` divides by the number of metrics actually configured for
 * this call (1 + however many of `extras` have any data at all), coalescing a
 * metric that exists but had no reading at this specific bucket to 0 — the
 * same shape as the source KQL's literal `coalesce(...,0.0) / 4.0`, generalized
 * past a fixed four. It plays no part in severity — it's a display/ranking
 * number only.
 */
export function detectCorrelatedAnomalies(
  cpu: MetricSeries,
  extras: NamedMetricInput[],
): CorrelatedAnomalyRow[] {
  const available = extras.filter(x => (x.series?.length ?? 0) > 0);
  const totalMetrics = 1 + available.length;

  const cpuDet = robustAnomalyFlags(cpu.series.map(p => p.v), CPU_SENSITIVITY);
  const cpuByTime = byTimeDetection(cpu.series, cpuDet);

  const extraByTime = available.map(x => {
    const series = x.series!;
    const det = robustAnomalyFlags(series.map(p => p.v), x.sensitivity);
    return { name: x.name, map: byTimeDetection(series, det) };
  });

  const rows: CorrelatedAnomalyRow[] = [];
  cpu.series.forEach(p => {
    const cpuSample = cpuByTime.get(p.t)!;
    const metrics: Record<string, MetricSample> = { CPU: cpuSample };
    // Pressure-only count, used solely by the no-5xx fallback below — 4xx/5xx
    // are deliberately excluded here (see PRESSURE_METRIC_NAMES).
    let signalsFiring = cpuSample.flag > 0 ? 1 : 0;
    let scoreSum = cpuSample.score;

    for (const { name, map } of extraByTime) {
      const sample = map.get(p.t);
      if (sample) {
        metrics[name] = sample;
        if (sample.flag > 0 && PRESSURE_METRIC_NAMES.has(name)) signalsFiring++;
      }
      scoreSum += sample?.score ?? 0;
    }

    const cpuFlag = cpuSample.flag;
    const dbCpuFlag = metrics['DB CPU']?.flag ?? 0;
    const feFourXxFlag = metrics['FE 4xx']?.flag ?? 0;
    const feFiveXxFlag = metrics['FE 5xx']?.flag ?? 0;
    const apiFourXxFlag = metrics['API 4xx']?.flag ?? 0;
    const apiFiveXxFlag = metrics['API 5xx']?.flag ?? 0;
    const anyFiveXx = feFiveXxFlag > 0 || apiFiveXxFlag > 0;

    const compositeScore = scoreSum / totalMetrics;
    const severity: AnomalySeverity | null =
      (feFiveXxFlag > 0 && apiFiveXxFlag > 0) ? 'Critical'
      : (anyFiveXx && (cpuFlag > 0 || dbCpuFlag > 0)) ? 'Critical'
      : anyFiveXx ? 'Warning'
      : signalsFiring >= 4 ? 'Critical'
      : signalsFiring >= 2 ? 'Warning'
      : signalsFiring === 1 && cpuFlag > 0 ? 'Info'
      : null;
    if (!severity) return;

    rows.push({
      t: p.t, severity, signalsFiring, compositeScore, metrics,
      incidentType: incidentType({ cpuFlag, dbCpuFlag, feFourXxFlag, feFiveXxFlag, apiFourXxFlag, apiFiveXxFlag }),
    });
  });
  return rows;
}

export interface AnomalyEpisode {
  startT: string;
  endT: string;
  peakSeverity: AnomalySeverity;
  peakCompositeScore: number;
  metricsInvolved: string[];
  bucketCount: number;
  /** Highest value each involved metric actually reached during the episode —
   *  the number a "why" explanation needs alongside the metric's own window
   *  average, since the anomaly is relative to that metric's trend, not a
   *  fixed threshold, and "42%" alone doesn't say whether that's high for it. */
  peakValues: Record<string, number>;
  /** `incidentType` from whichever bucket set (or matched) the episode's peak
   *  severity, refreshed on ties so it reflects the most recent read rather
   *  than freezing on the episode's first bucket. */
  incidentType: string;
}

const SEVERITY_RANK: Record<AnomalySeverity, number> = { Info: 0, Warning: 1, Critical: 2 };

/** The metrics firing at this row, paired with the value each actually reached. */
function metricsFiring(r: CorrelatedAnomalyRow): Array<{ name: string; pct: number }> {
  return Object.entries(r.metrics)
    .filter(([, sample]) => sample.flag > 0)
    .map(([name, sample]) => ({ name, pct: sample.pct }));
}

/** Smallest gap between consecutive flagged rows. A fallback for when the caller
 *  doesn't have the original (unfiltered) series' real step handy — the minimum,
 *  not the median, because most episodes are isolated single buckets: a
 *  median-of-gaps over a mostly-isolated set skews toward "several steps apart,"
 *  which would then wrongly fuse genuinely separate episodes together. */
function inferStepMsFromRows(rows: CorrelatedAnomalyRow[]): number {
  if (rows.length < 2) return 5 * 60 * 1000;
  let min = Infinity;
  for (let i = 1; i < rows.length; i++) {
    const gap = new Date(rows[i]!.t).getTime() - new Date(rows[i - 1]!.t).getTime();
    if (gap > 0 && gap < min) min = gap;
  }
  return Number.isFinite(min) ? min : 5 * 60 * 1000;
}

/** The real bucket width from the unfiltered series, when the caller has it —
 *  preferred over `inferStepMsFromRows` since it isn't at the mercy of which
 *  buckets happened to survive filtering. */
export function inferSeriesStepMs(series: Array<{ t: string }>): number {
  if (series.length < 2) return 5 * 60 * 1000;
  return new Date(series[1]!.t).getTime() - new Date(series[0]!.t).getTime();
}

/**
 * Merges flagged buckets into contiguous episodes, tolerating one intervening
 * non-firing bucket (gap <= 2x step) so an obviously-continuous episode isn't
 * fragmented by a single quiet reading in the middle of it. Not the same
 * grouping problem `groupRecovered` in appRemarks.tsx solves — that groups
 * different remark KINDS co-occurring near one timestamp; this groups the SAME
 * phenomenon recurring across many timestamps — so it doesn't reuse that code.
 */
export function groupAnomalyEpisodes(rows: CorrelatedAnomalyRow[], stepMs?: number): AnomalyEpisode[] {
  if (!rows.length) return [];
  const step = stepMs ?? inferStepMsFromRows(rows);

  const episodes: Array<{
    startT: string; endT: string; endMs: number;
    peakSeverity: AnomalySeverity; peakCompositeScore: number;
    metricsInvolved: Set<string>; bucketCount: number; peakValues: Record<string, number>;
    incidentType: string;
  }> = [];

  for (const r of rows) {
    const tMs = new Date(r.t).getTime();
    const firing = metricsFiring(r);
    const last = episodes[episodes.length - 1];
    if (last && tMs - last.endMs <= step * 2) {
      last.endT = r.t;
      last.endMs = tMs;
      last.bucketCount++;
      firing.forEach(({ name, pct }) => {
        last.metricsInvolved.add(name);
        last.peakValues[name] = Math.max(last.peakValues[name] ?? -Infinity, pct);
      });
      // >=, not >: refreshes the hint on a tie so it reflects the most recent
      // read rather than freezing on whichever bucket started the episode.
      if (SEVERITY_RANK[r.severity] >= SEVERITY_RANK[last.peakSeverity]) {
        last.peakSeverity = r.severity;
        last.incidentType = r.incidentType || last.incidentType;
      }
      last.peakCompositeScore = Math.max(last.peakCompositeScore, r.compositeScore);
    } else {
      const peakValues: Record<string, number> = {};
      firing.forEach(({ name, pct }) => { peakValues[name] = pct; });
      episodes.push({
        startT: r.t, endT: r.t, endMs: tMs,
        peakSeverity: r.severity, peakCompositeScore: r.compositeScore,
        metricsInvolved: new Set(firing.map(f => f.name)), bucketCount: 1, peakValues,
        incidentType: r.incidentType,
      });
    }
  }

  return episodes.map(e => ({
    startT: e.startT, endT: e.endT,
    peakSeverity: e.peakSeverity, peakCompositeScore: e.peakCompositeScore,
    metricsInvolved: [...e.metricsInvolved], bucketCount: e.bucketCount, peakValues: e.peakValues,
    incidentType: e.incidentType,
  }));
}

function joinList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function fmtEpisodeTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

/**
 * Headline sentence for the richest Warning/Critical episode in `episodes`, or
 * null when there's nothing above Info to report. Info episodes (CPU-only —
 * "probably a batch job or GC, not an incident" per the severity table this was
 * built from) are expected to already be filtered out by the caller; passing
 * them in is harmless since they can never outrank Warning/Critical for
 * `severity`, but they'd never be picked as `latest` on their own either.
 *
 * Pulled out of `buildAnomalyRemark` so a caller that already has an episode
 * list — the Anomaly Detection row builds one for its own detail view anyway —
 * can reuse this exact sentence without re-running detection a second time.
 */
export function describeAnomalyEpisodes(episodes: AnomalyEpisode[]): RemarkResult | null {
  const reportable = episodes.filter(e => e.peakSeverity !== 'Info');
  if (!reportable.length) return null;

  const severity: RemarkSeverity = reportable.some(e => e.peakSeverity === 'Critical') ? 'critical' : 'warning';
  const latest = reportable[reportable.length - 1]!;
  const latestLabel = latest.peakSeverity === 'Critical' ? 'Critical' : 'Warning';

  const hint = latest.incidentType ? ` — ${latest.incidentType}.` : '.';
  const text = reportable.length === 1
    ? `Correlated pressure spike across ${joinList(latest.metricsInvolved)} at ${fmtEpisodeTime(latest.startT)} (${latestLabel})${hint}`
    : `${reportable.length} correlated pressure spikes detected${hint}`;

  return { text, severity };
}

/**
 * A per-bucket error rate (percent), from the same Application Insights request
 * telemetry the Performance rows already chart (`overallSeries`) — same shape
 * as a MetricSeries.series, so it plugs into `detectCorrelatedAnomalies` like
 * any other metric. Buckets with zero requests are dropped rather than reported
 * as a fabricated 0%: a rate has no meaning without a denominator.
 */
export function errorRateSeries(
  points: EndpointPerfPoint[] | null | undefined,
  key: 'c4' | 'c5',
): MetricSeries['series'] {
  return (points ?? [])
    .filter(p => p.count > 0)
    .map(p => {
      const v = (p[key] / p.count) * 100;
      return { t: p.t, v, m: v };
    });
}

/** Aggregate rate across the whole window — the "window average" a peak value
 *  from one bucket gets explained against, the same role `.avg` plays for
 *  CPU/memory. */
export function aggregateErrorRate(
  points: EndpointPerfPoint[] | null | undefined,
  key: 'c4' | 'c5',
): number | null {
  const list = points ?? [];
  const totalCount = list.reduce((s, p) => s + p.count, 0);
  if (totalCount <= 0) return null;
  const totalErr = list.reduce((s, p) => s + p[key], 0);
  return (totalErr / totalCount) * 100;
}

/** Builds the full configured metric set — CPU as the backbone, everything else
 *  (Memory, DB CPU/Memory when the app has a database, FE/API 4xx/5xx when
 *  their App Insights telemetry is available) as extras — and hands it to
 *  `detectCorrelatedAnomalies`. Missing tiers simply contribute an empty
 *  series, which `detectCorrelatedAnomalies` excludes from its own metric
 *  count rather than treating as a permanently-absent signal. */
export function buildExtras(m: AppMetrics): NamedMetricInput[] {
  const feOverall = m.requestInsights?.performance?.overallSeries;
  const apiOverall = m.apiRequestInsights?.performance?.overallSeries;
  return [
    { name: 'Memory', series: m.memory.series, sensitivity: MEMORY_SENSITIVITY },
    { name: 'DB CPU', series: m.dbCpu?.series, sensitivity: DB_CPU_SENSITIVITY },
    { name: 'DB Memory', series: m.dbMemory?.series, sensitivity: DB_MEMORY_SENSITIVITY },
    { name: 'FE 4xx', series: errorRateSeries(feOverall, 'c4'), sensitivity: ERROR_RATE_SENSITIVITY },
    { name: 'FE 5xx', series: errorRateSeries(feOverall, 'c5'), sensitivity: ERROR_RATE_SENSITIVITY },
    { name: 'API 4xx', series: errorRateSeries(apiOverall, 'c4'), sensitivity: ERROR_RATE_SENSITIVITY },
    { name: 'API 5xx', series: errorRateSeries(apiOverall, 'c5'), sensitivity: ERROR_RATE_SENSITIVITY },
  ];
}

/** `describeAnomalyEpisodes` over a freshly detected/grouped window — see that
 *  function for the sentence itself. */
export function buildAnomalyRemark(m: AppMetrics): RemarkResult | null {
  const rows = detectCorrelatedAnomalies(m.cpu, buildExtras(m));
  const episodes = groupAnomalyEpisodes(rows, inferSeriesStepMs(m.cpu.series));
  return describeAnomalyEpisodes(episodes);
}
