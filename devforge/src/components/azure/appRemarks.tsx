import type { AppMetrics } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor, UptimeRobotLog } from '@/hooks/useUptimeRobotMonitor';
import { botShareLabel } from './performance';

export type RemarkKind =
  | 'CPU spike'
  | 'memory pressure'
  | 'slow response'
  | '5xx errors'
  | '4xx surge'
  | 'downtime';

export type RemarkSeverity = 'ok' | 'warning' | 'critical';

export interface MetricRemark {
  kind: RemarkKind;
  display?: string | undefined;
  lastBadAt: string | null;
  severity: RemarkSeverity;
  /** 4xx/5xx only: the bucket with the highest rate, [start, start + interval). What the
   *  card asks App Insights about to name the codes and endpoints. */
  peakWindow?: { startIso: string; endIso: string } | undefined;
}

/** HH:mm in SGT — the same clock the remark story and the timeline use. */
const sgtHm = (iso: string) => new Date(new Date(iso).getTime() + 8 * 3600 * 1000).toISOString().slice(11, 16);

export interface RemarkResult {
  text: string;
  severity: RemarkSeverity;
}

export type VisibleBlocks = Partial<Record<string, boolean>>;

/**
 * Which visible-block toggle silences each remark.
 *
 * Latency and error remarks point at 'performance': the Response and Requests rows they
 * used to name are gone, and Performance is the row that now carries both per endpoint.
 * A stale key here would not error — VisibleBlocks is a Partial<Record<string, boolean>>,
 * so an unknown key reads as undefined and the remark would simply become unsilenceable.
 */
const KIND_TO_BLOCK: Record<RemarkKind, string> = {
  'CPU spike': 'cpu',
  'memory pressure': 'memory',
  'slow response': 'performance',
  '5xx errors': 'performance',
  '4xx surge': 'performance',
  'downtime': 'uptimerobot',
};

const CPU_SPIKE = 80;
const MEM_SPIKE_PCT = 85;
const RESP_SLOW_SEC = 5;
const HTTP_4XX_RATE = 0.05;
export const HTTP_5XX_RATE = 0.05;
const GROUP_WINDOW_MS = 15 * 60 * 1000;

function findLastBadIso<T extends { t: string }>(
  series: T[] | null | undefined,
  isBad: (point: T) => boolean,
): string | null {
  if (!Array.isArray(series) || series.length === 0) return null;
  for (let i = series.length - 1; i >= 0; i--) {
    const point = series[i];
    if (point && isBad(point)) return point.t;
  }
  return null;
}

function countEpisodes<T>(
  series: T[] | null | undefined,
  isBad: (point: T) => boolean,
): number {
  if (!Array.isArray(series) || series.length === 0) return 0;
  let count = 0;
  let inEpisode = false;
  for (const pt of series) {
    if (isBad(pt)) {
      if (!inEpisode) { count++; inEpisode = true; }
    } else {
      inEpisode = false;
    }
  }
  return count;
}

/** Bucket width from a series' own first two points — every metric is fetched at
 *  the same query granularity, so any series that has at least two points can
 *  tell us the interval the others share too. */
function inferStepMs(series: Array<{ t: string }> | null | undefined): number | null {
  if (!series || series.length < 2) return null;
  const step = new Date(series[1]!.t).getTime() - new Date(series[0]!.t).getTime();
  return Number.isFinite(step) && step > 0 ? step : null;
}

/**
 * Remarks describe "is this happening right now," not the whole selected
 * range's history — so every series is narrowed to the one bucket interval
 * trailing `rangeEnd` before anything looks for a bad reading in it. End time
 * 11:50 PM with a 15m interval means only 11:35 PM-11:50 PM is ever examined;
 * a spike at 11:04 PM simply isn't in the data `findLastBadIso`/`countEpisodes`
 * see, rather than being seen and then downgraded to "recovered." Falls back to
 * the untrimmed series when the interval or range end can't be determined,
 * rather than silently reporting on nothing.
 */
function sliceToTrailingWindow<T extends { t: string }>(
  series: T[] | null | undefined,
  rangeEnd: string | undefined,
  intervalMs: number | null,
): T[] {
  if (!Array.isArray(series) || series.length === 0) return [];
  if (!rangeEnd || !intervalMs) return series;
  const endMs = new Date(rangeEnd).getTime();
  const startMs = endMs - intervalMs;
  if (!Number.isFinite(endMs)) return series;
  return series.filter((p) => {
    const tMs = new Date(p.t).getTime();
    return tMs >= startMs && tMs <= endMs;
  });
}

/** Same trailing-window narrowing as `sliceToTrailingWindow`, for UptimeRobot's
 *  discrete incident logs rather than a bucketed series — a log counts as being
 *  in the window when the incident it describes had ENDED by then. */
function sliceLogsToTrailingWindow(
  logs: UptimeRobotLog[],
  rangeEnd: string | undefined,
  intervalMs: number | null,
): UptimeRobotLog[] {
  if (!logs.length) return logs;
  if (!rangeEnd || !intervalMs) return logs;
  const endMs = new Date(rangeEnd).getTime();
  const startMs = endMs - intervalMs;
  if (!Number.isFinite(endMs)) return logs;
  return logs.filter((l) => {
    const incidentEndMs = (l.datetime + l.duration) * 1000;
    return incidentEndMs >= startMs && incidentEndMs <= endMs;
  });
}

/**
 * Active vs clean. Once a series has already been narrowed to the trailing
 * interval by `sliceToTrailingWindow`, any `lastBadAt` found in it is by
 * construction inside that interval — so this only still returns 'warning' in
 * the degraded case where the interval or range end couldn't be determined and
 * the caller fell back to the untrimmed series, where a bad reading might be
 * old news rather than current.
 */
function severityFromLastBad(
  lastBadAt: string | null,
  rangeEnd: string | undefined,
  intervalMs: number | null,
): RemarkSeverity {
  if (!lastBadAt) return 'ok';
  if (!rangeEnd || !intervalMs) return 'warning';
  const endMs = new Date(rangeEnd).getTime();
  const badMs = new Date(lastBadAt).getTime();
  if (!Number.isFinite(endMs) || !Number.isFinite(badMs)) return 'warning';
  return endMs - badMs <= intervalMs ? 'critical' : 'warning';
}

/**
 * Rate of `errSeries` over `requestsSeries`, bucket-aligned to `requestsSeries`'s
 * own grain rather than requiring an exact timestamp match on `t`.
 *
 * `failedRequestsSeries` (5xx) is fetched at a fixed 1-minute KQL bin regardless
 * of the selected range's granularity (electron/ipc/azure-metrics.cjs), while
 * `requestsSeries`/`http4xxSeries` use the range's actual bucket width — so on
 * anything coarser than 1 minute an exact-`t` join drops almost every 5xx point,
 * and the rare coincidental match compares one minute of errors against a much
 * wider bucket's total requests. That is exactly what produced a "peak 15.6%"
 * remark for an app whose Performance rows showed under 1%. Every error point
 * is instead summed into whichever requests bucket its timestamp falls within,
 * which is a no-op (and thus still correct) when the two already share a grain.
 */
export function httpRateBuckets(
  errSeries: Array<{ t: string; count: number }> | null | undefined,
  requestsSeries: AppMetrics['requestsSeries'],
): Array<{ t: string; rate: number }> {
  if (!Array.isArray(errSeries) || errSeries.length === 0) return [];
  const buckets = (requestsSeries ?? [])
    .map((r) => ({ t: r.t, tMs: new Date(r.t).getTime(), total: r.count }))
    .sort((a, b) => a.tMs - b.tMs);
  if (!buckets.length) return [];

  const errByBucket = new Map<string, number>();
  for (const pt of errSeries) {
    const tMs = new Date(pt.t).getTime();
    if (tMs < buckets[0]!.tMs) continue; // before the earliest known bucket — no home for it
    let bucket = buckets[0]!;
    for (const b of buckets) {
      if (b.tMs > tMs) break;
      bucket = b;
    }
    errByBucket.set(bucket.t, (errByBucket.get(bucket.t) ?? 0) + pt.count);
  }

  const rates: Array<{ t: string; rate: number }> = [];
  for (const b of buckets) {
    const errCount = errByBucket.get(b.t);
    if (errCount == null || b.total <= 0) continue;
    rates.push({ t: b.t, rate: errCount / b.total });
  }
  return rates;
}

function httpRateStats(
  errSeries: Array<{ t: string; count: number }> | null | undefined,
  requestsSeries: AppMetrics['requestsSeries'],
  thresholdRate: number,
): { lastBadAt: string | null; peakRate: number | null; peakAt: string | null } {
  const rates = httpRateBuckets(errSeries, requestsSeries);
  let peakRate = 0;
  let peakAt: string | null = null;
  let lastBadAt: string | null = null;
  for (const { t, rate } of rates) {
    if (rate > peakRate) { peakRate = rate; peakAt = t; }
    if (rate > thresholdRate) lastBadAt = t;
  }
  return { lastBadAt, peakRate: rates.length ? peakRate : null, peakAt };
}

/** "peak 5.3% at 14:30" plus the window App Insights is asked about. */
function httpPeak(
  stats: { peakRate: number | null; peakAt: string | null },
  intervalMs: number | null,
  rangeEnd: string | undefined,
): { label: string | null; peakWindow?: MetricRemark['peakWindow'] } {
  if (stats.peakRate == null) return { label: null };
  const pctText = `${(stats.peakRate * 100).toFixed(1)}%`;
  if (!stats.peakAt) return { label: `peak ${pctText}` };
  const endIso = intervalMs
    ? new Date(new Date(stats.peakAt).getTime() + intervalMs).toISOString()
    : rangeEnd ?? stats.peakAt;
  return { label: `peak ${pctText} at ${sgtHm(stats.peakAt)}`, peakWindow: { startIso: stats.peakAt, endIso } };
}

/** How many of the breakdown's (code, endpoint) groups a remark lists. */
export const BREAKDOWN_ITEMS = 5;

/**
 * The status-code breakdown as remark list items, busiest first, at most five:
 * "404 × 120 on GET /x (100% bot)". The bot share is by user agent. When the rows span
 * more than one cloud role (FE and API sharing an App Insights resource), each item names
 * its role. Empty rows mean App Insights saw none of these failures: an ARM-counted 4xx
 * that never reached the app (IIS static 404, IP block) has no request record, so that's
 * said plainly.
 */
export function formatStatusBreakdown(rows: Array<{ code: string; endpoint: string; role: string; count: number; bots: number }>): string[] {
  if (!rows.length) return ['no matching requests in App Insights for that bucket'];
  const multiRole = new Set(rows.map(r => r.role)).size > 1;
  const botShare = (bots: number, count: number) => (count > 0 ? ` (${botShareLabel(bots, count)} bot)` : '');
  return [...rows]
    .sort((a, b) => b.count - a.count)
    .slice(0, BREAKDOWN_ITEMS)
    .map(r =>
      `${r.code} × ${r.count.toLocaleString()}${r.endpoint ? ` on ${r.endpoint}` : ''}${multiRole && r.role ? ` [${r.role}]` : ''}${botShare(r.bots, r.count)}`);
}

function urDowntimeStats(urMonitors: UptimeRobotMonitor[] | undefined): {
  lastBadAt: string | null;
  incidents: number;
  downtimeMins: number;
} {
  if (!urMonitors?.length) return { lastBadAt: null, incidents: 0, downtimeMins: 0 };
  const downLogs = urMonitors.flatMap((m) => (m.logs ?? []).filter((l) => l.type === 1));
  const incidents = downLogs.length;
  const downtimeMins = Math.round(downLogs.reduce((s, l) => s + l.duration, 0) / 60);
  let lastBadMs = 0;
  for (const log of downLogs) {
    const endMs = (log.datetime + log.duration) * 1000;
    if (endMs > lastBadMs) lastBadMs = endMs;
  }
  return { lastBadAt: lastBadMs > 0 ? new Date(lastBadMs).toISOString() : null, incidents, downtimeMins };
}

function memoryIsBad(point: { v: number; m: number }, memUnit: string, planMemoryMB: number | undefined): boolean {
  if (memUnit === '%') return point.m > MEM_SPIKE_PCT;
  if (!planMemoryMB || planMemoryMB <= 0) return false;
  return point.m > planMemoryMB * (MEM_SPIKE_PCT / 100);
}

function joinKinds(kinds: string[]): string {
  if (kinds.length === 0) return '';
  if (kinds.length === 1) return kinds[0] ?? '';
  if (kinds.length === 2) return `${kinds[0]} and ${kinds[1]}`;
  return `${kinds.slice(0, -1).join(', ')}, and ${kinds[kinds.length - 1]}`;
}

function fmtSince(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

function groupRecovered(recs: MetricRemark[]): Array<{ kinds: string[]; iso: string }> {
  if (recs.length === 0) return [];
  const sorted = [...recs].sort(
    (a, b) => new Date(a.lastBadAt!).getTime() - new Date(b.lastBadAt!).getTime(),
  );
  const groups: Array<{ kinds: string[]; tMs: number }> = [];
  for (const r of sorted) {
    const tMs = new Date(r.lastBadAt!).getTime();
    // The plain kind, not `display`: display's parenthetical count ("CPU spike (7
    // spikes)") is written for the active-issue sentence, where more occurrences
    // means worse. Reused here it reads as "No CPU spike (7 spikes) since ..." —
    // asserting no spike while citing seven of them in the same breath.
    const label = r.kind;
    const last = groups[groups.length - 1];
    if (last && Math.abs(tMs - last.tMs) <= GROUP_WINDOW_MS) {
      last.kinds.push(label);
      last.tMs = Math.max(last.tMs, tMs);
    } else {
      groups.push({ kinds: [label], tMs });
    }
  }
  return groups.map((g) => ({ kinds: g.kinds, iso: new Date(g.tMs).toISOString() }));
}

function maxSeverity(a: RemarkSeverity, b: RemarkSeverity): RemarkSeverity {
  const order: Record<RemarkSeverity, number> = { ok: 0, warning: 1, critical: 2 };
  return order[a] >= order[b] ? a : b;
}

/** One remark per kind, each with its own severity — `critical` means still active in
 *  the trailing window. Split out of `buildRemarks` so the background monitor can read
 *  single kinds (5xx, downtime) rather than parse the sentence. */
export function collectRemarks(
  m: AppMetrics,
  rangeEnd?: string,
  urMonitors?: UptimeRobotMonitor[],
): MetricRemark[] {
  const remarks: MetricRemark[] = [];

  // One shared interval for everything below: all these series come from the
  // same query at the same granularity, so whichever one has enough points to
  // infer a grain speaks for the rest.
  const intervalMs = inferStepMs(m.cpu?.series) ?? inferStepMs(m.memory?.series) ?? inferStepMs(m.requestsSeries);

  const cpuWindow = sliceToTrailingWindow(m.cpu?.series, rangeEnd, intervalMs);
  const cpuLastBad = findLastBadIso(cpuWindow, (p) => p.m > CPU_SPIKE);
  const cpuEpisodes = countEpisodes(cpuWindow, (p) => p.m > CPU_SPIKE);
  remarks.push({
    kind: 'CPU spike',
    display: cpuEpisodes > 0 ? `CPU spike (${cpuEpisodes} ${cpuEpisodes === 1 ? 'spike' : 'spikes'})` : undefined,
    lastBadAt: cpuLastBad,
    severity: severityFromLastBad(cpuLastBad, rangeEnd, intervalMs),
  });

  const memWindow = sliceToTrailingWindow(m.memory?.series, rangeEnd, intervalMs);
  const memLastBad = findLastBadIso(memWindow, (p) =>
    memoryIsBad(p, m.memUnit ?? '%', m.plan?.memoryMB),
  );
  remarks.push({
    kind: 'memory pressure',
    lastBadAt: memLastBad,
    severity: severityFromLastBad(memLastBad, rangeEnd, intervalMs),
  });

  // Response now comes from per-site request telemetry rather than the frontend's
  // ARM metric, so the series is in milliseconds and carries a P95 alongside the
  // average. P95 is the signal: an average hides a tail that users still feel.
  const respWindow = sliceToTrailingWindow(m.requestInsights?.responseInsights?.series, rangeEnd, intervalMs);
  const respLastBad = findLastBadIso(respWindow, (p) => p.p95 > RESP_SLOW_SEC * 1000);
  const respEpisodes = countEpisodes(respWindow, (p) => p.p95 > RESP_SLOW_SEC * 1000);
  remarks.push({
    kind: 'slow response',
    display: respEpisodes > 0 ? `slow response (${respEpisodes} ${respEpisodes === 1 ? 'spike' : 'spikes'})` : undefined,
    lastBadAt: respLastBad,
    severity: severityFromLastBad(respLastBad, rangeEnd, intervalMs),
  });

  // Both sides of the rate — errors and the requests they're a share of — are
  // narrowed to the same trailing window, so the percentage stays a rate over
  // that window rather than errors-in-the-window over requests-all-day.
  const requestsWindow = sliceToTrailingWindow(m.requestsSeries, rangeEnd, intervalMs);

  const fiveXxWindow = sliceToTrailingWindow(m.failedRequestsSeries, rangeEnd, intervalMs);
  const fiveXxStats = httpRateStats(fiveXxWindow, requestsWindow, HTTP_5XX_RATE);
  const fiveXxPeak = httpPeak(fiveXxStats, intervalMs, rangeEnd);
  remarks.push({
    kind: '5xx errors',
    display: fiveXxPeak.label ? `5xx errors (${fiveXxPeak.label})` : undefined,
    lastBadAt: fiveXxStats.lastBadAt,
    severity: severityFromLastBad(fiveXxStats.lastBadAt, rangeEnd, intervalMs),
    peakWindow: fiveXxPeak.peakWindow,
  });

  const fourXxWindow = sliceToTrailingWindow(m.http4xxSeries, rangeEnd, intervalMs);
  const fourXxStats = httpRateStats(fourXxWindow, requestsWindow, HTTP_4XX_RATE);
  const fourXxPeak = httpPeak(fourXxStats, intervalMs, rangeEnd);
  remarks.push({
    kind: '4xx surge',
    display: fourXxPeak.label ? `4xx surge (${fourXxPeak.label})` : undefined,
    lastBadAt: fourXxStats.lastBadAt,
    severity: severityFromLastBad(fourXxStats.lastBadAt, rangeEnd, intervalMs),
    peakWindow: fourXxPeak.peakWindow,
  });

  if (urMonitors?.length) {
    const trailingMonitors = urMonitors.map((mon) => ({
      ...mon, logs: sliceLogsToTrailingWindow(mon.logs ?? [], rangeEnd, intervalMs),
    }));
    const { lastBadAt: downLastBad, incidents: downIncidents, downtimeMins: downMins } = urDowntimeStats(trailingMonitors);
    remarks.push({
      kind: 'downtime',
      display: downIncidents > 0
        ? `downtime (${downIncidents} ${downIncidents === 1 ? 'incident' : 'incidents'}, ${downMins} min)`
        : undefined,
      lastBadAt: downLastBad,
      severity: severityFromLastBad(downLastBad, rangeEnd, intervalMs),
    });
  }

  return remarks;
}

/** The remarks active in the trailing bucket ("right now"), minus the kinds whose block
 *  is hidden. The remark story's opening line, via `nowRemarkText`. */
export function activeRemarkList(remarks: MetricRemark[], visibleBlocks?: VisibleBlocks): MetricRemark[] {
  return remarks.filter(r => r.severity === 'critical' && visibleBlocks?.[KIND_TO_BLOCK[r.kind]] !== false);
}

const HTTP_CLASS: Partial<Record<RemarkKind, '4xx' | '5xx'>> = { '4xx surge': '4xx', '5xx errors': '5xx' };

/** What to ask App Insights about for an active 4xx/5xx remark, or null for any other kind. */
export function breakdownTarget(r: MetricRemark): { key: string; cls: '4xx' | '5xx'; startIso: string; endIso: string } | null {
  const cls = HTTP_CLASS[r.kind];
  if (!cls || !r.peakWindow) return null;
  const { startIso, endIso } = r.peakWindow;
  return { key: `${cls}|${startIso}|${endIso}`, cls, startIso, endIso };
}

/** One "Right now" entry. A 4xx/5xx remark names its site when the app has an API
 *  (these series are the frontend site's). */
export function nowRemarkText(r: MetricRemark, hasApi: boolean): string {
  const text = r.display ?? r.kind;
  return HTTP_CLASS[r.kind] ? `${hasApi ? 'FE ' : ''}${text}` : text;
}

/** A 4xx/5xx remark's codes and endpoints, listed under the "Right now" line once the
 *  breakdown is in; nothing for any other remark or before it arrives. */
export function nowRemarkItems(r: MetricRemark, breakdowns: Record<string, string[]>): string[] {
  const target = breakdownTarget(r);
  return target ? breakdowns[target.key] ?? [] : [];
}

export function buildRemarks(
  m: AppMetrics,
  rangeStart?: string,
  rangeEnd?: string,
  visibleBlocks?: VisibleBlocks,
  urMonitors?: UptimeRobotMonitor[],
): RemarkResult {
  const isKindVisible = (kind: RemarkKind): boolean => {
    if (!visibleBlocks) return true;
    const blockKey = KIND_TO_BLOCK[kind];
    return visibleBlocks[blockKey] !== false;
  };
  const remarks = collectRemarks(m, rangeEnd, urMonitors);

  const visibleRemarks = remarks.filter((r) => isKindVisible(r.kind));
  if (visibleRemarks.length === 0) return { text: '', severity: 'ok' };
  const clean = visibleRemarks.filter((r) => r.severity === 'ok');
  const recovered = visibleRemarks.filter((r) => r.severity === 'warning');
  const active = visibleRemarks.filter((r) => r.severity === 'critical');

  const groups = groupRecovered(recovered);
  let overallSeverity: RemarkSeverity = 'ok';
  for (const r of remarks) overallSeverity = maxSeverity(overallSeverity, r.severity);

  const sentences: string[] = [];

  if (active.length > 0) {
    sentences.push(`Active issues: ${joinKinds(active.map((r) => r.display ?? r.kind))}.`);
  }

  if (clean.length > 0) {
    sentences.push(
      `No ${joinKinds(clean.map((r) => r.kind))} detected in this window.`,
    );
  }

  for (const g of groups) {
    sentences.push(`No ${joinKinds(g.kinds)} since ${fmtSince(g.iso)}.`);
  }

  return { text: sentences.join(' '), severity: overallSeverity };
}
