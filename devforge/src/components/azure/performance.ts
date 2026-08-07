import type { EndpointPerformance, EndpointPerfRow, EndpointPerfSeries, EndpointDependency } from '@shared/types/azureMetrics.types';

/** Green while a response is a normal page load, amber once a user notices it, red
 *  once it reads as broken. Same thresholds as the Response breakdown, so a P95 is
 *  the same colour wherever the card shows it. */
export function msColor(ms: number): string {
  return ms >= 5000 ? '#f85149' : ms >= 1000 ? '#d29922' : '#3fb950';
}

/** One shade deeper than the #3fb950 green used for success text elsewhere. These are
 *  large filled areas rather than a few glyphs, and at full brightness the base segment
 *  competes with the 4xx and 5xx stacked on top of it — which are the ones worth seeing. */
export const PERF_OK_COLOR   = '#2ea043';
export const PERF_4XX_COLOR  = '#f97316';
export const PERF_5XX_COLOR  = '#f85149';
export const PERF_LINE_COLOR = '#58a6ff';

/** One bar's three stacked segments plus the two latency lines for that bucket. */
export interface PerfChartRow {
  t: string
  /** Requests that were neither 4xx nor 5xx. */
  ok: number
  c4: number
  c5: number
  /** Total requests in the bucket — the stack height, kept for the tooltip. */
  count: number
  avgMs: number
  p95: number
}

/**
 * One endpoint's timeline → recharts rows.
 *
 * The bar is stacked by outcome rather than drawn alongside a separate error series:
 * 4xx and 5xx are subsets of the request count, so stacking `ok / 4xx / 5xx` makes the
 * bar height the true request rate while its colour composition is the error rate.
 * Two independent marks would let the reader mistake 20 requests with 20 errors for
 * 40 requests.
 *
 * `ok` is clamped at zero: App Insights can report a bucket where the status-class
 * counts exceed the row count (a request logged with no usable result code counts as a
 * 5xx by the same predicate that leaves it out of neither class), and a negative
 * segment silently inverts the stack.
 */
export function perfChartRows(points: EndpointPerfSeries['points'] | undefined): PerfChartRow[] {
  return (points ?? []).map(p => ({
    t: p.t,
    ok: Math.max(0, p.count - p.c4 - p.c5),
    c4: p.c4,
    c5: p.c5,
    count: p.count,
    avgMs: p.avgMs,
    p95: p.p95,
  }));
}

/**
 * Totals across whatever the chart is currently drawing.
 *
 * Summed from the plotted rows rather than taken from the endpoint table: the default
 * chart covers every endpoint, including the ones the merged table leaves out, so the
 * table's figures would understate it. Summing the bars guarantees the caption and the
 * plot are describing the same traffic whichever one is on screen.
 *
 * The two latency figures are NOT summed. `peakP95` is the worst bucket's P95, because
 * percentiles cannot be averaged across buckets any more than across endpoints. `avgMs`
 * is weighted by each bucket's request count, so a near-empty bucket at 8s cannot drag
 * the figure up as hard as a busy one at 40ms.
 */
export function chartTotals(rows: PerfChartRow[]) {
  const count = rows.reduce((s, r) => s + r.count, 0);
  return {
    count,
    ok: rows.reduce((s, r) => s + r.ok, 0),
    c4: rows.reduce((s, r) => s + r.c4, 0),
    c5: rows.reduce((s, r) => s + r.c5, 0),
    peakP95: rows.reduce((m, r) => Math.max(m, r.p95), 0),
    avgMs: count > 0 ? rows.reduce((s, r) => s + r.avgMs * r.count, 0) / count : 0,
  };
}

/** Figures for the collapsed Performance row — what the section is worth opening for. */
export function perfTotals(endpoints: EndpointPerfRow[] | undefined) {
  const rows = endpoints ?? [];
  const requests = rows.reduce((s, r) => s + r.count, 0);
  return {
    endpoints: rows.length,
    /** Requests to THESE endpoints, not to the app. The set is a subset — the ten
     *  busiest plus the failing ones — so this is the only total the section's error
     *  percentages can honestly be taken against. */
    requests,
    fourXx: rows.reduce((s, r) => s + r.fourXx, 0),
    fiveXx: rows.reduce((s, r) => s + r.fiveXx, 0),
    /** The worst endpoint P95, not a set-wide one: percentiles cannot be averaged or
     *  summed across endpoints, so the only honest single figure is the worst one.
     *  A true set-wide P95 would need the raw durations, which never leave KQL. */
    worstP95: rows.reduce((m, r) => Math.max(m, r.p95), 0),
    /** Request-weighted, so a 3-request endpoint at 8s cannot drag the figure up as
     *  hard as a 40k-request endpoint at 40ms. Averages of averages are not averages. */
    avgMs: requests > 0
      ? rows.reduce((s, r) => s + r.avgMs * r.count, 0) / requests
      : 0,
    /** The single slowest request to any endpoint in the set. */
    slowest: rows.reduce((m, r) => Math.max(m, r.maxMs), 0),
    /** Endpoints returning at least one 5xx — the count that decides whether this
     *  section is worth opening at all. */
    failing: rows.filter(r => r.fiveXx > 0).length,
  };
}

/** True once there is anything to show. Rows without a timeline are still worth
 *  listing — the table is useful on its own, the chart is the drill-down. */
export function hasPerfData(perf: EndpointPerformance | null | undefined): boolean {
  return (perf?.endpoints?.length ?? 0) > 0;
}

/**
 * One dependency's timeline → the same chart rows the endpoint chart uses.
 *
 * A dependency has one failure class, not two, so `c4` is always zero and the chart is
 * told to drop that segment — a permanent "4xx 0" row would read as a measured zero
 * rather than as a class that does not apply to a downstream call.
 */
export function depChartRows(
  points: NonNullable<EndpointDependency['series']> | undefined,
): PerfChartRow[] {
  return (points ?? []).map(p => ({
    t: p.t,
    // Clamped for the same reason as the endpoint rows: a bucket whose failure count
    // exceeds its row count would otherwise invert the stack.
    ok: Math.max(0, p.count - p.failCount),
    c4: 0,
    c5: p.failCount,
    count: p.count,
    avgMs: p.avgMs,
    p95: p.p95,
  }));
}

/** Identity of one dependency. Type, target and name together — two targets commonly
 *  serve a call of the same name, and merging them hides a failing one behind a healthy. */
export function depKey(d: Pick<EndpointDependency, 'type' | 'target' | 'name'>): string {
  return `${d.type}|${d.target}|${d.name}`;
}

/** Totals across one endpoint's calls, for the block's one-line summary. */
export function depTotals(deps: EndpointDependency[]) {
  return {
    calls: deps.reduce((s, d) => s + d.count, 0),
    failed: deps.reduce((s, d) => s + d.failCount, 0),
    totalMs: deps.reduce((s, d) => s + d.totalMs, 0),
    /** Distinct downstream targets — one endpoint fanning out to six is worth seeing. */
    targets: new Set(deps.map(d => d.target).filter(Boolean)).size,
  };
}
