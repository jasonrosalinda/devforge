// What the background monitor considers worth a tray alert, as pure functions over
// AppMetrics. Every rule is the one the App Health Check card already applies —
// status from cardStatus, anomalies from the same detector and episode grouping,
// 5xx and downtime from the same remarks — so a balloon never disagrees with what
// the page shows for the same window.

import type { AppMetrics } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { cardStatus, type Status } from '@/components/azure/status';
import {
  detectCorrelatedAnomalies, groupAnomalyEpisodes, inferSeriesStepMs, buildExtras,
  type AnomalySeverity,
} from '@/components/azure/anomalyDetection';
import { collectRemarks } from '@/components/azure/appRemarks';

export interface AppSnapshot {
  status: Status;
  /** Warning/Critical episodes keyed by start time. An episode that keeps growing
   *  keeps its start, so it is one alert, not one per minute. */
  episodes: Record<string, { severity: AnomalySeverity; label: string }>;
  /** Still active in the trailing window (remark severity 'critical'). */
  fiveXxActive: boolean;
  downActive: boolean;
}

export function snapshotApp(m: AppMetrics, urMonitors: UptimeRobotMonitor[], rangeEnd: string): AppSnapshot {
  const rows = detectCorrelatedAnomalies(m.cpu, buildExtras(m));
  const episodes: AppSnapshot['episodes'] = {};
  for (const e of groupAnomalyEpisodes(rows, inferSeriesStepMs(m.cpu.series))) {
    if (e.peakSeverity === 'Info') continue;
    episodes[e.startT] = { severity: e.peakSeverity, label: e.incidentType || e.metricsInvolved.join(' + ') };
  }
  const remarks = collectRemarks(m, rangeEnd, urMonitors);
  const active = (kind: string) => remarks.some(r => r.kind === kind && r.severity === 'critical');
  return {
    status: cardStatus(m),
    episodes,
    fiveXxActive: active('5xx errors'),
    downActive: active('downtime'),
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
    lines.push(`Status ${prev.status} → ${next.status}`);
  }

  for (const [startT, ep] of Object.entries(next.episodes)) {
    const before = prev.episodes[startT];
    if (!before || SEVERITY_RANK[ep.severity] > SEVERITY_RANK[before.severity]) {
      lines.push(`Anomaly (${ep.severity}): ${ep.label}`);
    }
  }

  if (next.fiveXxActive && !prev.fiveXxActive) lines.push('5xx errors active');
  if (next.downActive && !prev.downActive) lines.push('Downtime reported by UptimeRobot');

  return lines;
}
