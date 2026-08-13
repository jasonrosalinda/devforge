// Correlated multi-metric anomaly detection, as its own row rather than folded
// into Remarks — the detector naturally produces a list of flagged time windows,
// which reads as a wall of text stuffed into one sentence but fits an expandable
// row (same shape as Restarts or SNAT Ports) just fine.

import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import {
  detectCorrelatedAnomalies, groupAnomalyEpisodes, inferSeriesStepMs, describeAnomalyEpisodes,
  buildExtras, aggregateErrorRate,
} from './anomalyDetection';
import type { AnomalyEpisode, AnomalySeverity } from './anomalyDetection';
import type { RemarkSeverity } from './appRemarks';
import { CellSkeleton } from './loadingSkeleton';

// 'ok' never actually comes back from describeAnomalyEpisodes (it only returns
// non-null when there's a Warning/Critical episode) — filled in anyway so the
// lookup type-checks against RemarkResult's full severity type without a cast.
const REMARK_COLOR: Record<RemarkSeverity, string> = {
  critical: 'hsl(var(--destructive))',
  warning: '#d29922',
  ok: '#3fb950',
};

const SEVERITY_COLOR: Record<AnomalySeverity, string> = {
  Critical: 'hsl(var(--destructive))',
  Warning: '#d29922',
  Info: '#8b9ab3',
};

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function fmtRange(e: AnomalyEpisode): string {
  return e.startT === e.endT ? fmtTime(e.startT) : `${fmtTime(e.startT)} – ${fmtTime(e.endT)}`;
}

/** The window-average rollup for a metric named the way `AnomalyEpisode.metricsInvolved`
 *  names it — the "expected" figure a peak value is explained against. Not the
 *  algorithm's own line-fit baseline (that varies bucket-to-bucket and isn't
 *  carried on the episode); the plain window average is far more legible for a
 *  reader than a robust-z-score would be, at the cost of being a coarser number. */
function windowAvg(metrics: AppMetrics, name: string): number | null {
  switch (name) {
    case 'CPU': return metrics.cpu.avg;
    case 'Memory': return metrics.memory.avg;
    case 'DB CPU': return metrics.dbCpu?.avg ?? null;
    case 'DB Memory': return metrics.dbMemory?.avg ?? null;
    case 'FE 4xx': return aggregateErrorRate(metrics.requestInsights?.performance?.overallSeries, 'c4');
    case 'FE 5xx': return aggregateErrorRate(metrics.requestInsights?.performance?.overallSeries, 'c5');
    case 'API 4xx': return aggregateErrorRate(metrics.apiRequestInsights?.performance?.overallSeries, 'c4');
    case 'API 5xx': return aggregateErrorRate(metrics.apiRequestInsights?.performance?.overallSeries, 'c5');
    default: return null;
  }
}

/** "CPU peaked at 92.0% (window avg 6.7%) and DB CPU peaked at 45.0% (avg 3.1%)" —
 *  why each firing metric was flagged: relative to its OWN average, not a fixed
 *  threshold, which is exactly why a metric that normally sits low (DB CPU at
 *  ~3%) can fire on a bucket that still looks unremarkable next to CPU's 90%. */
function explain(e: AnomalyEpisode, metrics: AppMetrics): string {
  return e.metricsInvolved
    .map(name => {
      const peak = e.peakValues[name];
      const avg = windowAvg(metrics, name);
      if (peak == null) return name;
      return avg != null
        ? `${name} peaked at ${peak.toFixed(1)}% (window avg ${avg.toFixed(1)}%)`
        : `${name} peaked at ${peak.toFixed(1)}%`;
    })
    .join(', ');
}

export function AnomalyDetectionRow({
  metrics, expanded, onToggle, detailsLoading = false, detailsLoaded = false,
}: {
  metrics: AppMetrics;
  expanded: boolean;
  onToggle: () => void;
  /** FE/API 4xx and 5xx rates arrive via the separate details fetch, not the base
   *  metrics call — see fetchAppDetails. Detection runs against every metric at
   *  once, so it waits for that to finish rather than firing on CPU/Memory alone
   *  and then silently changing its answer when the rest lands a moment later. */
  detailsLoading?: boolean;
  detailsLoaded?: boolean;
}) {
  const waitingForDetails = detailsLoading && !detailsLoaded;
  const rows = waitingForDetails ? [] : detectCorrelatedAnomalies(metrics.cpu, buildExtras(metrics));
  const episodes = waitingForDetails ? [] : groupAnomalyEpisodes(rows, inferSeriesStepMs(metrics.cpu.series));
  // Info (CPU-only) episodes are real detections but "probably a batch job, not
  // an incident" per the severity this was built from — counted for the aside
  // in the empty state, never shown as their own line.
  const reportable = episodes.filter(e => e.peakSeverity !== 'Info');
  const infoCount = episodes.length - reportable.length;
  const hasReportable = !waitingForDetails && reportable.length > 0;
  const remark = waitingForDetails ? null : describeAnomalyEpisodes(episodes);

  return (
    <>
      <tr
        style={{ cursor: hasReportable ? 'pointer' : 'default' }}
        onClick={() => hasReportable && onToggle()}
        onMouseEnter={e => hasReportable && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td className="text-muted-foreground font-bold">
          <span title="Anomaly Detection: CPU, Memory, DB CPU/Memory (if the app has a database) and FE/API 4xx and 5xx rates (if App Insights telemetry is available) are each fit against their own recent trend, independent of any fixed threshold — a metric that barely moves can still fire on the bucket where it genuinely doesn't. Buckets where several move together, unusually, at once are flagged: 3 or more correlated signals is Critical, 2 is Warning, CPU alone is Info (usually a batch job or GC, not shown here).">
            Anomaly Detection
          </span>
          {hasReportable && (expanded
            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />)}
        </td>
        <td className="text-right" colSpan={3} style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {waitingForDetails ? <CellSkeleton w={160} /> : (
            /* Bare count, not `remark.text`: the hint and time-of-latest that sentence
               carries (for the Remarks card, which has no table backing it) would just
               repeat what the table below already shows per-episode. */
            remark
              ? <span style={{ color: REMARK_COLOR[remark.severity] }}>
                  {reportable.length} correlated pressure spike{reportable.length === 1 ? '' : 's'} detected.
                </span>
              : <span style={{ color: '#3fb950' }}>
                  No correlated anomalies detected in this window{infoCount > 0 ? ` (${infoCount} CPU-only, not shown)` : ''}.
                </span>
          )}
        </td>
      </tr>
      {hasReportable && expanded && (
        <tr>
          <td colSpan={4} style={{ padding: 0 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
              <tbody>
                {reportable.map((e, i) => (
                  <tr
                    key={i}
                    style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)' }}
                    title={`Peak composite score ${e.peakCompositeScore.toFixed(2)} over ${e.bucketCount} bucket${e.bucketCount === 1 ? '' : 's'}`}
                  >
                    <td style={{ padding: '4px 8px 4px 12px', color: SEVERITY_COLOR[e.peakSeverity], fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {e.peakSeverity}
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--muted-foreground)', whiteSpace: 'nowrap' }}>
                      {e.metricsInvolved.join(' + ')}
                    </td>
                    {/* Why: each involved metric's peak during the episode against its own
                        window average — the anomaly is relative to that metric's trend,
                        not a fixed line, so the raw peak percentage alone doesn't say
                        whether it was actually unusual for that resource. */}
                    <td style={{ padding: '4px 8px', color: '#6e7681' }}>{explain(e, metrics)}</td>
                    {/* Which specific flags fired, translated into a where-to-look
                        hint — e.g. "API errors + DB CPU pressure — likely slow query
                        causing request timeouts" instead of just a metric list. */}
                    <td style={{ padding: '4px 8px', color: '#d29922' }}>{e.incidentType}</td>
                    <td style={{ padding: '4px 12px 4px 8px', color: '#8b9ab3', whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {fmtRange(e)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
