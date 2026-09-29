// What the background monitor considers worth a tray alert, as pure functions over
// AppMetrics. Every rule is the one the App Health Check card already applies —
// status from cardStatus, anomalies from the same detector and episode grouping,
// 5xx and downtime from the same remarks — so an alert never disagrees with what
// the page shows for the same window. The monitor fetches no App Insights request
// series, so its anomalies draw on CPU, memory and DB only, not FE/API error rates.

import type { AppMetrics } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { cardStatus, type Status } from '@/components/azure/status';
import {
  detectCorrelatedAnomalies, groupAnomalyEpisodes, inferSeriesStepMs, buildExtras,
  type AnomalySeverity, type AnomalyEpisode,
} from '@/components/azure/anomalyDetection';
import { collectRemarks } from '@/components/azure/appRemarks';

export interface AppSnapshot {
  status: Status;
  /** The averages the status came from, e.g. "CPU avg 72.1%, p99 88% · Memory avg 36%, p99 43%". */
  statusDetail: string;
  /** Warning/Critical episodes keyed by start time. An episode that keeps growing
   *  keeps its start, so it is one alert, not one per minute. `text` names when it
   *  started and each spiking metric's peak; `hint` is the incident-type guess. */
  episodes: Record<string, { severity: AnomalySeverity; text: string; hint?: string }>;
  /** Still active in the trailing window (remark severity 'critical'). */
  fiveXxActive: boolean;
  fiveXxDetail?: string;
  downActive: boolean;
  downDetail?: string;
}

const pct = (n: number) => `${Number(n.toFixed(1))}%`;

function describeStatus(m: AppMetrics): string {
  const cpu = `CPU avg ${pct(m.cpu.avg)}, p99 ${pct(m.cpu.p99 ?? 0)}`;
  const memory = m.memUnit === 'MB'
    ? `Memory avg ${Math.round(m.memory.avg)} MB`
    : `Memory avg ${pct(m.memory.avg)}, p99 ${pct(m.memory.p99 ?? 0)}`;
  return `${cpu} · ${memory}`;
}

function describeEpisode(e: AnomalyEpisode, memUnit: string | undefined): string {
  const at = new Date(e.startT).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const values = e.metricsInvolved.map(name => {
    const v = e.peakValues[name];
    if (v == null) return name;
    return name === 'Memory' && memUnit === 'MB' ? `${name} ${Math.round(v)} MB` : `${name} ${pct(v)}`;
  });
  return `at ${at} — ${values.join(', ')}`;
}

export function snapshotApp(m: AppMetrics, urMonitors: UptimeRobotMonitor[], rangeEnd: string): AppSnapshot {
  const rows = detectCorrelatedAnomalies(m.cpu, buildExtras(m));
  const episodes: AppSnapshot['episodes'] = {};
  for (const e of groupAnomalyEpisodes(rows, inferSeriesStepMs(m.cpu.series))) {
    if (e.peakSeverity === 'Info') continue;
    episodes[e.startT] = {
      severity: e.peakSeverity,
      text: describeEpisode(e, m.memUnit),
      ...(e.incidentType ? { hint: e.incidentType } : {}),
    };
  }
  const remarks = collectRemarks(m, rangeEnd, urMonitors);
  const active = (kind: string) => remarks.find(r => r.kind === kind && r.severity === 'critical');
  const fiveXx = active('5xx errors');
  const down = active('downtime');
  return {
    status: cardStatus(m),
    statusDetail: describeStatus(m),
    episodes,
    fiveXxActive: !!fiveXx,
    ...(fiveXx?.display ? { fiveXxDetail: fiveXx.display } : {}),
    downActive: !!down,
    ...(down?.display ? { downDetail: down.display } : {}),
  };
}

const STATUS_RANK: Record<Status, number> = { healthy: 0, warning: 1, critical: 2 };
const SEVERITY_RANK: Record<AnomalySeverity, number> = { Info: 0, Warning: 1, Critical: 2 };

/** One line per thing that is new since `prev`. No `prev` is the baseline — the
 *  first check after the monitor starts — and says nothing, so switching it on does
 *  not replay what is already on screen. */
export function diffApp(prev: AppSnapshot | undefined, next: AppSnapshot): string[] {
  if (!prev) return [];
  const lines: string[] = [];

  if (STATUS_RANK[next.status] > STATUS_RANK[prev.status]) {
    lines.push(`Status ${prev.status} → ${next.status} — ${next.statusDetail}`);
  }

  for (const [startT, ep] of Object.entries(next.episodes)) {
    const before = prev.episodes[startT];
    if (!before || SEVERITY_RANK[ep.severity] > SEVERITY_RANK[before.severity]) {
      lines.push(`Anomaly (${ep.severity}) ${ep.text}${ep.hint ? `\n${ep.hint}` : ''}`);
    }
  }

  if (next.fiveXxActive && !prev.fiveXxActive) lines.push(next.fiveXxDetail ?? '5xx errors active');
  if (next.downActive && !prev.downActive) lines.push(`UptimeRobot reports ${next.downDetail ?? 'downtime'}`);

  return lines;
}

export interface FetchHealth { failures: number; alerted: boolean }

/** Failed checks in a row before the monitor says it can't see an app — one blip
 *  (a slow call, a laptop waking up) is not worth an alert. */
export const FAILURES_BEFORE_ALERT = 3;
const MAX_ERROR_CHARS = 160;

function shortError(error: string): string {
  if (/az login/i.test(error)) return 'sign-in expired — run az login';
  const first = error.split('\n')[0]!.trim();
  return first.length > MAX_ERROR_CHARS ? `${first.slice(0, MAX_ERROR_CHARS - 1)}…` : first;
}

/** Tracks one app's consecutive failed checks (`error` null = a good check). Without
 *  this a monitor that lost its Azure sign-in went quiet exactly like a healthy one.
 *  The alert goes out once, on the FAILURES_BEFORE_ALERT-th failure; the first good
 *  check after it says monitoring resumed. */
export function trackFetch(prev: FetchHealth | undefined, error: string | null): { next: FetchHealth; line: string | null } {
  const p = prev ?? { failures: 0, alerted: false };
  if (error == null) {
    return { next: { failures: 0, alerted: false }, line: p.alerted ? 'Monitoring resumed' : null };
  }
  const failures = p.failures + 1;
  if (!p.alerted && failures >= FAILURES_BEFORE_ALERT) {
    return { next: { failures, alerted: true }, line: `Monitor can't reach Azure: ${shortError(error)}` };
  }
  return { next: { failures, alerted: p.alerted }, line: null };
}
