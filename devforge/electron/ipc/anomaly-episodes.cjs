// Correlated anomaly episodes for the incident report — a port of
// src/components/azure/anomalyDetection.ts, the detector App Health Check's Anomaly
// Detection row, Incident Timeline and tray alerts use, so the investigation names the
// same episodes the card shows. The main process cannot load TypeScript; a parity test
// (anomaly-episodes.test.mjs) runs both on the same series so the two cannot drift.
//
// Method, per metric: OLS line fit, residuals, MAD-based robust z-score, a signed
// flag past the metric's sensitivity, and a floor so a near-idle metric's noise is
// not a spike. CPU is the backbone; the others join on its timestamps. 5xx escalates
// severity; otherwise the count of pressure signals (CPU, Memory, DB CPU, DB Memory)
// decides it. Flagged buckets merge into episodes, tolerating one quiet bucket.

const CPU_SENSITIVITY = 2.0;
const MEMORY_SENSITIVITY = 4.0;
const DB_CPU_SENSITIVITY = 2.5;
const DB_MEMORY_SENSITIVITY = 5.0;
const ERROR_RATE_SENSITIVITY = 3.0;
const DEFAULT_MIN_SAMPLES = 10;
const CPU_SPIKE_FLOOR = { minPct: 50, minRise: 20 };
const DB_CPU_SPIKE_FLOOR = CPU_SPIKE_FLOOR;
const MEMORY_SPIKE_FLOOR = { minPct: 80, minRise: 10 };
// Error rates sit near 0%, so without a floor one 0.1% bucket scored as a spike.
const ERROR_RATE_SPIKE_FLOOR = { minPct: 5, minRise: 5 };
const ROBUST_STDEV_EPSILON = 1e-9;
const MAD_TO_STDEV = 1.4826;
const PRESSURE_METRIC_NAMES = new Set(['Memory', 'DB CPU', 'DB Memory']);
const SEVERITY_RANK = { Info: 0, Warning: 1, Critical: 2 };
const FIVE_MIN = 5 * 60 * 1000;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function linefit(values) {
  const n = values.length;
  if (n === 0) return { baseline: [], slope: 0, intercept: 0 };
  if (n === 1) return { baseline: [values[0]], slope: 0, intercept: values[0] };
  const meanI = (n - 1) / 2;
  const meanV = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const di = i - meanI;
    num += di * (values[i] - meanV);
    den += di * di;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = meanV - slope * meanI;
  return { baseline: values.map((_, i) => intercept + slope * i), slope, intercept };
}

function applySpikeFloor(values, det, floor) {
  if (!floor || !values.length) return det;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { ...det, flags: det.flags.map((f, i) => (f > 0 && values[i] < floor.minPct && values[i] - mean < floor.minRise ? 0 : f)) };
}

function robustAnomalyFlags(values, sensitivity, minSamples = DEFAULT_MIN_SAMPLES) {
  const n = values.length;
  if (n < minSamples) return { flags: new Array(n).fill(0), scores: new Array(n).fill(0), baseline: [...values] };
  const { baseline } = linefit(values);
  const residuals = values.map((v, i) => v - baseline[i]);
  const med = median(residuals);
  const robustStdev = MAD_TO_STDEV * median(residuals.map(r => Math.abs(r - med)));
  if (robustStdev < ROBUST_STDEV_EPSILON) return { flags: new Array(n).fill(0), scores: new Array(n).fill(0), baseline };
  const scores = residuals.map(r => (r - med) / robustStdev);
  return { flags: scores.map(s => (s > sensitivity ? 1 : s < -sensitivity ? -1 : 0)), scores, baseline };
}

/** ARM writes `…T11:00:00Z`, App Insights `…T11:00:00.0000000Z`: one key for both, or nothing joins. */
const keyOf = (t) => {
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(t);
};

function byTimeDetection(series, det) {
  const m = new Map();
  series.forEach((p, i) => m.set(keyOf(p.t), { pct: p.v, flag: det.flags[i] ?? 0, score: det.scores[i] ?? 0 }));
  return m;
}

function incidentType({ cpuFlag, dbCpuFlag, feFourXxFlag, feFiveXxFlag, apiFourXxFlag, apiFiveXxFlag }) {
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

/** @param cpu {{ series: Array<{ t: string, v: number }> }} @param extras Array<{ name, series, sensitivity, floor? }> */
function detectCorrelatedAnomalies(cpu, extras) {
  const available = extras.filter(x => (x.series?.length ?? 0) > 0);
  const totalMetrics = 1 + available.length;
  const cpuValues = cpu.series.map(p => p.v);
  const cpuDet = applySpikeFloor(cpuValues, robustAnomalyFlags(cpuValues, CPU_SENSITIVITY), CPU_SPIKE_FLOOR);
  const cpuByTime = byTimeDetection(cpu.series, cpuDet);
  const extraByTime = available.map(x => {
    const values = x.series.map(p => p.v);
    return { name: x.name, map: byTimeDetection(x.series, applySpikeFloor(values, robustAnomalyFlags(values, x.sensitivity), x.floor)) };
  });

  const rows = [];
  for (const p of cpu.series) {
    const key = keyOf(p.t);
    const cpuSample = cpuByTime.get(key);
    const metrics = { CPU: cpuSample };
    let signalsFiring = cpuSample.flag > 0 ? 1 : 0;
    let scoreSum = cpuSample.score;
    for (const { name, map } of extraByTime) {
      const sample = map.get(key);
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
    const severity = (feFiveXxFlag > 0 && apiFiveXxFlag > 0) ? 'Critical'
      : (anyFiveXx && (cpuFlag > 0 || dbCpuFlag > 0)) ? 'Critical'
      : anyFiveXx ? 'Warning'
      : signalsFiring >= 4 ? 'Critical'
      : signalsFiring >= 2 ? 'Warning'
      : signalsFiring === 1 && cpuFlag > 0 ? 'Info'
      : null;
    if (!severity) continue;
    rows.push({
      t: p.t, severity, signalsFiring, compositeScore: scoreSum / totalMetrics, metrics,
      incidentType: incidentType({ cpuFlag, dbCpuFlag, feFourXxFlag, feFiveXxFlag, apiFourXxFlag, apiFiveXxFlag }),
    });
  }
  return rows;
}

function inferSeriesStepMs(series) {
  if (series.length < 2) return FIVE_MIN;
  return new Date(series[1].t).getTime() - new Date(series[0].t).getTime();
}

function groupAnomalyEpisodes(rows, stepMs = FIVE_MIN) {
  const episodes = [];
  for (const r of rows) {
    const tMs = new Date(r.t).getTime();
    const firing = Object.entries(r.metrics).filter(([, s]) => s.flag > 0).map(([name, s]) => ({ name, pct: s.pct }));
    const last = episodes[episodes.length - 1];
    if (last && tMs - last.endMs <= stepMs * 2) {
      last.endT = r.t;
      last.endMs = tMs;
      last.bucketCount++;
      for (const { name, pct } of firing) {
        last.metricsInvolved.add(name);
        last.peakValues[name] = Math.max(last.peakValues[name] ?? -Infinity, pct);
      }
      if (SEVERITY_RANK[r.severity] >= SEVERITY_RANK[last.peakSeverity]) {
        last.peakSeverity = r.severity;
        last.incidentType = r.incidentType || last.incidentType;
      }
      last.peakCompositeScore = Math.max(last.peakCompositeScore, r.compositeScore);
    } else {
      const peakValues = {};
      for (const { name, pct } of firing) peakValues[name] = pct;
      episodes.push({
        startT: r.t, endT: r.t, endMs: tMs, peakSeverity: r.severity, peakCompositeScore: r.compositeScore,
        metricsInvolved: new Set(firing.map(f => f.name)), bucketCount: 1, peakValues, incidentType: r.incidentType,
      });
    }
  }
  return episodes.map(e => ({
    startT: e.startT, endT: e.endT, peakSeverity: e.peakSeverity, peakCompositeScore: e.peakCompositeScore,
    metricsInvolved: [...e.metricsInvolved], bucketCount: e.bucketCount, peakValues: e.peakValues, incidentType: e.incidentType,
  }));
}

// ── From the incident report's own data ──────────────────────────────────────

/** ARM points ({ timeStamp, average }) as detector input; points with no value dropped. */
const armSeries = (points) => (points ?? [])
  .filter(p => Number.isFinite(p?.average))
  .map(p => ({ t: keyOf(p.timeStamp), v: p.average }));

/** 5-minute App Insights rows [t, total, 5xx, 4xx] as a percent rate; empty buckets dropped (no denominator). */
const rateSeries = (rows, col) => (rows ?? [])
  .filter(r => Number(r[1]) > 0 && Number.isFinite(Number(r[col])))
  .map(r => ({ t: keyOf(r[0]), v: (Number(r[col]) / Number(r[1])) * 100 }))
  .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));

/**
 * Warning and Critical episodes for an incident window, from the series the report
 * already collected: plan CPU (backbone), memory, DB, and FE/API 4xx/5xx rates from
 * App Insights. Info (CPU alone: a batch job) is left out, as on the card. Pure.
 */
function incidentEpisodes(data, apiData) {
  const cpu = armSeries(data?.cpuSeries);
  if (cpu.length < 2) return [];
  const extras = [
    { name: 'Memory', series: armSeries(data.memSeries), sensitivity: MEMORY_SENSITIVITY, floor: MEMORY_SPIKE_FLOOR },
    { name: 'DB CPU', series: armSeries(data.dbCpuSeries), sensitivity: DB_CPU_SENSITIVITY, floor: DB_CPU_SPIKE_FLOOR },
    { name: 'DB Memory', series: armSeries(data.dbMemSeries), sensitivity: DB_MEMORY_SENSITIVITY, floor: MEMORY_SPIKE_FLOOR },
    { name: 'FE 4xx', series: rateSeries(data.fiveXxRows, 3), sensitivity: ERROR_RATE_SENSITIVITY, floor: ERROR_RATE_SPIKE_FLOOR },
    { name: 'FE 5xx', series: rateSeries(data.fiveXxRows, 2), sensitivity: ERROR_RATE_SENSITIVITY, floor: ERROR_RATE_SPIKE_FLOOR },
    { name: 'API 4xx', series: rateSeries(apiData?.fiveXxRows, 3), sensitivity: ERROR_RATE_SENSITIVITY, floor: ERROR_RATE_SPIKE_FLOOR },
    { name: 'API 5xx', series: rateSeries(apiData?.fiveXxRows, 2), sensitivity: ERROR_RATE_SENSITIVITY, floor: ERROR_RATE_SPIKE_FLOOR },
  ];
  const rows = detectCorrelatedAnomalies({ series: cpu }, extras);
  return groupAnomalyEpisodes(rows, inferSeriesStepMs(cpu)).filter(e => e.peakSeverity !== 'Info');
}

// ── Episodes computed by the page ────────────────────────────────────────────

const MAX_EPISODES = 50;
const SEVERITIES = new Set(['Critical', 'Warning']);
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Episodes the page computed with App Health Check's own detector on the 1-minute data it
 * charts, re-checked before they reach a report: ISO bounds, a known severity, numbers for
 * peaks, text clipped. undefined when none were sent, so the caller keeps its own. Pure.
 */
function cleanEpisodes(list) {
  if (!Array.isArray(list)) return undefined;
  return list.slice(0, MAX_EPISODES).map(e => {
    if (!SEVERITIES.has(e?.peakSeverity) || !Number.isFinite(Date.parse(e?.startT)) || !Number.isFinite(Date.parse(e?.endT))) return null;
    const metricsInvolved = (Array.isArray(e.metricsInvolved) ? e.metricsInvolved : []).slice(0, 10).map(m => clip(m, 40)).filter(Boolean);
    const peakValues = Object.fromEntries(metricsInvolved.filter(m => Number.isFinite(e.peakValues?.[m])).map(m => [m, Number(e.peakValues[m])]));
    return {
      startT: new Date(Date.parse(e.startT)).toISOString(), endT: new Date(Date.parse(e.endT)).toISOString(),
      peakSeverity: e.peakSeverity, bucketCount: Math.max(1, Math.floor(Number(e.bucketCount) || 1)),
      metricsInvolved, peakValues, incidentType: clip(e.incidentType, 200),
    };
  }).filter(Boolean);
}

module.exports = {
  cleanEpisodes,
  CPU_SENSITIVITY, MEMORY_SENSITIVITY, DB_CPU_SENSITIVITY, DB_MEMORY_SENSITIVITY, ERROR_RATE_SENSITIVITY,
  CPU_SPIKE_FLOOR, MEMORY_SPIKE_FLOOR, ERROR_RATE_SPIKE_FLOOR,
  linefit, robustAnomalyFlags, applySpikeFloor, detectCorrelatedAnomalies, groupAnomalyEpisodes, inferSeriesStepMs,
  incidentEpisodes,
};
