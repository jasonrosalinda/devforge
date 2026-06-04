import type { AppMetrics } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';

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
}

export interface RemarkResult {
  text: string;
  severity: RemarkSeverity;
}

export type VisibleBlocks = Partial<Record<string, boolean>>;

const KIND_TO_BLOCK: Record<RemarkKind, string> = {
  'CPU spike': 'cpu',
  'memory pressure': 'memory',
  'slow response': 'response',
  '5xx errors': 'requests',
  '4xx surge': 'requests',
  'downtime': 'uptimerobot',
};

const CPU_SPIKE = 80;
const MEM_SPIKE_PCT = 85;
const RESP_SLOW_SEC = 5;
const HTTP_4XX_RATE = 0.05;
const HTTP_5XX_RATE = 0.05;
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

function severityFromLastBad(
  lastBadAt: string | null,
  rangeStart: string | undefined,
  rangeEnd: string | undefined,
): RemarkSeverity {
  if (!lastBadAt) return 'ok';
  if (!rangeStart || !rangeEnd) return 'warning';
  const startMs = new Date(rangeStart).getTime();
  const endMs = new Date(rangeEnd).getTime();
  const badMs = new Date(lastBadAt).getTime();
  const windowMs = endMs - startMs;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 'warning';
  const tailMs = endMs - badMs;
  return tailMs < windowMs * 0.1 ? 'critical' : 'warning';
}

function httpRateStats(
  errSeries: Array<{ t: string; count: number }> | null | undefined,
  requestsSeries: AppMetrics['requestsSeries'],
  thresholdRate: number,
): { lastBadAt: string | null; peakRate: number | null } {
  if (!Array.isArray(errSeries) || errSeries.length === 0) return { lastBadAt: null, peakRate: null };
  const reqMap = new Map<string, number>();
  for (const r of requestsSeries ?? []) reqMap.set(r.t, r.count);
  let peakRate = 0;
  let lastBadAt: string | null = null;
  let anyAligned = false;
  for (let i = 0; i < errSeries.length; i++) {
    const pt = errSeries[i];
    if (!pt) continue;
    const total = reqMap.get(pt.t) ?? 0;
    if (total <= 0) continue;
    anyAligned = true;
    const rate = pt.count / total;
    if (rate > peakRate) peakRate = rate;
    if (rate > thresholdRate) lastBadAt = pt.t;
  }
  return { lastBadAt, peakRate: anyAligned ? peakRate : null };
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
    const label = r.display ?? r.kind;
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
  const remarks: MetricRemark[] = [];

  const cpuLastBad = findLastBadIso(m.cpu?.series, (p) => p.m > CPU_SPIKE);
  const cpuEpisodes = countEpisodes(m.cpu?.series, (p) => p.m > CPU_SPIKE);
  remarks.push({
    kind: 'CPU spike',
    display: cpuEpisodes > 0 ? `CPU spike (${cpuEpisodes} ${cpuEpisodes === 1 ? 'spike' : 'spikes'})` : undefined,
    lastBadAt: cpuLastBad,
    severity: severityFromLastBad(cpuLastBad, rangeStart, rangeEnd),
  });

  const memLastBad = findLastBadIso(m.memory?.series, (p) =>
    memoryIsBad(p, m.memUnit ?? '%', m.plan?.memoryMB),
  );
  remarks.push({
    kind: 'memory pressure',
    lastBadAt: memLastBad,
    severity: severityFromLastBad(memLastBad, rangeStart, rangeEnd),
  });

  const respLastBad = findLastBadIso(m.responseTime?.series, (p) => p.avg > RESP_SLOW_SEC);
  const respEpisodes = countEpisodes(m.responseTime?.series, (p) => p.avg > RESP_SLOW_SEC);
  remarks.push({
    kind: 'slow response',
    display: respEpisodes > 0 ? `slow response (${respEpisodes} ${respEpisodes === 1 ? 'spike' : 'spikes'})` : undefined,
    lastBadAt: respLastBad,
    severity: severityFromLastBad(respLastBad, rangeStart, rangeEnd),
  });

  const fmtPct = (rate: number | null): string | null =>
    rate == null ? null : `${(rate * 100).toFixed(1)}%`;

  const fiveXxStats = httpRateStats(m.failedRequestsSeries, m.requestsSeries, HTTP_5XX_RATE);
  remarks.push({
    kind: '5xx errors',
    display: fmtPct(fiveXxStats.peakRate)
      ? `5xx errors (peak ${fmtPct(fiveXxStats.peakRate)})`
      : undefined,
    lastBadAt: fiveXxStats.lastBadAt,
    severity: severityFromLastBad(fiveXxStats.lastBadAt, rangeStart, rangeEnd),
  });

  const fourXxStats = httpRateStats(m.http4xxSeries, m.requestsSeries, HTTP_4XX_RATE);
  remarks.push({
    kind: '4xx surge',
    display: fmtPct(fourXxStats.peakRate)
      ? `4xx surge (peak ${fmtPct(fourXxStats.peakRate)})`
      : undefined,
    lastBadAt: fourXxStats.lastBadAt,
    severity: severityFromLastBad(fourXxStats.lastBadAt, rangeStart, rangeEnd),
  });

  if (urMonitors?.length) {
    const { lastBadAt: downLastBad, incidents: downIncidents, downtimeMins: downMins } = urDowntimeStats(urMonitors);
    remarks.push({
      kind: 'downtime',
      display: downIncidents > 0
        ? `downtime (${downIncidents} ${downIncidents === 1 ? 'incident' : 'incidents'}, ${downMins} min)`
        : undefined,
      lastBadAt: downLastBad,
      severity: severityFromLastBad(downLastBad, rangeStart, rangeEnd),
    });
  }

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

const SEVERITY_COLORS: Record<RemarkSeverity, string> = {
  ok: '#3fb950',
  warning: '#d29922',
  critical: 'hsl(var(--destructive))',
};

interface AppRemarksProps {
  metrics: AppMetrics;
  rangeStart?: string | undefined;
  rangeEnd?: string | undefined;
  visibleBlocks?: VisibleBlocks;
  urMonitors?: UptimeRobotMonitor[];
}

export function AppRemarks({ metrics, rangeStart, rangeEnd, visibleBlocks, urMonitors }: AppRemarksProps) {
  const { text, severity } = buildRemarks(metrics, rangeStart, rangeEnd, visibleBlocks, urMonitors);
  if (!text) return null;
  return (
    <div className="text-xs">
      <span className="text-muted-foreground font-bold">Remarks: </span>
      <span style={{ color: SEVERITY_COLORS[severity], fontWeight: 600 }}>{text}</span>
    </div>
  );
}
