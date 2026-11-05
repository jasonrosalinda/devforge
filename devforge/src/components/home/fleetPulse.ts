import type { AppMetrics, ReleaseEvent, ReleaseFetchResult } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { snapshotApp, type AppSnapshot } from '@/monitor/healthAlerts';
import { HTTP_5XX_RATE, httpRateBuckets } from '@/components/azure/appRemarks';

/** How far back the pulse looks — the same window the tray monitor judges. */
export const PULSE_WINDOW_MS = 6 * 3600 * 1000;

export interface PulseRow {
  key: string;
  label: string;
  error?: string;
  snapshot?: AppSnapshot;
  cpu: number[];
  mem: number[];
  /** One entry per site that reports requests — FE always, API when it has its own
   *  App Service — so a spike can be pinned on the right one. */
  http5xx: Site5xx[];
  current: { cpu: number | null; mem: number | null };
  memUnit: string;
  /** Releases inside the window, as 0..1 positions along it. */
  releaseTicks: number[];
  lastRelease: { site: 'fe' | 'api'; event: ReleaseEvent } | null;
  /** From UptimeRobot's live monitor status; null when the app has no monitors. */
  uptime: 'up' | 'down' | null;
}

export interface Site5xx {
  site: 'fe' | 'api';
  /** 'FE 5xx' / 'API 5xx', or just '5xx' for an app without an API. */
  label: string;
  rates: number[];
  current: number | null;
  /** Highest rate in the window — shown beside `current` so a spiky line next to a
   *  "0%" now doesn't read as a contradiction. */
  peak: number | null;
}

export interface PulseInput {
  key: string;
  label: string;
  hasApi: boolean;
  metrics: (AppMetrics & { error?: string }) | undefined;
  releases?: ReleaseFetchResult | undefined;
  urMonitors?: UptimeRobotMonitor[] | undefined;
  nowMs: number;
}

const last = (xs: number[]) => (xs.length ? xs[xs.length - 1]! : null);

/** UptimeRobot status codes: 2 up, 8 seems down, 9 down; 0/1 paused or not checked yet. */
function uptimeOf(monitors: UptimeRobotMonitor[] | undefined): PulseRow['uptime'] {
  if (!monitors?.length) return null;
  if (monitors.some(m => m.status === 8 || m.status === 9)) return 'down';
  return monitors.some(m => m.status === 2) ? 'up' : null;
}

/** One app's vital signs. Pure; exported for tests. */
export function buildPulseRow(input: PulseInput): PulseRow {
  const { key, label, hasApi, metrics: m, releases, urMonitors, nowMs } = input;
  const startMs = nowMs - PULSE_WINDOW_MS;
  const sites = (hasApi ? ['fe', 'api'] : ['fe']) as Array<'fe' | 'api'>;
  const events = sites.flatMap(site => (releases?.[site]?.events ?? []).map(event => ({ site, event })));
  const lastRelease = sites
    .map(site => (releases?.[site]?.last ? { site, event: releases[site]!.last! } : null))
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => Date.parse(b.event.at) - Date.parse(a.event.at))[0] ?? null;
  const base = {
    key, label, lastRelease, uptime: uptimeOf(urMonitors),
    releaseTicks: events.map(r => (Date.parse(r.event.at) - startMs) / PULSE_WINDOW_MS).filter(x => x >= 0 && x <= 1),
  };

  if (!m || m.error || !m.cpu?.series?.length) {
    return {
      ...base, error: m?.error ?? 'Azure returned no CPU data',
      cpu: [], mem: [], http5xx: [], current: { cpu: null, mem: null }, memUnit: m?.memUnit ?? '%',
    };
  }
  const cpu = m.cpu.series.map(p => p.v);
  const mem = (m.memory?.series ?? []).map(p => p.v);
  // The minute still in progress comes back from Azure as 0 for both. Memory is never
  // truly 0%, so a joint 0 is the partial bucket — dropped, or "now" would read 0%.
  // More than one trailing minute can still be filling, so trim every joint zero at the end.
  while (cpu.length > 1 && mem.length > 1 && cpu[cpu.length - 1] === 0 && mem[mem.length - 1] === 0) {
    cpu.pop();
    mem.pop();
  }
  const withApi = hasApi && !!m.apiRequestsSeries?.length;
  const site = (s: 'fe' | 'api', failed: AppMetrics['failedRequestsSeries'], requests: AppMetrics['requestsSeries']): Site5xx => {
    const rates = httpRateBuckets(failed, requests).map(r => r.rate);
    return {
      site: s, label: withApi ? `${s === 'fe' ? 'FE' : 'API'} 5xx` : '5xx', rates, current: last(rates),
      peak: rates.length ? Math.max(...rates) : null,
    };
  };
  const http5xx = [
    site('fe', m.failedRequestsSeries, m.requestsSeries),
    ...(withApi ? [site('api', m.apiFailedRequestsSeries, m.apiRequestsSeries)] : []),
  ];
  return {
    ...base,
    snapshot: snapshotApp(m, urMonitors ?? [], new Date(nowMs).toISOString()),
    cpu, mem, http5xx,
    current: { cpu: last(cpu), mem: last(mem) },
    memUnit: m.memUnit ?? '%',
  };
}

export type Tone = 'ok' | 'warning' | 'critical';
export interface PulseIssue { tone: Exclude<Tone, 'ok'>; text: string }

/** What needs attention on one row, worst first. Pure; exported for tests. */
export function rowIssues(r: PulseRow): PulseIssue[] {
  if (r.error) return [{ tone: 'warning', text: `${r.label}: couldn't load (${r.error})` }];
  const s = r.snapshot!;
  const out: PulseIssue[] = [];
  if (r.uptime === 'down') out.push({ tone: 'critical', text: `${r.label} is down (UptimeRobot)` });
  else if (s.downActive) out.push({ tone: 'critical', text: `${r.label} ${s.downDetail ?? 'downtime'}` });
  // Judged from the same last bucket the card prints, per site, so the number and the
  // status line can't disagree (the tray's trailing-minute rule can, when App Insights lags).
  for (const x of r.http5xx) {
    if (x.current != null && x.current > HTTP_5XX_RATE) {
      out.push({ tone: 'critical', text: `${r.label} ${x.label} at ${formatRate(x.current)} now` });
    }
  }
  if (s.status !== 'healthy') out.push({ tone: s.status, text: `${r.label} ${s.status} — ${s.statusDetail}` });
  const episodes = Object.entries(s.episodes).sort(([a], [b]) => b.localeCompare(a));
  if (episodes.length) {
    const [, latest] = episodes[0]!;
    const more = episodes.length > 1 ? ` (+${episodes.length - 1} earlier)` : '';
    out.push({ tone: latest.severity === 'Critical' ? 'critical' : 'warning', text: `${r.label} anomaly ${latest.text}${more}` });
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'critical' ? -1 : 1));
}

/** A rate (0..1) as a percentage that never hides errors: exactly 0 is "0%", anything
 *  above 0 but under 0.1% is "<0.1%", the rest one decimal. Pure; exported for tests. */
export function formatRate(rate: number | null): string {
  if (rate == null) return '—';
  if (rate <= 0) return '0%';
  if (rate < 0.001) return '<0.1%';
  return `${(rate * 100).toFixed(1)}%`;
}

/** "just now" / "12m ago" / "5h ago" / "3d ago". Pure; exported for tests. */
export function relativeAgo(ms: number, nowMs: number): string {
  const mins = Math.floor((nowMs - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
