import { useState } from 'react';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import type { InvestigationTelemetry } from '@/hooks/useInvestigationTelemetry';
import type { EvidenceMarker } from '@/lib/evidence-markers';
import { circled } from '@/lib/evidence-markers';
import { CHART_COLORS } from '@/lib/chart-colors';
import { CombinedChart, MetricLegend, WorkerCountChart } from '@/components/azure/azureMetricChart';
import { workerChanges, workerCounts } from '@/components/azure/workerCount';
import { formatSgt } from '@/components/azure/rcaHtml';
import { IncidentTimeline, buildTimelineLanes } from '@/components/azure/incidentTimeline';
import { PerformanceChart } from '@/components/azure/performanceSection';
import { ReleaseMarkersContext } from '@/components/azure/releaseMarkers';
import { fmtDuration } from '@/components/azure/azureAppCard';
import { SkeletonBlock } from '@/components/azure/loadingSkeleton';
import { DownstreamFailures } from '@/components/azure/downstreamFailures';

const SYNC_ID = 'investigation-evidence';
const GRAIN_LABEL: Record<string, string> = { PT1M: '1-minute', PT5M: '5-minute', PT15M: '15-minute', PT1H: 'hourly', PT6H: '6-hourly' };

/**
 * The Evidences, drawn: App Health Check's own charts for the investigation window — its
 * Incident Timeline, CPU / memory / DB chart and the Frontend and API request charts — on
 * the same data the card fetches, with each numbered Evidences bullet marked at its moment.
 */
export function InvestigationCharts({ telemetry, loading, error, startMs, endMs, markers, hasApi, urMonitors, appKey, config }: {
  telemetry: InvestigationTelemetry | null;
  loading: boolean;
  error: string | null;
  startMs: number;
  endMs: number;
  markers: EvidenceMarker[];
  hasApi: boolean;
  urMonitors: UptimeRobotMonitor[];
  appKey: string;
  config: unknown;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  if (loading) {
    return (
      <div className="my-3 flex flex-col gap-2" aria-busy="true">
        <span className="text-[11px] text-muted-foreground">Loading the App Health Check charts for this window…</span>
        <SkeletonBlock className="w-full rounded-md" style={{ height: 200 }} />
      </div>
    );
  }
  if (error || !telemetry) {
    return error ? <p className="my-3 text-[11px] text-muted-foreground">Charts unavailable: {error}</p> : null;
  }
  const { metrics, releases, restarts, crashes, granularity } = telemetry;
  const lanes = buildTimelineLanes({
    startMs, endMs, metrics, hasApi,
    releases: releases?.fe, apiReleases: releases?.api,
    restarts: restarts?.fe, apiRestarts: restarts?.api,
    crashes: crashes?.fe, apiCrashes: crashes?.api,
    urMonitors,
  });
  const urDowntimeIntervals = urMonitors.flatMap(mon => (mon.logs ?? []).filter(l => l.type === 1)
    .map(l => ({ start: l.datetime * 1000, end: (l.datetime + l.duration) * 1000 })));
  const triple = (s: { avg: number; p99?: number | undefined; max: number }, unit: string, avg: string, max: string) => [
    { text: `${(+s.avg).toFixed(2)}${unit}`, color: avg },
    { text: `${(+(s.p99 ?? 0)).toFixed(2)}${unit}`, color: max },
    { text: `${(+s.max).toFixed(2)}${unit}`, color: max },
  ];
  const legend = [
    { key: 'cpu', label: 'CPU', values: triple(metrics.cpu, '%', CHART_COLORS.cpuAvg, CHART_COLORS.cpuMax) },
    { key: 'memory', label: 'Memory', values: triple(metrics.memory, metrics.memUnit ?? '%', CHART_COLORS.memAvg, CHART_COLORS.memMax) },
    ...(metrics.dbCpu?.series?.length ? [{ key: 'dbCpu', label: 'DB CPU', values: triple(metrics.dbCpu, '%', CHART_COLORS.dbCpuAvg, CHART_COLORS.dbCpuMax) }] : []),
    ...(metrics.dbMemory?.series?.length ? [{ key: 'dbMemory', label: 'DB Memory', values: triple(metrics.dbMemory, '%', CHART_COLORS.dbMemAvg, CHART_COLORS.dbMemMax) }] : []),
  ];
  const toggle = (key: string) => setHidden(prev => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  // Capacity: a step down before a surge (a scale-in, a killed worker) is often the cause.
  const workers = workerCounts(metrics.cpu.series.map(p => p.t), metrics.instanceHealthSeries, hasApi ? metrics.apiInstanceHealthSeries : null);
  const steps = workerChanges(workers);
  const fePerf = metrics.requestInsights?.performance;
  const apiPerf = metrics.apiRequestInsights?.performance;
  return (
    <ReleaseMarkersContext.Provider value={{ fe: releases?.fe?.events ?? [], api: releases?.api?.events ?? [], hasApi, evidence: markers }}>
      <section aria-label="Evidence charts" className="my-3 flex flex-col gap-3 rounded-md border border-border p-3 not-prose">
        {/* data-evidence-*: the exports picture each chart on its own (see withCharts). */}
        <div className="text-[11px] text-muted-foreground" data-evidence-caption>
          App Health Check's charts for this window, {GRAIN_LABEL[granularity] ?? granularity} buckets
          {markers.length > 0 && <> · {circled(1)}{markers.length > 1 ? `–${circled(markers.length)}` : ''} mark the evidence below</>}
        </div>
        <div data-evidence-chart="Incident timeline">
          <IncidentTimeline lanes={lanes} startMs={startMs} endMs={endMs} />
        </div>
        <div data-evidence-chart="CPU, memory and database">
          <CombinedChart
            cpu={metrics.cpu} memory={metrics.memory} dbCpu={metrics.dbCpu} dbMemory={metrics.dbMemory}
            downtimeIntervals={metrics.availability?.downtimeIntervals ?? []} urDowntimeIntervals={urDowntimeIntervals}
            hiddenMetrics={hidden} syncId={SYNC_ID} height={220}
          />
          <MetricLegend items={legend} hidden={hidden} onToggle={toggle} />
        </div>
        {workers.some(r => r.fe != null) && (
          <div data-evidence-chart="Workers serving requests">
            <div className="text-xs font-bold text-muted-foreground">
              Workers serving requests
              <span className="ml-2 font-normal">
                {steps.length
                  ? steps.slice(0, 6).map(s => `${s.from} → ${s.to} at ${formatSgt(Date.parse(s.t)).slice(11, 16)}`).join(' · ') + (steps.length > 6 ? ` · +${steps.length - 6} more` : '')
                  : `steady at ${workers.find(r => r.fe != null)?.fe}`}
              </span>
            </div>
            <WorkerCountChart rows={workers} syncId={SYNC_ID} />
          </div>
        )}
        {fePerf && (
          <div data-evidence-chart={hasApi ? 'Frontend requests' : 'Requests'}>
            <div className="text-xs font-bold text-muted-foreground">{hasApi ? 'Frontend' : 'Requests'}</div>
            <PerformanceChart perf={fePerf} fmtMs={fmtDuration} syncId={SYNC_ID} selected={null} drillHint={false} />
            <DownstreamFailures appKey={appKey} site="fe" config={config} startIso={new Date(startMs).toISOString()} endIso={new Date(endMs).toISOString()} />
          </div>
        )}
        {hasApi && apiPerf && (
          <div data-evidence-chart="API requests">
            <div className="text-xs font-bold text-muted-foreground">API</div>
            <PerformanceChart perf={apiPerf} fmtMs={fmtDuration} syncId={SYNC_ID} selected={null} drillHint={false} />
            <DownstreamFailures appKey={appKey} site="api" config={config} startIso={new Date(startMs).toISOString()} endIso={new Date(endMs).toISOString()} />
          </div>
        )}
      </section>
    </ReleaseMarkersContext.Provider>
  );
}
