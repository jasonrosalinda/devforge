import type { AppMetrics, CrashResult, IAzureMetricsAPI, ReleaseEvent, RestartResult } from '@shared/types/azureMetrics.types';
import type { TeamsTable } from '@/lib/teams-html';
import { restartEvents } from './restartSection';
import { releaseTitle } from './releaseMarkers';
import { formatSgt } from './rcaHtml';

export type Judgement = 'better' | 'worse' | 'same' | 'n/a';
export type OverallVerdict = 'regressed' | 'improved' | 'no-change';

export interface VerdictRow {
  key: string;
  label: string;
  before: number | null;
  after: number | null;
  /** Display strings — units differ per row. */
  beforeText: string;
  afterText: string;
  deltaPct: number | null;
  judgement: Judgement;
}

/** One side of the comparison: the summary fetch for the window plus its event counts. */
export interface VerdictWindow {
  metrics: AppMetrics;
  minutes: number;
  restarts: number;
  crashes: number;
}

/** Relative change below this is noise, whatever the absolute size. */
export const REL_THRESHOLD = 0.2;
/** A new exception type needs this many hits after the release to count against it. */
export const NEW_TYPE_MIN_COUNT = 5;

const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const fixed = (d: number) => (v: number) => v.toFixed(d);

interface MetricDef {
  key: string;
  label: string;
  /** Change smaller than this (in the metric's own unit) is "same". */
  floor: number;
  /** Requests per minute is context — more traffic is neither good nor bad. */
  judged: boolean;
  fmt: (v: number) => string;
  value: (w: VerdictWindow, site: 'fe' | 'api') => number | null;
}

const insightsOf = (m: AppMetrics, site: 'fe' | 'api') => (site === 'fe' ? m.requestInsights : m.apiRequestInsights);
const totalRequests = (w: VerdictWindow, site: 'fe' | 'api') => insightsOf(w.metrics, site)?.insight?.totalRequests ?? null;
const perRequest = (w: VerdictWindow, site: 'fe' | 'api', count: number | null | undefined) => {
  const total = totalRequests(w, site);
  return total && count != null ? count / total : null;
};
const perHour = (count: number, minutes: number) => (minutes > 0 ? (count / minutes) * 60 : null);

function memoryDef(m: AppMetrics): MetricDef {
  const isPct = (m.memUnit ?? '%') === '%';
  return {
    key: 'memAvg', label: 'Memory avg', judged: true,
    floor: isPct ? 5 : 100,
    fmt: v => (isPct ? `${v.toFixed(1)}%` : `${Math.round(v)} MB`),
    value: w => w.metrics.memory?.avg ?? null,
  };
}

const METRICS: MetricDef[] = [
  { key: 'cpuAvg', label: 'CPU avg', floor: 5, judged: true, fmt: v => `${v.toFixed(1)}%`, value: w => w.metrics.cpu?.avg ?? null },
  { key: 'cpuP99', label: 'CPU p99', floor: 10, judged: true, fmt: v => `${v.toFixed(1)}%`, value: w => w.metrics.cpu?.p99 ?? null },
  { key: 'rpm', label: 'Requests / min', floor: 0, judged: false, fmt: fixed(1), value: (w, s) => { const t = totalRequests(w, s); return t != null && w.minutes > 0 ? t / w.minutes : null; } },
  { key: 'p95', label: 'Response p95', floor: 200, judged: true, fmt: v => `${Math.round(v)} ms`, value: (w, s) => insightsOf(w.metrics, s)?.insight?.requestP95 ?? null },
  { key: 'rate5xx', label: '5xx rate', floor: 0.005, judged: true, fmt: pct, value: (w, s) => perRequest(w, s, insightsOf(w.metrics, s)?.total5xx) },
  { key: 'rate4xx', label: '4xx rate', floor: 0.01, judged: true, fmt: pct, value: (w, s) => perRequest(w, s, insightsOf(w.metrics, s)?.total4xx) },
  { key: 'excPer1k', label: 'Exceptions / 1k req', floor: 1, judged: true, fmt: fixed(1), value: (w, s) => { const r = perRequest(w, s, insightsOf(w.metrics, s)?.insight?.totalExceptions); return r == null ? null : r * 1000; } },
  { key: 'depFail', label: 'Dependency failures', floor: 0.005, judged: true, fmt: pct, value: (w, s) => { const i = insightsOf(w.metrics, s)?.insight; return i?.totalDependencies ? i.failedDependencies / i.totalDependencies : null; } },
  { key: 'restarts', label: 'Restarts / hour', floor: 1, judged: true, fmt: fixed(1), value: w => perHour(w.restarts, w.minutes) },
  { key: 'crashes', label: 'Crashes / hour', floor: 1, judged: true, fmt: fixed(1), value: w => perHour(w.crashes, w.minutes) },
];

/** Higher is worse for every judged metric. A change counts only when it clears both
 *  the absolute floor and REL_THRESHOLD, so 0.1% → 0.2% 5xx doesn't read as "doubled". */
export function judge(before: number | null, after: number | null, floor: number): Judgement {
  if (before == null || after == null) return 'n/a';
  const d = after - before;
  if (Math.abs(d) < floor) return 'same';
  if (before !== 0 && Math.abs(d) / Math.abs(before) < REL_THRESHOLD) return 'same';
  return d > 0 ? 'worse' : 'better';
}

export function compareWindows(before: VerdictWindow, after: VerdictWindow, site: 'fe' | 'api'): VerdictRow[] {
  const defs = [METRICS[0]!, METRICS[1]!, memoryDef(after.metrics), ...METRICS.slice(2)];
  return defs.map(def => {
    const b = def.value(before, site);
    const a = def.value(after, site);
    return {
      key: def.key,
      label: def.label,
      before: b,
      after: a,
      beforeText: b == null ? '—' : def.fmt(b),
      afterText: a == null ? '—' : def.fmt(a),
      deltaPct: b != null && a != null && b !== 0 ? (a - b) / Math.abs(b) : null,
      judgement: def.judged ? judge(b, a, def.floor) : 'n/a',
    };
  });
}

/** Exception types in the after window's top list that the before window's top list
 *  lacks. Both lists are top-10, so "new" means "new among the top types" — a type just
 *  outside the before top-10 can show up here. The UI says so. */
export function newExceptionTypes(
  before: Array<{ type: string; count: number }> | null | undefined,
  after: Array<{ type: string; count: number }> | null | undefined,
  minCount = NEW_TYPE_MIN_COUNT,
): Array<{ type: string; count: number }> {
  const seen = new Set((before ?? []).map(t => t.type));
  return (after ?? []).filter(t => !seen.has(t.type) && t.count >= minCount).sort((a, b) => b.count - a.count);
}

export function overallVerdict(rows: VerdictRow[], newTypes: Array<{ type: string }>): OverallVerdict {
  if (newTypes.length || rows.some(r => r.judgement === 'worse')) return 'regressed';
  if (rows.some(r => r.judgement === 'better')) return 'improved';
  return 'no-change';
}

/** Restart and crash counts on either side of the release. Pure; exported for tests. */
export function splitEventCounts(
  atMs: number,
  restarts: RestartResult | null | undefined,
  crashes: CrashResult | null | undefined,
): { before: { restarts: number; crashes: number }; after: { restarts: number; crashes: number } } {
  const out = { before: { restarts: 0, crashes: 0 }, after: { restarts: 0, crashes: 0 } };
  for (const ev of restartEvents(restarts)) {
    const t = Date.parse(ev.t);
    if (ev.undated || !Number.isFinite(t)) continue;
    out[t < atMs ? 'before' : 'after'].restarts += ev.count;
  }
  // The timeline counts every crash; `events` only those with a captured trace.
  const chart = crashes?.charts?.find(c => /crash/i.test(c.title)) ?? crashes?.charts?.[0];
  for (const s of chart?.series ?? []) {
    for (const p of s.series) {
      const t = Date.parse(p.t);
      if (!p.count || !Number.isFinite(t)) continue;
      out[t < atMs ? 'before' : 'after'].crashes += p.count;
    }
  }
  return out;
}

/** The before / after windows for a release: N hours each side, the after side cut at now. */
export function verdictWindows(atMs: number, hours: number, nowMs: number) {
  const span = hours * 3600 * 1000;
  return { beforeStart: atMs - span, beforeEnd: atMs, afterStart: atMs, afterEnd: Math.min(atMs + span, nowMs) };
}

/** Less than this much "after" data and the comparison is mostly noise. */
export const MIN_AFTER_MS = 15 * 60 * 1000;

export interface VerdictResult {
  rows: VerdictRow[];
  newTypes: Array<{ type: string; count: number }>;
  verdict: OverallVerdict;
}

export type VerdictOutcome =
  | { kind: 'too-soon'; minutesSince: number }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: VerdictResult };

/**
 * Fetch both windows and compare them: what the Release Verdict dialog shows, and what
 * the background monitor judges a new release by. `api` is window.electronAPI.azureMetrics.
 */
export async function computeReleaseVerdict(
  api: Pick<IAzureMetricsAPI, 'fetch' | 'fetchRestarts' | 'fetchCrashes'>,
  opts: { appKey: string; site: 'fe' | 'api'; event: ReleaseEvent; hours: number; config: unknown; nowMs?: number },
): Promise<VerdictOutcome> {
  const { appKey, site, event, hours, config } = opts;
  const atMs = Date.parse(event.at);
  const now = opts.nowMs ?? Date.now();
  const w = verdictWindows(atMs, hours, now);
  if (w.afterEnd - w.afterStart < MIN_AFTER_MS) {
    return { kind: 'too-soon', minutesSince: Math.max(0, Math.round((now - atMs) / 60000)) };
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const side = (start: number, end: number) =>
    // `silent`: these windows must not stream into any Health Check cards on screen.
    api.fetch({ appKeys: [appKey], range: 'custom', config, customStart: iso(start), customEnd: iso(end), silent: true });
  const events = { appKey, range: 'custom', config, customStart: iso(w.beforeStart), customEnd: iso(w.afterEnd) };

  const [b, a, restarts, crashes] = await Promise.all([
    side(w.beforeStart, w.beforeEnd), side(w.afterStart, w.afterEnd), api.fetchRestarts(events), api.fetchCrashes(events),
  ]);
  const before = b[appKey] as (AppMetrics & { error?: string }) | undefined;
  const after = a[appKey] as (AppMetrics & { error?: string }) | undefined;
  if (!before || !after || before.error || after.error) {
    return { kind: 'error', message: before?.error ?? after?.error ?? 'No metrics came back for this app.' };
  }
  const counts = splitEventCounts(atMs, site === 'fe' ? restarts.fe : restarts.api, site === 'fe' ? crashes.fe : crashes.api);
  const rows = compareWindows(
    { metrics: before, minutes: (w.beforeEnd - w.beforeStart) / 60000, ...counts.before },
    { metrics: after, minutes: (w.afterEnd - w.afterStart) / 60000, ...counts.after },
    site,
  );
  const newTypes = newExceptionTypes(insightsOf(before, site)?.errorTypes, insightsOf(after, site)?.errorTypes);
  return { kind: 'done', result: { rows, newTypes, verdict: overallVerdict(rows, newTypes) } };
}

const VERDICT_LABEL: Record<OverallVerdict, string> = { regressed: 'Regressed', improved: 'Improved', 'no-change': 'No change' };
const VERDICT_ACCENT: Record<OverallVerdict, string> = { regressed: '#cf222e', improved: '#1a7f37', 'no-change': '#57606a' };
const JUDGEMENT_TEXT: Record<Judgement, string> = { better: '▼ better', worse: '▲ worse', same: 'same', 'n/a': '' };

export function verdictLabel(v: OverallVerdict): string {
  return VERDICT_LABEL[v];
}

export function verdictTeamsTable(opts: {
  appName: string;
  site: 'fe' | 'api';
  hasApi: boolean;
  event: ReleaseEvent;
  hours: number;
  rows: VerdictRow[];
  newTypes: Array<{ type: string; count: number }>;
  verdict: OverallVerdict;
}): TeamsTable {
  const { appName, site, hasApi, event, hours, rows, newTypes, verdict } = opts;
  const siteName = hasApi ? ` ${site === 'fe' ? 'Frontend' : 'API'}` : '';
  const atMs = Date.parse(event.at);
  return {
    title: `Release verdict — ${appName}${siteName}: ${VERDICT_LABEL[verdict]}`,
    subtitle: `${releaseTitle(event).split('\n').join(' · ')} — ${hours}h before vs after (${formatSgt(atMs)})`,
    accent: VERDICT_ACCENT[verdict],
    headers: ['Metric', 'Before', 'After', 'Change'],
    rows: rows
      .filter(r => r.before != null || r.after != null)
      .map(r => [
        r.label,
        r.beforeText,
        r.afterText,
        [r.deltaPct == null ? '' : `${r.deltaPct > 0 ? '+' : ''}${Math.round(r.deltaPct * 100)}%`, JUDGEMENT_TEXT[r.judgement]].filter(Boolean).join(' '),
      ]),
    footer: newTypes.length
      ? [`New exception types after the release: ${newTypes.map(t => `${t.type} (${t.count})`).join(', ')}`]
      : [],
  };
}
