import { useState, useRef, useEffect } from 'react';
import { Copy, ChevronDown, ChevronRight } from 'lucide-react';
import type { AppMetrics, MetricSeries } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CombinedChart, CHART_COLORS, INSTANCE_PALETTE } from './azureMetricChart';
import { useCopyElementAsImage } from '@/hooks/useCopyElementAsImage';
import { useUptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';

type Status = 'healthy' | 'warning' | 'critical';

type TimelineEvent = { t: number; label: string; color: string; icon: string; isMarker?: boolean };

type FailedDep = { t: string; name: string; type: string; target: string; failCount: number; avgDuration: number };
type ProbeSeries = Array<{ name: string; series: Array<{ t: string; v: number }> }>;

function buildTimeline(
  cpu: MetricSeries,
  memory: MetricSeries,
  instanceHealthSeries: Array<{ name: string; series: Array<{ t: string; v: number }> }>,
  ivStart: number,
  ivEnd: number,
  failedDependencies?: FailedDep[] | null,
  instanceProbeSeries?: ProbeSeries | null,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const DEP_WINDOW = 2 * 60 * 1000;

  const nearestVal = (series: MetricSeries['series'], t: number) => {
    let best: { t: string; v: number; m: number } | null = null;
    let bestDiff = Infinity;
    for (const p of series) {
      const diff = Math.abs(new Date(p.t).getTime() - t);
      if (diff < bestDiff) { bestDiff = diff; best = p; }
    }
    return best;
  };

  const baselineCpu = cpu.series.filter(p => new Date(p.t).getTime() < ivStart).at(-1);
  const baselineMem = memory.series.filter(p => new Date(p.t).getTime() < ivStart).at(-1);
  if (baselineCpu) {
    events.push({ t: new Date(baselineCpu.t).getTime(), label: `CPU ${baselineCpu.v.toFixed(1)}% · Mem ${(baselineMem?.v ?? 0).toFixed(1)}%`, color: '#484f58', icon: '◦' });
  }

  events.push({ t: ivStart, label: 'Incident start', color: '#f85149', icon: '▼', isMarker: true });

  const cpuDuring = cpu.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
  if (cpuDuring.length) {
    const peak = cpuDuring.reduce((max, p) => p.v > max.v ? p : max);
    if (peak.v > 70) events.push({ t: new Date(peak.t).getTime(), label: `CPU peak: ${peak.v.toFixed(1)}%`, color: peak.v > 90 ? '#f85149' : '#d29922', icon: '↑' });
  }

  const memDuring = memory.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
  if (memDuring.length) {
    const peak = memDuring.reduce((max, p) => p.v > max.v ? p : max);
    if (peak.v > 80) events.push({ t: new Date(peak.t).getTime(), label: `Mem peak: ${peak.v.toFixed(1)}%`, color: peak.v > 95 ? '#f85149' : '#d29922', icon: '↑' });
  }

  // Failed dependencies near incident — group by method+domain
  const nearDeps = (failedDependencies ?? []).filter(d => {
    const t = new Date(d.t).getTime();
    return t >= ivStart - DEP_WINDOW && t <= ivEnd + DEP_WINDOW;
  });
  const depDomainKey = (name: string): string => {
    const m = name.match(/^(GET|POST|PUT|DELETE|PATCH)\s+(.+)/i);
    const method = m ? (m[1] ?? '').toUpperCase() : '';
    const raw = m ? (m[2] ?? name) : name;
    try { const u = new URL(raw); return `${method} ${u.hostname}`.trim(); } catch { return (method + ' ' + raw.split('?')[0]).trim(); }
  };
  const depGroups = new Map<string, { domain: string; type: string; count: number; t: number; endpoints: Set<string> }>();
  for (const d of nearDeps) {
    const k = depDomainKey(d.name) + '||' + d.type;
    const t = new Date(d.t).getTime();
    const prev = depGroups.get(k);
    if (!prev) depGroups.set(k, { domain: depDomainKey(d.name), type: d.type, count: d.failCount, t, endpoints: new Set([d.name]) });
    else { prev.count += d.failCount; prev.t = Math.min(prev.t, t); prev.endpoints.add(d.name); }
  }
  const normDepType = (raw: string): string => {
    const t = raw.toLowerCase();
    if (t.includes('sql') || t.includes('sqlclient'))           return 'SQL';
    if (t.includes('redis') || t.includes('stackexchange'))     return 'Redis';
    if (t.includes('servicebus') || t.includes('service bus'))  return 'Service Bus';
    if (t.includes('eventhub') || t.includes('event hub'))      return 'Event Hub';
    if (t.includes('blob') || t.includes('storage'))            return 'Blob Storage';
    if (t.includes('cosmosdb') || t.includes('cosmos'))         return 'CosmosDB';
    if (t.includes('grpc'))                                     return 'gRPC';
    if (t.includes('http'))                                     return 'HTTP';
    if (t.includes('queue'))                                     return 'Queue';
    if (t.includes('table'))                                     return 'Table Storage';
    return raw || 'Unknown';
  };
  const topDeps = Array.from(depGroups.values()).sort((a, b) => b.count - a.count).slice(0, 5);
  for (const dep of topDeps) {
    const endpointStr = dep.endpoints.size > 1 ? ` (${dep.endpoints.size} endpoints)` : '';
    const typeLabel = normDepType(dep.type);
    events.push({ t: dep.t, label: `Dep failed [${typeLabel}]: ${dep.domain}${endpointStr} × ${dep.count}`, color: '#a371f7', icon: '⚡' });
  }

  // Collect drop timestamps to detect simultaneous drops
  const dropTimestamps: number[] = [];
  for (const inst of instanceHealthSeries) {
    const during = inst.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
    const firstDrop = during.find(p => p.v < 50);
    if (firstDrop) dropTimestamps.push(new Date(firstDrop.t).getTime());
  }
  const simultaneousThresholdMs = 60 * 1000;
  const allSimultaneous = dropTimestamps.length > 1 &&
    Math.max(...dropTimestamps) - Math.min(...dropTimestamps) <= simultaneousThresholdMs;

  for (const inst of instanceHealthSeries) {
    const shortName = inst.name.split('_').slice(-2).join('_') || inst.name;
    const during = inst.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
    const firstDrop = during.find(p => p.v < 50);
    if (firstDrop) {
      const dropT = new Date(firstDrop.t).getTime();

      // Diagnose cause at drop moment
      const cpuAtDrop = nearestVal(cpu.series, dropT);
      const memAtDrop = nearestVal(memory.series, dropT);
      const probeInst = (instanceProbeSeries ?? []).find(p => p.name === inst.name);
      const probeFailed = probeInst?.series.some(p => { const t = new Date(p.t).getTime(); return t >= dropT - 60000 && t <= dropT + 60000 && p.v < 100; });

      let cause = '';
      if (allSimultaneous && instanceHealthSeries.length > 1) {
        cause = 'simultaneous — platform/deploy';
      } else if (nearDeps.length > 0 && (cpuAtDrop?.v ?? 0) < 90 && (memAtDrop?.v ?? 0) < 90) {
        cause = 'dependency failure';
      } else if ((memAtDrop?.v ?? 0) >= 90) {
        cause = `OOM risk (Mem ${memAtDrop!.v.toFixed(0)}%)`;
      } else if ((cpuAtDrop?.v ?? 0) >= 95) {
        cause = `CPU exhaustion (CPU ${cpuAtDrop!.v.toFixed(0)}%)`;
      } else if (probeFailed) {
        cause = 'health probe failure';
      }

      const causeStr = cause ? ` — ${cause}` : '';
      events.push({ t: dropT, label: `${shortName}: health → ${firstDrop.v.toFixed(0)}%${causeStr}`, color: '#f85149', icon: '↓' });

      const dropIdx = during.indexOf(firstDrop);
      const recovery = during.slice(dropIdx + 1).find(p => p.v > 80);
      if (recovery) events.push({ t: new Date(recovery.t).getTime(), label: `${shortName}: recovered → ${recovery.v.toFixed(0)}%`, color: '#3fb950', icon: '↑' });
    }
  }

  events.push({ t: ivEnd, label: 'Incident end', color: '#3fb950', icon: '▲', isMarker: true });

  const recoveryCpu = cpu.series.find(p => new Date(p.t).getTime() > ivEnd);
  const recoveryMem = memory.series.find(p => new Date(p.t).getTime() > ivEnd);
  if (recoveryCpu) {
    events.push({ t: new Date(recoveryCpu.t).getTime(), label: `CPU ${recoveryCpu.v.toFixed(1)}% · Mem ${(recoveryMem?.v ?? 0).toFixed(1)}%`, color: '#484f58', icon: '◦' });
  }

  return events.sort((a, b) => a.t - b.t);
}

export function getStatus(cpuAvg: number, memAvg: number, cpuMax?: number, memMax?: number): Status {
  if (cpuAvg > 90 || memAvg > 95 || (cpuMax ?? 0) >= 100 || (memMax ?? 0) >= 100) return 'critical';
  if (cpuAvg > 70 || memAvg > 80  || (cpuMax ?? 0) > 85  || (memMax ?? 0) > 90)  return 'warning';
  return 'healthy';
}

const STATUS_COLORS: Record<Status, string> = {
  healthy:  '#3fb950',
  warning:  '#d29922',
  critical: 'hsl(var(--destructive))',
};

const STATUS_BORDER: Record<Status, string> = {
  healthy:  '',
  warning:  'oklch(0.5 0.15 75)',
  critical: 'hsl(var(--destructive) / 0.5)',
};

interface AzureAppCardProps {
  appKey: string;
  metrics: AppMetrics;
  loading: boolean;
  azureSettings: AzureSettings;
  uptimeRobotApiKey?: string | undefined;
  uptimeRobotMonitorIds?: string[] | undefined;
  rangeStart?: string | undefined;
  rangeEnd?: string | undefined;
}


function SkeletonBlock({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className ?? ''}`} />;
}

export function AzureAppCard({ appKey, metrics, loading, azureSettings, uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd }: AzureAppCardProps) {
  const { elementRef: cardRef, copyAsImage, isCopying } = useCopyElementAsImage<HTMLDivElement>({
    fileNamePrefix: `azure-${appKey}-${Date.now()}`,
    backgroundColor: '#09090b',
  });
  const [urExpanded, setUrExpanded] = useState(false);
  type IncidentPopup = {
    date: string; timeRange: string; dur: string; reasons: string[]; causeLabel: string | null; causeColor: string;
    cpu: MetricSeries; memory: MetricSeries;
    instanceHealthSeries: Array<{ name: string; series: Array<{ t: string; v: number }> }>;
    ivStart: number; ivEnd: number;
  };
  const [selectedIncident, setSelectedIncident] = useState<IncidentPopup | null>(null);
  const [popupChartLoading, setPopupChartLoading] = useState(false);
  const reportActionsRef = useRef<{ copy: () => void; pdf: () => void } | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [highFreqOpen, setHighFreqOpen] = useState(false);
  const [depsOpen, setDepsOpen] = useState(false);
  const [instOpen, setInstOpen] = useState(false);
  const [probesOpen, setProbesOpen] = useState(false);
  const [trafficOpen, setTrafficOpen] = useState(false);
  type HighFreqEntry = { timestamp: string; lastSeen?: string; ip: string; country: string; userAgent: string; count: number; rpm: number };
  type PopupChartData = {
    cpu: MetricSeries; memory: MetricSeries;
    instanceHealthSeries: Array<{ name: string; series: Array<{ t: string; v: number }> }>;
    failedDependencies?: FailedDep[] | null;
    instanceProbeSeries?: ProbeSeries | null;
    highFreq?: HighFreqEntry[] | null;
    requestsSeries?: Array<{ t: string; count: number }> | null;
    failedRequestsSeries?: Array<{ t: string; count: number }> | null;
    http4xxSeries?: Array<{ t: string; count: number }> | null;
    responseTime?: { avg: number; max: number } | null;
    requests?: { total: number } | null;
    failedRequests?: { total: number } | null;
    requestInsights?: AppMetrics['requestInsights'];
  };
  const [popupChartData, setPopupChartData] = useState<PopupChartData | null>(null);
  const [detectorData, setDetectorData] = useState<import('@shared/types/azureMetrics.types').DetectorAnalysisResult | null>(null);
  const [detectorLoading, setDetectorLoading] = useState(false);
  const { monitors: urMonitors, loading: urLoading, error: urError } = useUptimeRobotMonitor(uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd);
  const [requestsExpanded, setRequestsExpanded] = useState(false);
  const [availExpanded, setAvailExpanded] = useState(false);
  const [responseExpanded, setResponseExpanded] = useState(false);
  const [requestsTab, setRequestsTab] = useState<'requests' | 'highfreq' | 'failed' | 'deps'>('requests');

  // PT1M data fetched separately for the incidents panel — avoids dashboard-interval gaps
  const [incidentDetailMetrics, setIncidentDetailMetrics] = useState<AppMetrics | null>(null);
  const [incidentDetailLoading, setIncidentDetailLoading] = useState(false);

  useEffect(() => {
    if (!urExpanded) return;
    if (!rangeStart || !rangeEnd) return;
    setIncidentDetailLoading(true);
    setIncidentDetailMetrics(null);
    window.electronAPI.azureMetrics.fetch({
      appKeys: [appKey],
      range: 'custom',
      config: azureSettings,
      customStart: rangeStart,
      customEnd: rangeEnd,
      granularity: 'PT1M',
    }).then(data => {
      const m = data[appKey];
      if (m) setIncidentDetailMetrics(m);
    }).catch(() => {}).finally(() => setIncidentDetailLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urExpanded, rangeStart, rangeEnd, appKey]);

  if (loading) {
    return (
      <Card className="overflow-hidden">
        <div className="px-4 pt-4 pb-2 flex justify-between items-center">
          <SkeletonBlock className="h-4 w-48" />
          <SkeletonBlock className="h-7 w-7 rounded" />
        </div>
        <SkeletonBlock className="h-[200px] w-full rounded-none" />
        <div className="px-4 py-3 flex gap-4">
          {[0,1,2,3].map(i => <SkeletonBlock key={i} className="h-3.5 w-20" />)}
        </div>
      </Card>
    );
  }



  const memPct = metrics.memUnit === 'MB' ? 0 : metrics.memory.avg;
  const memMaxPct = metrics.memUnit === 'MB' ? 0 : metrics.memory.max;
  const status = getStatus(metrics.cpu.avg, memPct, metrics.cpu.max, memMaxPct);
  const borderColor = STATUS_BORDER[status];
  const statusColor = STATUS_COLORS[status];
  const downtimeIntervals = metrics.availability?.downtimeIntervals ?? [];

  // Map instance name → palette color matching chart line order
  const instanceColorMap = new Map<string, string>(
    (metrics.instanceHealthSeries ?? []).map((inst, i): [string, string] => [inst.name, INSTANCE_PALETTE[i % INSTANCE_PALETTE.length] ?? '#8b9ab3'])
  );

  const planMeta = metrics.plan
    ? [metrics.plan.sku, metrics.plan.cores > 0 ? `${metrics.plan.cores}c` : null]
        .filter(Boolean).join(' · ')
    : null;

  const typeLabel = metrics.type === 'appservice' ? 'App Service' : 'Container App';

  const SGT = { timeZone: 'Asia/Singapore' } as const;
  const fmtShort = (d: Date) => d.toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' SGT';
  const seriesStart = metrics.cpu.series[0]?.t ? fmtShort(new Date(metrics.cpu.series[0].t)) : null;
  const seriesEnd = metrics.cpu.series.at(-1)?.t ? fmtShort(new Date(metrics.cpu.series.at(-1)!.t)) : null;
  const spanMinutes = metrics.cpu.series.length > 1
    ? (new Date(metrics.cpu.series.at(-1)!.t).getTime() - new Date(metrics.cpu.series[0]!.t).getTime()) / 60000
    : 0;


  const CAUSE_LABEL: Record<string, string> = {
    instance_crash:     'Instance Crash',
    full_outage:        'Full Outage',
    dependency_failure: 'Dependency Failure',
    outage:             'Outage',
  };
  const CAUSE_COLOR: Record<string, string> = {
    instance_crash:     '#f0883e',
    full_outage:        'hsl(var(--destructive))',
    dependency_failure: '#a371f7',
    outage:             'hsl(var(--destructive))',
  };
  const CAUSE_DETAIL: Record<string, { what: string; why: string; signals: string }> = {
    instance_crash:     { what: 'One or more instances stopped serving requests', why: 'Instance-level failure — crash, OOM, or unhealthy container restart', signals: 'Instance health dropped below 50% while other instances remained healthy' },
    full_outage:        { what: 'All instances simultaneously stopped serving requests', why: 'Platform-wide failure or deployment gone wrong affecting every instance', signals: 'All instances showed degraded health during the incident window' },
    dependency_failure: { what: 'App instances healthy but requests failing', why: 'External dependency (database, API, service bus) unavailable or timing out', signals: 'Instance health normal — failures originated outside the app process' },
    outage:             { what: 'Confirmed outage — cause undetermined', why: 'All 4 conditions met but no clear signal points to a specific root cause', signals: 'Availability drop + 5xx spike + probe failure all confirmed' },
  };

  return (
    <>
    <div ref={cardRef} className="p-3">
    <Card
      className="overflow-hidden p-0 flex flex-col border-2"
      style={borderColor ? { borderColor } : undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="relative inline-flex items-center justify-center w-3 h-3 flex-shrink-0">
            {status === 'healthy' && !isCopying && (
              <span className="absolute inline-flex w-full h-full rounded-full animate-ping opacity-60" style={{ backgroundColor: statusColor }} />
            )}
            <span className="relative inline-flex w-2.5 h-2.5 rounded-full" style={{ backgroundColor: statusColor }} />
          </span>
          <h2 className="font-bold text-base m-0">{metrics.label}</h2>
          <span className="text-xs text-muted-foreground">
            {typeLabel}{planMeta ? ` · ${planMeta}` : ''}
          </span>
          {metrics.appInsightsConfigured && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(88,166,255,0.12)', color: '#58a6ff', border: '1px solid rgba(88,166,255,0.3)' }}>
              App Insights
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {seriesStart && seriesEnd && (
            <span className="text-[10px] text-muted-foreground">{seriesStart} → {seriesEnd}</span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={copyAsImage}
            style={{ visibility: isCopying ? 'hidden' : 'visible' }}
            title="Copy as image"
            data-html2canvas-ignore="true"
          >
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Error */}
      {metrics.error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-md text-xs border border-destructive/30 bg-destructive/10 text-destructive">
          {metrics.error}
        </div>
      )}

      {/* Chart — edge to edge */}
      <CombinedChart
        cpu={metrics.cpu}
        memory={metrics.memory}
        downtimeIntervals={downtimeIntervals}
        availabilitySeries={metrics.availability?.series}
        instanceHealthSeries={metrics.instanceHealthSeries ?? null}
        loading={false}
      />

      {/* Metrics + Downtime incidents */}
      <div className="px-4 pt-3 pb-3 text-xs font-medium flex flex-col gap-3">

        {(
        <div className="rounded-md border border-border overflow-hidden">
        <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1">
          <thead>
            <tr className="text-muted-foreground font-bold">
              <td />
              <td className="text-right">Average</td>
              <td className="text-right">Max</td>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="text-muted-foreground">CPU</td>
              <td className="text-right" style={{ color: CHART_COLORS.cpuAvg }}>{(+metrics.cpu.avg).toFixed(2)}%</td>
              <td className="text-right" style={{ color: CHART_COLORS.cpuMax }}>{(+metrics.cpu.max).toFixed(2)}%</td>
            </tr>
            <tr>
              <td className="text-muted-foreground font-bold">Memory</td>
              <td className="text-right" style={{ color: CHART_COLORS.memAvg }}>{(+metrics.memory.avg).toFixed(2)}{metrics.memUnit}</td>
              <td className="text-right" style={{ color: CHART_COLORS.memMax }}>{(+metrics.memory.max).toFixed(2)}{metrics.memUnit}</td>
            </tr>
            {metrics.responseTime != null && (() => {
              const slowUrls = Array.isArray(metrics.requestInsights?.slowUrls) ? metrics.requestInsights!.slowUrls : [];
              const hasSlow = slowUrls.length > 0;
              const fmtMs = (ms: number) => ms >= 60000 ? `${(ms/60000).toFixed(1)}m` : ms >= 1000 ? `${(ms/1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
              return (
                <>
                  <tr
                    style={{ cursor: hasSlow ? 'pointer' : 'default' }}
                    onClick={() => hasSlow && setResponseExpanded(v => !v)}
                    onMouseEnter={e => hasSlow && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      Response{hasSlow && <span style={{ marginLeft: 4, fontSize: 10, verticalAlign: 'middle' }}>{responseExpanded ? '▾' : '›'}</span>}
                    </td>
                    <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.avg}s</td>
                    <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.max}s</td>
                  </tr>
                  {responseExpanded && slowUrls.map((u, i) => {
                    const avgColor = u.avgMs >= 5000 ? 'hsl(var(--destructive))' : u.avgMs >= 2000 ? '#d29922' : '#58a6ff';
                    const maxColor = u.maxMs >= 10000 ? 'hsl(var(--destructive))' : u.maxMs >= 5000 ? '#d29922' : '#484f58';
                    return (
                      <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td className="text-muted-foreground truncate max-w-0" style={{ paddingLeft: 20 }} title={u.url}>{u.url}</td>
                        <td className="text-right tabular-nums" style={{ color: avgColor, whiteSpace: 'nowrap' }}>{fmtMs(u.avgMs)}</td>
                        <td className="text-right tabular-nums" style={{ color: maxColor, whiteSpace: 'nowrap' }}>{fmtMs(u.maxMs)} max</td>
                      </tr>
                    );
                  })}
                </>
              );
            })()}
            {metrics.availability != null && (() => {
              const availColor = metrics.availability.pct >= 99 ? '#3fb950' : metrics.availability.pct >= 95 ? '#d29922' : 'hsl(var(--destructive))';
              const instances = metrics.instances ?? [];
              const hasInstances = instances.length > 0;
              return (
                <>
                  <tr
                    style={{ cursor: hasInstances ? 'pointer' : 'default' }}
                    onClick={() => hasInstances && setAvailExpanded(v => !v)}
                    onMouseEnter={e => hasInstances && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      Availability{hasInstances && <span style={{ marginLeft: 4, fontSize: 10, verticalAlign: 'middle' }}>{availExpanded ? '▾' : '›'}</span>}
                    </td>
                    <td className="text-right" colSpan={2} style={{ color: availColor }}>{metrics.availability.pct.toFixed(2)}%</td>
                  </tr>
                  {availExpanded && instances.map((inst, i) => {
                    const series = (metrics.instanceHealthSeries ?? []).find(s => s.name === inst.name);
                    const vals = series?.series.map(p => p.v) ?? [];
                    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                    const min = vals.length ? Math.min(...vals) : null;
                    const avgColor = avg == null ? '#8b9ab3' : avg >= 99 ? '#3fb950' : avg >= 90 ? '#d29922' : 'hsl(var(--destructive))';
                    const minColor = min == null ? '#484f58' : min >= 99 ? '#3fb950' : min >= 90 ? '#d29922' : 'hsl(var(--destructive))';
                    const shortName = inst.name.split('_').slice(-2).join('_') || inst.name;
                    return (
                      <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td className="text-muted-foreground truncate max-w-0" style={{ paddingLeft: 20 }} title={inst.name}>{shortName}</td>
                        <td className="text-right tabular-nums" style={{ color: avgColor }}>{avg != null ? `${avg.toFixed(2)}%` : '—'}</td>
                        <td className="text-right tabular-nums" style={{ color: minColor }}>{min != null ? `${min.toFixed(2)}% min` : '—'}</td>
                      </tr>
                    );
                  })}
                </>
              );
            })()}
            {urMonitors.length > 0 && (() => {
              const downLogs = urMonitors.flatMap(m => (m.logs ?? []).filter(l => l.type === 1));
              const totalIncidents = downLogs.length;
              const totalDownSec = downLogs.reduce((s, l) => s + l.duration, 0);
              const spanSec = spanMinutes * 60;
              const uptimePct = spanSec > 0 ? Math.round((1 - totalDownSec / spanSec) * 10000) / 100 : null;
              const uptimeColor = uptimePct == null ? '#8b9ab3' : uptimePct >= 99 ? '#3fb950' : uptimePct >= 95 ? '#d29922' : 'hsl(var(--destructive))';
              const fmtDur = (sec: number) => sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)}m` : `${(sec / 3600).toFixed(1)}h`;
              const incidentColor = totalIncidents === 0 ? '#3fb950' : '#f85149';
              return (
                <>
                  <tr
                    onClick={() => setUrExpanded(v => !v)}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      UptimeRobot<span style={{ marginLeft: 4, fontSize: 10, verticalAlign: 'middle' }}>{urExpanded ? '▾' : '›'}</span>
                    </td>
                    <td className="text-right tabular-nums" style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: incidentColor }}>{totalIncidents} incident{totalIncidents !== 1 ? 's' : ''}</span>
                      {totalDownSec > 0 && <span style={{ color: '#484f58' }}> · </span>}
                      {totalDownSec > 0 && <span style={{ color: incidentColor }}>{fmtDur(totalDownSec)} down</span>}
                    </td>
                    <td className="text-right tabular-nums" style={{ color: uptimeColor, whiteSpace: 'nowrap' }}>
                      {uptimePct != null ? `${uptimePct.toFixed(2)}% uptime` : '—'}
                    </td>
                  </tr>
                  {urExpanded && (
                    <tr>
                      <td colSpan={3} style={{ padding: 0 }}>
                        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                          {(urLoading || incidentDetailLoading) && <div style={{ padding: '6px 10px', fontSize: 10, color: '#8b9ab3' }}>{urLoading ? 'Loading monitors…' : 'Loading…'}</div>}
                          {urError && <div style={{ padding: '6px 10px', fontSize: 10, color: 'hsl(var(--destructive))' }}>{urError}</div>}
                          {!urLoading && urMonitors.length === 0 && !urError && (
                            <div style={{ padding: '6px 10px', fontSize: 10, color: '#8b9ab3', fontStyle: 'italic' }}>No monitors found</div>
                          )}
                          {!urLoading && !incidentDetailLoading && (() => {
                            const muted = '#8b9ab3';
                            const iMet = incidentDetailMetrics ?? metrics;
                            const cpuSeries = iMet.cpu.series;
                            const memSeries = iMet.memory.series;
                            const reqSeries = iMet.requestsSeries ?? [];
                            const failSeries: Array<{ t: string; count: number }> = (() => {
                              const m = new Map<string, number>();
                              for (const s of [...(iMet.failedRequestsSeries ?? []), ...(iMet.http4xxSeries ?? [])]) {
                                m.set(s.t, (m.get(s.t) ?? 0) + s.count);
                              }
                              return Array.from(m.entries()).map(([t, count]) => ({ t, count }));
                            })();
                            function maxInRangeUr(series: Array<{ t: string; v: number }>, start: number, end: number) {
                              const vals = series.filter(s => { const t = new Date(s.t).getTime(); return t >= start && t <= end; }).map(s => s.v);
                              return vals.length ? Math.max(...vals) : null;
                            }
                            function maxDuringUr(series: Array<{ t: string; v: number }>, ivStart: number, ivEnd: number) {
                              const strict = maxInRangeUr(series, ivStart, ivEnd);
                              if (strict !== null) return strict;
                              return maxInRangeUr(series, ivStart - 60 * 60 * 1000, ivEnd);
                            }
                            function sumInRangeUr(series: Array<{ t: string; count: number }>, start: number, end: number) {
                              return series.filter(s => { const t = new Date(s.t).getTime(); return t >= start && t <= end; }).reduce((acc, s) => acc + s.count, 0);
                            }
                            function sumDuringUr(series: Array<{ t: string; count: number }>, ivStart: number, ivEnd: number) {
                              const strict = sumInRangeUr(series, ivStart, ivEnd);
                              if (strict > 0) return strict;
                              return sumInRangeUr(series, ivStart - 60 * 60 * 1000, ivEnd);
                            }
                            function instSnapsInRange(start: number, end: number) {
                              return (iMet.instanceHealthSeries ?? []).map(inst => {
                                const pts = inst.series.filter(s => { const t = new Date(s.t).getTime(); return t >= start && t <= end; });
                                const avg = pts.length ? Math.round(pts.reduce((a, s) => a + s.v, 0) / pts.length * 10) / 10 : null;
                                const min = pts.length ? Math.min(...pts.map(s => s.v)) : null;
                                return { name: inst.name, avg, min };
                              }).filter(s => s.avg != null);
                            }
                            const rawLogs2 = urMonitors.flatMap(mon =>
                              (mon.logs ?? []).filter(l => l.type === 1).map(log => ({ log, mon }))
                            ).sort((a, b) => a.log.datetime - b.log.datetime);
                            if (rawLogs2.length === 0 && urMonitors.length > 0 && !incidentDetailLoading) {
                              return <div style={{ padding: '5px 10px', fontSize: 10, color: muted, fontStyle: 'italic' }}>No downtime recorded</div>;
                            }
                            type FlatInc2 = { ivStart: number; ivEnd: number; url: string; reason: string };
                            const flat2: FlatInc2[] = rawLogs2.map(({ log, mon }) => ({
                              ivStart: log.datetime * 1000,
                              ivEnd:   (log.datetime + log.duration) * 1000,
                              url:     mon.url || mon.friendly_name,
                              reason:  log.reason?.detail ?? '',
                            })).sort((a, b) => b.ivStart - a.ivStart);
                            const byDate2 = new Map<string, FlatInc2[]>();
                            flat2.forEach(inc => {
                              const dateKey = new Date(inc.ivStart).toLocaleDateString('en-GB', { ...SGT, day: '2-digit', month: 'short', year: 'numeric' });
                              if (!byDate2.has(dateKey)) byDate2.set(dateKey, []);
                              byDate2.get(dateKey)!.push(inc);
                            });
                            return Array.from(byDate2.entries()).map(([dateKey, incidents]) => (
                              <div key={dateKey} className="scrollable-content" style={{ maxHeight: 200, overflowY: 'auto' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                                  <thead>
                                    <tr>
                                      <td colSpan={16} style={{ padding: '3px 10px', fontSize: 9, fontWeight: 700, color: '#484f58', borderBottom: '1px solid rgba(255,255,255,0.04)', borderTop: '1px solid rgba(255,255,255,0.04)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{dateKey}</td>
                                    </tr>
                                    <tr style={{ color: '#484f58', fontWeight: 700 }}>
                                      <td rowSpan={2} style={{ padding: '3px 10px', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>Time (SGT)</td>
                                      <td rowSpan={2} style={{ padding: '3px 6px', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>Dur</td>
                                      <td rowSpan={2} style={{ padding: '3px 6px', verticalAlign: 'bottom' }}>Cause</td>
                                      <td rowSpan={2} style={{ padding: '3px 6px', verticalAlign: 'bottom' }}>Monitored</td>
                                      <td colSpan={4} style={{ padding: '2px 6px', textAlign: 'center', color: '#484f58', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>Before (5min)</td>
                                      <td colSpan={4} style={{ padding: '2px 6px', textAlign: 'center', color: '#8b9ab3', borderBottom: '1px solid rgba(255,255,255,0.04)', borderLeft: '1px solid rgba(255,255,255,0.06)', borderRight: '1px solid rgba(255,255,255,0.06)' }}>During</td>
                                      <td colSpan={4} style={{ padding: '2px 6px', textAlign: 'center', color: '#484f58', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>After (5min)</td>
                                    </tr>
                                    <tr style={{ color: '#484f58', fontWeight: 700 }}>
                                      {['Instances','Req','CPU','Mem','Instances','Req','CPU','Mem','Instances','Req','CPU','Mem'].map((h, i) => (
                                        <td key={i} style={{ padding: '2px 6px', textAlign: i % 4 !== 0 ? 'right' : undefined, ...(i === 4 ? { borderLeft: '1px solid rgba(255,255,255,0.06)' } : {}), ...(i === 7 ? { borderRight: '1px solid rgba(255,255,255,0.06)' } : {}) }}>{h}</td>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {incidents.map((inc, i) => {
                                      const { ivStart, ivEnd, url, reason } = inc;
                                      const reasons = reason ? [reason] : [];
                                      const logKey = `${dateKey}-${i}`;
                                      const durSecs = Math.round((ivEnd - ivStart) / 1000);
                                      const dur = durSecs >= 3600 ? `${Math.floor(durSecs/3600)}h ${Math.floor((durSecs%3600)/60)}m ${durSecs%60}s` : durSecs >= 60 ? `${Math.floor(durSecs/60)}m ${durSecs%60}s` : `${durSecs}s`;
                                      const startLabel = new Date(ivStart).toLocaleString('en-GB', { ...SGT, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                      const endLabel   = new Date(ivEnd).toLocaleString('en-GB', { ...SGT, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                      const PRE = 5 * 60 * 1000;
                                      const PRE_END = ivStart - 60 * 1000;
                                      const cpuBefore  = maxInRangeUr(cpuSeries, ivStart - PRE, PRE_END);
                                      const cpuDuring  = maxDuringUr(cpuSeries, ivStart, ivEnd) ?? iMet.cpu.avg;
                                      const cpuAfter   = maxInRangeUr(cpuSeries, ivEnd, ivEnd + PRE);
                                      const memBefore  = maxInRangeUr(memSeries, ivStart - PRE, PRE_END);
                                      const memDuring  = maxDuringUr(memSeries, ivStart, ivEnd) ?? (iMet.memUnit !== 'MB' ? iMet.memory.avg : null);
                                      const memAfter   = maxInRangeUr(memSeries, ivEnd, ivEnd + PRE);
                                      const reqBefore  = sumInRangeUr(reqSeries,  ivStart - PRE, PRE_END);
                                      const reqDuring  = sumDuringUr(reqSeries,  ivStart, ivEnd);
                                      const reqAfter   = sumInRangeUr(reqSeries,  ivEnd, ivEnd + PRE);
                                      const failBefore = sumInRangeUr(failSeries, ivStart - PRE, PRE_END);
                                      const failDuring = sumDuringUr(failSeries, ivStart, ivEnd);
                                      const failAfter  = sumInRangeUr(failSeries, ivEnd, ivEnd + PRE);
                                      const cpuColor = cpuDuring > 90 ? 'hsl(var(--destructive))' : cpuDuring > 70 ? '#d29922' : muted;
                                      const memColor = memDuring == null ? muted : memDuring > 95 ? 'hsl(var(--destructive))' : memDuring > 80 ? '#d29922' : muted;
                                      const urCause = (() => {
                                        if (failDuring === 0) return null;
                                        const availPts = (iMet.availability?.series ?? []).filter(s => { const t = new Date(s.t).getTime(); return t >= ivStart && t <= ivEnd; });
                                        const availAvg = availPts.length ? availPts.reduce((a, s) => a + s.v, 0) / availPts.length : null;
                                        if (availAvg !== null && availAvg >= 100) return null;
                                        const instHealthVals = (iMet.instanceHealthSeries ?? []).map(inst => {
                                          const pts = inst.series.filter(s => { const t = new Date(s.t).getTime(); return t >= ivStart && t <= ivEnd; });
                                          return pts.length ? pts.reduce((a, s) => a + s.v, 0) / pts.length : null;
                                        }).filter((v): v is number => v !== null);
                                        if (instHealthVals.length === 0) return 'outage';
                                        const total = instHealthVals.length;
                                        const affected = instHealthVals.filter(v => v < 50).length;
                                        if (affected === 0) return 'dependency_failure';
                                        if (affected < total) return 'instance_crash';
                                        return 'full_outage';
                                      })();
                                      const urCauseColor = CAUSE_COLOR[urCause ?? ''] ?? muted;
                                      const instBefore = instSnapsInRange(ivStart - PRE, PRE_END);
                                      const instDuring = instSnapsInRange(ivStart, ivEnd);
                                      const instAfter  = instSnapsInRange(ivEnd, ivEnd + PRE);
                                      const openPopup = () => {
                                        const instSeries = iMet.instanceHealthSeries ?? [];
                                        const filteredCpu = cpuSeries.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart - PRE && t <= ivEnd + PRE; });
                                        const filteredMem = memSeries.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart - PRE && t <= ivEnd + PRE; });
                                        const filteredInst = instSeries.map(inst => ({ name: inst.name, series: inst.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart - PRE && t <= ivEnd + PRE; }) }));
                                        const cpuVals = filteredCpu.map(p => p.v);
                                        const memVals = filteredMem.map(p => p.v);
                                        const cpuMetric: MetricSeries = { avg: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length * 10) / 10 : 0, max: cpuVals.length ? Math.max(...cpuVals) : 0, series: filteredCpu };
                                        const memMetric: MetricSeries = { avg: memVals.length ? Math.round(memVals.reduce((a, b) => a + b, 0) / memVals.length * 10) / 10 : 0, max: memVals.length ? Math.max(...memVals) : 0, series: filteredMem };
                                        setSelectedIncident({ date: dateKey, timeRange: `${startLabel} → ${endLabel}`, dur, reasons, causeLabel: urCause ? (CAUSE_LABEL[urCause] ?? null) : null, causeColor: urCauseColor, cpu: cpuMetric, memory: memMetric, instanceHealthSeries: filteredInst, ivStart, ivEnd });
                                        setPopupChartData(null); setDetectorData(null); setTimelineOpen(false); setHighFreqOpen(false); setDepsOpen(false); setInstOpen(false); setProbesOpen(false); setTrafficOpen(false);
                                        setPopupChartLoading(true);
                                        window.electronAPI.azureMetrics.fetch({ appKeys: [appKey], range: 'custom', config: azureSettings, customStart: new Date(ivStart - PRE).toISOString(), customEnd: new Date(ivEnd).toISOString(), granularity: 'PT1M' })
                                          .then(data => { const m = data[appKey]; if (m) setPopupChartData({ cpu: m.cpu, memory: m.memory, instanceHealthSeries: m.instanceHealthSeries ?? [], failedDependencies: m.failedDependencies ?? null, instanceProbeSeries: m.instanceProbeSeries ?? null, highFreq: m.requestInsights?.highFreq ?? null, requestsSeries: m.requestsSeries ?? null, failedRequestsSeries: m.failedRequestsSeries ?? null, http4xxSeries: m.http4xxSeries ?? null, responseTime: m.responseTime ? { avg: m.responseTime.avg, max: m.responseTime.max } : null, requests: m.requests ?? null, failedRequests: m.failedRequests ?? null, requestInsights: m.requestInsights ?? null }); })
                                          .catch(() => {}).finally(() => setPopupChartLoading(false));
                                        const aiAppId = (azureSettings as any)?.apps?.find((a: any) => a.name === appKey)?.appInsightsAppId ?? null;
                                        if (metrics.appInsightsConfigured && aiAppId) {
                                          setDetectorLoading(true);
                                          window.electronAPI.azureMetrics.fetchDetectors({ appInsightsAppId: aiAppId, startIso: new Date(ivStart - PRE).toISOString(), endIso: new Date(ivEnd).toISOString() })
                                            .then(r => setDetectorData(r))
                                            .catch((e: Error) => setDetectorData({ categories: [], error: e.message }))
                                            .finally(() => setDetectorLoading(false));
                                        }
                                      };
                                      return (
                                        <tr key={logKey} onClick={openPopup} style={{ cursor: 'pointer', borderTop: '1px solid rgba(255,255,255,0.04)' }}
                                          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                                          <td style={{ padding: '4px 10px', color: muted, whiteSpace: 'nowrap' }}>{startLabel} → {endLabel}</td>
                                          <td style={{ padding: '4px 6px', color: '#d29922', whiteSpace: 'nowrap' }}>{dur}</td>
                                          <td style={{ padding: '4px 6px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {urCause
                                              ? <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.04em', padding: '1px 4px', borderRadius: 3, background: `${urCauseColor}22`, border: `1px solid ${urCauseColor}55`, color: urCauseColor }}>{CAUSE_LABEL[urCause]}</span>
                                              : reasons.length > 0 ? <span style={{ color: muted }}>{reasons.join(' · ')}</span> : <span style={{ color: '#484f58' }}>—</span>}
                                          </td>
                                          <td style={{ padding: '4px 6px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            <span style={{ color: '#58a6ff' }}>{url}</span>
                                          </td>
                                          <td style={{ padding: '4px 6px' }}>{instBefore.length === 0 ? <span style={{ color: '#484f58' }}>—</span> : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{instBefore.map((inst, ii) => { const lc = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length]; return <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}><span style={{ color: lc }}>●</span><span style={{ color: '#484f58' }}>{inst.avg}% / {inst.min}%</span></div>; })}</div>}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', color: '#484f58' }}>{reqBefore > 0 ? <><span style={{ color: failBefore > 0 ? '#d29922' : '#484f58' }}>{failBefore.toLocaleString()}</span><span> / </span><span>{reqBefore.toLocaleString()}</span></> : '—'}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{cpuBefore != null ? `${cpuBefore.toFixed(1)}%` : '—'}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{memBefore != null ? `${memBefore.toFixed(1)}%` : '—'}</td>
                                          <td style={{ padding: '4px 6px', borderLeft: '1px solid rgba(255,255,255,0.06)' }}>{instDuring.length === 0 ? <span style={{ color: '#484f58' }}>—</span> : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{instDuring.map((inst, ii) => { const lc = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length]; const hc = (inst.avg ?? 100) < 50 ? 'hsl(var(--destructive))' : (inst.avg ?? 100) < 90 ? '#d29922' : '#3fb950'; return <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}><span style={{ color: lc }}>●</span><span style={{ color: hc }}>{inst.avg}% / {inst.min}%</span></div>; })}</div>}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>{reqDuring > 0 ? <><span style={{ color: failDuring > 0 ? 'hsl(var(--destructive))' : muted }}>{failDuring.toLocaleString()}</span><span style={{ color: '#484f58' }}> / </span><span style={{ color: muted }}>{reqDuring.toLocaleString()}</span></> : <span style={{ color: '#484f58' }}>—</span>}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: cpuColor, whiteSpace: 'nowrap' }}>{cpuDuring.toFixed(1)}%</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: memColor, whiteSpace: 'nowrap', borderRight: '1px solid rgba(255,255,255,0.06)' }}>{memDuring != null ? `${memDuring.toFixed(1)}%` : '—'}</td>
                                          <td style={{ padding: '4px 6px' }}>{instAfter.length === 0 ? <span style={{ color: '#484f58' }}>—</span> : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{instAfter.map((inst, ii) => { const lc = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length]; return <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}><span style={{ color: lc }}>●</span><span style={{ color: '#484f58' }}>{inst.avg}% / {inst.min}%</span></div>; })}</div>}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', color: '#484f58' }}>{reqAfter > 0 ? <><span style={{ color: failAfter > 0 ? '#d29922' : '#484f58' }}>{failAfter.toLocaleString()}</span><span> / </span><span>{reqAfter.toLocaleString()}</span></> : '—'}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{cpuAfter != null ? `${cpuAfter.toFixed(1)}%` : '—'}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{memAfter != null ? `${memAfter.toFixed(1)}%` : '—'}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            ));
                          })()}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })()}
            {metrics.requests != null && (
              <>
                <tr
                  style={{ cursor: 'pointer' }}
                  onClick={() => setRequestsExpanded(v => !v)}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td className="text-muted-foreground font-bold">
                    Requests<span style={{ marginLeft: 4, fontSize: 10, verticalAlign: 'middle' }}>{requestsExpanded ? '▾' : '›'}</span>
                  </td>
                  <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                    {spanMinutes > 0 && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                        {metrics.failedRequests != null && (
                          <span style={{ color: metrics.failedRequests.total > 0 ? '#f85149' : '#3fb950' }}>
                            {(metrics.failedRequests.total / spanMinutes).toFixed(1)}
                          </span>
                        )}
                        {metrics.failedRequests != null && <span style={{ color: '#484f58' }}>/</span>}
                        <span style={{ color: '#58a6ff' }}>{(metrics.requests.total / spanMinutes).toFixed(1)} rpm</span>
                      </span>
                    )}
                  </td>
                  <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      {metrics.failedRequests != null && (
                        <span style={{ color: metrics.failedRequests.total > 0 ? '#f85149' : '#3fb950' }}>
                          {metrics.failedRequests.total.toLocaleString()}
                        </span>
                      )}
                      {metrics.failedRequests != null && <span style={{ color: '#484f58' }}>/</span>}
                      <span style={{ color: '#58a6ff' }}>{metrics.requests.total.toLocaleString()}</span>
                    </span>
                  </td>
                </tr>
                {requestsExpanded && (
                  <tr>
                    <td colSpan={3} className="pb-1">
                      {!metrics.requestInsights
                        ? <span className="text-[10px] text-muted-foreground italic">Requires App Insights Application ID in settings</span>
                        : metrics.requestInsights.error
                          ? <span className="text-[10px] text-destructive">{metrics.requestInsights.error}</span>
                          : (
                            <div className="flex flex-col gap-1 pt-1">
                              {/* Tab buttons */}
                              <div className="flex gap-0.5 flex-wrap">
                                {(['requests', 'highfreq', 'failed', 'deps'] as const).map(t => {
                                  const labels: Record<string, string> = { requests: 'Requests', highfreq: 'High Freq', failed: 'Failed', deps: 'Dep Failures' };
                                  return (
                                    <button
                                      key={t}
                                      onClick={() => setRequestsTab(t)}
                                      style={{
                                        background: requestsTab === t ? '#58a6ff22' : 'none',
                                        border: `1px solid ${requestsTab === t ? '#58a6ff66' : 'transparent'}`,
                                        color: requestsTab === t ? '#58a6ff' : 'var(--muted-foreground)',
                                        borderRadius: 4,
                                        padding: '1px 6px',
                                        fontSize: 9,
                                        cursor: 'pointer',
                                        fontWeight: requestsTab === t ? 600 : 400,
                                      }}
                                    >
                                      {labels[t]}
                                    </button>
                                  );
                                })}
                              </div>

                              {/* Requests tab */}
                              {requestsTab === 'requests' && (
                                !Array.isArray(metrics.requestInsights.urls) || metrics.requestInsights.urls.length === 0
                                  ? <span className="text-[10px] text-muted-foreground italic">No request data</span>
                                  : <div className="flex flex-col gap-0.5">
                                    {metrics.requestInsights.urls.map((u, i) => (
                                      <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                        <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={u.url}>{u.url}</span>
                                        <span className="flex-shrink-0 tabular-nums" style={{ color: '#58a6ff' }}>{u.rpm} rpm</span>
                                        <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{u.count.toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                              )}

                              {/* High Frequency tab */}
                              {requestsTab === 'highfreq' && (
                                !Array.isArray(metrics.requestInsights.highFreq) || metrics.requestInsights.highFreq.length === 0
                                  ? <span className="text-[10px] text-muted-foreground italic">No high-frequency traffic detected</span>
                                  : <div className="flex flex-col gap-0.5">
                                    {metrics.requestInsights.highFreq.map((u, i) => {
                                      const fmtSgt = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                                      const start = new Date(u.timestamp);
                                      const end = new Date(start.getTime() + 10 * 60 * 1000);
                                      const isDowntime = downtimeIntervals.some(iv => start.getTime() < iv.end && end.getTime() > iv.start);
                                      const textColor = isDowntime ? '#c0392b' : undefined;
                                      return (
                                        <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                          <div className="flex flex-col min-w-0 flex-1">
                                            <span className="truncate" style={{ color: textColor ?? 'var(--muted-foreground)' }}>{u.ip || '(unknown)'}{u.country ? ` - ${u.country}` : ''} · {fmtSgt(start)} → {fmtSgt(end)} SGT</span>
                                            <span className="truncate opacity-70" style={{ color: textColor ?? 'var(--muted-foreground)' }}>{u.userAgent || '(unknown)'}</span>
                                          </div>
                                          <span style={{ color: isDowntime ? '#c0392b' : '#58a6ff' }} className="flex-shrink-0">{u.rpm} rpm</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                              )}

                              {/* Failed Requests tab */}
                              {requestsTab === 'failed' && (
                                !Array.isArray(metrics.requestInsights.failedUrls) || metrics.requestInsights.failedUrls.length === 0
                                  ? <span className="text-[10px] text-muted-foreground italic">No failed request data</span>
                                  : <div className="flex flex-col gap-0.5">
                                    {metrics.requestInsights.failedUrls.map((u, i) => (
                                      <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                        <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={u.url}>{u.url}</span>
                                        <span className="flex-shrink-0 tabular-nums" style={{ color: '#f85149' }}>{u.rpm} rpm</span>
                                        <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{u.count.toLocaleString()}</span>
                                      </div>
                                    ))}
                                  </div>
                              )}

                              {/* Dependency Failures tab */}
                              {requestsTab === 'deps' && (() => {
                                const deps = metrics.failedDependencies;
                                if (!deps?.length) return <span className="text-[10px] text-muted-foreground italic">No dependency failure data</span>;
                                const grouped = new Map<string, { name: string; type: string; count: number; totalDur: number; times: number }>();
                                for (const d of deps) {
                                  const k = d.name + '||' + d.type;
                                  const prev = grouped.get(k);
                                  if (!prev) grouped.set(k, { name: d.name, type: d.type, count: d.failCount, totalDur: d.avgDuration, times: 1 });
                                  else { prev.count += d.failCount; prev.totalDur += d.avgDuration; prev.times++; }
                                }
                                const list = Array.from(grouped.values()).sort((a, b) => b.count - a.count).slice(0, 10);
                                return (
                                  <div className="flex flex-col gap-0.5">
                                    {list.map((d, i) => {
                                      const ms = d.totalDur / d.times;
                                      const dur = ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
                                      return (
                                        <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                          <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={d.name}>{d.name}</span>
                                          <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{d.type}</span>
                                          <span className="flex-shrink-0 tabular-nums" style={{ color: '#f85149' }}>{d.count.toLocaleString()} fails</span>
                                          <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{dur}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>
                          )
                      }
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
        </div>
        )}


        {false && (
          <div className="rounded-md border border-border overflow-hidden">
            <div>
                {(urLoading || incidentDetailLoading) && <div style={{ padding: '6px 10px', fontSize: 10, color: '#8b9ab3' }}>{urLoading ? 'Loading monitors…' : 'Loading…'}</div>}
                {urError && <div style={{ padding: '6px 10px', fontSize: 10, color: 'hsl(var(--destructive))' }}>{urError}</div>}
                {!urLoading && urMonitors.length === 0 && !urError && (
                  <div style={{ padding: '6px 10px', fontSize: 10, color: '#8b9ab3', fontStyle: 'italic' }}>No monitors found</div>
                )}
                {(() => {
                  const muted = '#8b9ab3';
                  // Use PT1M dataset for incident rows to avoid coarse-interval data gaps
                  const iMet = incidentDetailMetrics ?? metrics;
                  const cpuSeries = iMet.cpu.series;
                  const memSeries = iMet.memory.series;
                  const reqSeries = iMet.requestsSeries ?? [];
                  const failSeries: Array<{ t: string; count: number }> = (() => {
                    const m = new Map<string, number>();
                    for (const s of [...(iMet.failedRequestsSeries ?? []), ...(iMet.http4xxSeries ?? [])]) {
                      m.set(s.t, (m.get(s.t) ?? 0) + s.count);
                    }
                    return Array.from(m.entries()).map(([t, count]) => ({ t, count }));
                  })();
                  function maxInRangeUr(series: Array<{ t: string; v: number }>, start: number, end: number) {
                    const vals = series.filter(s => { const t = new Date(s.t).getTime(); return t >= start && t <= end; }).map(s => s.v);
                    return vals.length ? Math.max(...vals) : null;
                  }
                  // For coarse-granularity data (e.g. PT15M), a short incident may contain no data points.
                  // Look back up to 1 hour before ivStart to catch the bucket that covers the incident.
                  function maxDuringUr(series: Array<{ t: string; v: number }>, ivStart: number, ivEnd: number) {
                    const strict = maxInRangeUr(series, ivStart, ivEnd);
                    if (strict !== null) return strict;
                    const BUCKET_BACK = 60 * 60 * 1000;
                    return maxInRangeUr(series, ivStart - BUCKET_BACK, ivEnd);
                  }
                  function sumInRangeUr(series: Array<{ t: string; count: number }>, start: number, end: number) {
                    return series.filter(s => { const t = new Date(s.t).getTime(); return t >= start && t <= end; }).reduce((acc, s) => acc + s.count, 0);
                  }
                  function sumDuringUr(series: Array<{ t: string; count: number }>, ivStart: number, ivEnd: number) {
                    const strict = sumInRangeUr(series, ivStart, ivEnd);
                    if (strict > 0) return strict;
                    const BUCKET_BACK = 60 * 60 * 1000;
                    return sumInRangeUr(series, ivStart - BUCKET_BACK, ivEnd);
                  }
                  function instSnapsInRange(start: number, end: number) {
                    return (iMet.instanceHealthSeries ?? []).map(inst => {
                      const pts = inst.series.filter(s => { const t = new Date(s.t).getTime(); return t >= start && t <= end; });
                      const avg = pts.length ? Math.round(pts.reduce((a, s) => a + s.v, 0) / pts.length * 10) / 10 : null;
                      const min = pts.length ? Math.min(...pts.map(s => s.v)) : null;
                      return { name: inst.name, avg, min };
                    }).filter(s => s.avg != null);
                  }
                  // Flatten all down logs, sort by start time asc for merging
                  const rawLogs = urMonitors.flatMap(mon =>
                    (mon.logs ?? []).filter(l => l.type === 1).map(log => ({ log, mon }))
                  ).sort((a, b) => a.log.datetime - b.log.datetime);

                  if (rawLogs.length === 0 && urMonitors.length > 0 && !incidentDetailLoading) {
                    return <div style={{ padding: '5px 10px', fontSize: 10, color: muted, fontStyle: 'italic' }}>No downtime recorded</div>;
                  }

                  // All down logs — each shown individually, sorted desc
                  type FlatIncident = { ivStart: number; ivEnd: number; url: string; reason: string };
                  const flat: FlatIncident[] = rawLogs.map(({ log, mon }) => ({
                    ivStart: log.datetime * 1000,
                    ivEnd:   (log.datetime + log.duration) * 1000,
                    url:     mon.url || mon.friendly_name,
                    reason:  log.reason?.detail ?? '',
                  })).sort((a, b) => b.ivStart - a.ivStart);

                  // Group by date in SGT
                  const byDate = new Map<string, FlatIncident[]>();
                  flat.forEach(inc => {
                    const dateKey = new Date(inc.ivStart).toLocaleDateString('en-GB', { ...SGT, day: '2-digit', month: 'short', year: 'numeric' });
                    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
                    byDate.get(dateKey)!.push(inc);
                  });

                  return Array.from(byDate.entries()).map(([dateKey, incidents]) => (
                    <div key={dateKey} className="scrollable-content" style={{ maxHeight: 200, overflowY: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                        <thead>
                          <tr>
                            <td colSpan={16} style={{ padding: '3px 10px', fontSize: 9, fontWeight: 700, color: '#484f58', borderBottom: '1px solid rgba(255,255,255,0.04)', borderTop: '1px solid rgba(255,255,255,0.04)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                              {dateKey}
                            </td>
                          </tr>
                          <tr style={{ color: '#484f58', fontWeight: 700 }}>
                            <td rowSpan={2} style={{ padding: '3px 10px', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>Time (SGT)</td>
                            <td rowSpan={2} style={{ padding: '3px 6px', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>Dur</td>
                            <td rowSpan={2} style={{ padding: '3px 6px', verticalAlign: 'bottom' }}>Cause</td>
                            <td rowSpan={2} style={{ padding: '3px 6px', verticalAlign: 'bottom' }}>Monitored</td>
                            <td colSpan={4} style={{ padding: '2px 6px', textAlign: 'center', color: '#484f58', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>Before (5min)</td>
                            <td colSpan={4} style={{ padding: '2px 6px', textAlign: 'center', color: '#8b9ab3', borderBottom: '1px solid rgba(255,255,255,0.04)', borderLeft: '1px solid rgba(255,255,255,0.06)', borderRight: '1px solid rgba(255,255,255,0.06)' }}>During</td>
                            <td colSpan={4} style={{ padding: '2px 6px', textAlign: 'center', color: '#484f58', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>After (5min)</td>
                          </tr>
                          <tr style={{ color: '#484f58', fontWeight: 700 }}>
                            <td style={{ padding: '2px 6px' }}>Instances</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>Req</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>CPU</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>Mem</td>
                            <td style={{ padding: '2px 6px', borderLeft: '1px solid rgba(255,255,255,0.06)' }}>Instances</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>Req</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>CPU</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right', borderRight: '1px solid rgba(255,255,255,0.06)' }}>Mem</td>
                            <td style={{ padding: '2px 6px' }}>Instances</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>Req</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>CPU</td>
                            <td style={{ padding: '2px 6px', textAlign: 'right' }}>Mem</td>
                          </tr>
                        </thead>
                        <tbody>
                      {incidents.map((inc, i) => {
                            const { ivStart, ivEnd, url, reason } = inc;
                            const reasons = reason ? [reason] : [];
                            const urls = [url];
                            const logKey = `${dateKey}-${i}`;
                            const durSecs = Math.round((ivEnd - ivStart) / 1000);
                            const dur = durSecs >= 3600
                              ? `${Math.floor(durSecs / 3600)}h ${Math.floor((durSecs % 3600) / 60)}m ${durSecs % 60}s`
                              : durSecs >= 60
                              ? `${Math.floor(durSecs / 60)}m ${durSecs % 60}s`
                              : `${durSecs}s`;
                            const startLabel = new Date(ivStart).toLocaleString('en-GB', { ...SGT, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            const endLabel   = new Date(ivEnd).toLocaleString('en-GB', { ...SGT, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                            const PRE = 5 * 60 * 1000;
                            const PRE_END = ivStart - 60 * 1000; // before window ends 1min before incident
                            const cpuBefore  = maxInRangeUr(cpuSeries, ivStart - PRE, PRE_END);
                            const cpuDuring  = maxDuringUr(cpuSeries, ivStart, ivEnd) ?? iMet.cpu.avg;
                            const cpuAfter   = maxInRangeUr(cpuSeries, ivEnd, ivEnd + PRE);
                            const memBefore  = maxInRangeUr(memSeries, ivStart - PRE, PRE_END);
                            const memDuring  = maxDuringUr(memSeries, ivStart, ivEnd) ?? (iMet.memUnit !== 'MB' ? iMet.memory.avg : null);
                            const memAfter   = maxInRangeUr(memSeries, ivEnd, ivEnd + PRE);
                            const reqBefore  = sumInRangeUr(reqSeries,  ivStart - PRE, PRE_END);
                            const reqDuring  = sumDuringUr(reqSeries,  ivStart, ivEnd);
                            const reqAfter   = sumInRangeUr(reqSeries,  ivEnd, ivEnd + PRE);
                            const failBefore = sumInRangeUr(failSeries, ivStart - PRE, PRE_END);
                            const failDuring = sumDuringUr(failSeries, ivStart, ivEnd);
                            const failAfter  = sumInRangeUr(failSeries, ivEnd, ivEnd + PRE);
                            const failSum = failDuring;
                            const cpuColor = cpuDuring > 90 ? 'hsl(var(--destructive))' : cpuDuring > 70 ? '#d29922' : muted;
                            const memColor = memDuring == null ? muted : memDuring > 95 ? 'hsl(var(--destructive))' : memDuring > 80 ? '#d29922' : muted;

                            // Classify cause using Azure metrics
                            const urCause = (() => {
                              if (failSum === 0) return null;
                              const availPts = (iMet.availability?.series ?? []).filter(s => { const t = new Date(s.t).getTime(); return t >= ivStart && t <= ivEnd; });
                              const availAvg = availPts.length ? availPts.reduce((a, s) => a + s.v, 0) / availPts.length : null;
                              if (availAvg !== null && availAvg >= 100) return null;
                              const instHealthVals = (iMet.instanceHealthSeries ?? []).map(inst => {
                                const pts = inst.series.filter(s => { const t = new Date(s.t).getTime(); return t >= ivStart && t <= ivEnd; });
                                return pts.length ? pts.reduce((a, s) => a + s.v, 0) / pts.length : null;
                              }).filter((v): v is number => v !== null);
                              if (instHealthVals.length === 0) return 'outage';
                              const total = instHealthVals.length;
                              const affected = instHealthVals.filter(v => v < 50).length;
                              if (affected === 0) return 'dependency_failure';
                              if (affected < total) return 'instance_crash';
                              return 'full_outage';
                            })();
                            const urCauseColor = CAUSE_COLOR[urCause ?? ''] ?? muted;

                            const instBefore = instSnapsInRange(ivStart - PRE, PRE_END);
                            const instDuring = instSnapsInRange(ivStart, ivEnd);
                            const instAfter  = instSnapsInRange(ivEnd, ivEnd + PRE);
                            const openPopup = () => {
                              const instSeries = iMet.instanceHealthSeries ?? [];
                              const filteredCpu = cpuSeries.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart - PRE && t <= ivEnd + PRE; });
                              const filteredMem = memSeries.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart - PRE && t <= ivEnd + PRE; });
                              const filteredInst = instSeries.map(inst => ({
                                name: inst.name,
                                series: inst.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart - PRE && t <= ivEnd + PRE; }),
                              }));
                              const cpuVals = filteredCpu.map(p => p.v);
                              const memVals = filteredMem.map(p => p.v);
                              const cpuMetric: MetricSeries = {
                                avg: cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length * 10) / 10 : 0,
                                max: cpuVals.length ? Math.max(...cpuVals) : 0,
                                series: filteredCpu,
                              };
                              const memMetric: MetricSeries = {
                                avg: memVals.length ? Math.round(memVals.reduce((a, b) => a + b, 0) / memVals.length * 10) / 10 : 0,
                                max: memVals.length ? Math.max(...memVals) : 0,
                                series: filteredMem,
                              };
                              setSelectedIncident({ date: dateKey, timeRange: `${startLabel} → ${endLabel}`, dur, reasons, causeLabel: urCause ? (CAUSE_LABEL[urCause] ?? null) : null, causeColor: urCauseColor, cpu: cpuMetric, memory: memMetric, instanceHealthSeries: filteredInst, ivStart, ivEnd });
                              setPopupChartData(null);
                              setDetectorData(null);
                              setTimelineOpen(false);
                              setHighFreqOpen(false);
                              setDepsOpen(false);
                              setInstOpen(false);
                              setProbesOpen(false);
                              setTrafficOpen(false);
                              setPopupChartLoading(true);
                              window.electronAPI.azureMetrics.fetch({
                                appKeys: [appKey],
                                range: 'custom',
                                config: azureSettings,
                                customStart: new Date(ivStart - PRE).toISOString(),
                                customEnd: new Date(ivEnd).toISOString(),
                                granularity: 'PT1M',
                              }).then(data => {
                                const m = data[appKey];
                                if (m) setPopupChartData({
                                  cpu: m.cpu, memory: m.memory,
                                  instanceHealthSeries: m.instanceHealthSeries ?? [],
                                  failedDependencies: m.failedDependencies ?? null,
                                  instanceProbeSeries: m.instanceProbeSeries ?? null,
                                  highFreq: m.requestInsights?.highFreq ?? null,
                                  requestsSeries: m.requestsSeries ?? null,
                                  failedRequestsSeries: m.failedRequestsSeries ?? null,
                                  http4xxSeries: m.http4xxSeries ?? null,
                                  responseTime: m.responseTime ? { avg: m.responseTime.avg, max: m.responseTime.max } : null,
                                  requests: m.requests ?? null,
                                  failedRequests: m.failedRequests ?? null,
                                  requestInsights: m.requestInsights ?? null,
                                });
                              }).catch(() => {}).finally(() => setPopupChartLoading(false));
                              const aiAppId2 = (azureSettings as any)?.apps?.find((a: any) => a.name === appKey)?.appInsightsAppId ?? null;
                              if (metrics.appInsightsConfigured && aiAppId2) {
                                setDetectorLoading(true);
                                window.electronAPI.azureMetrics.fetchDetectors({ appInsightsAppId: aiAppId2, startIso: new Date(ivStart - PRE).toISOString(), endIso: new Date(ivEnd).toISOString() })
                                  .then(r => setDetectorData(r))
                                  .catch((e: Error) => setDetectorData({ categories: [], error: e.message }))
                                  .finally(() => setDetectorLoading(false));
                              }
                            };
                            return (
                              <tr key={logKey} onClick={openPopup} style={{ cursor: 'pointer', borderTop: '1px solid rgba(255,255,255,0.04)' }}
                                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)') }
                                onMouseLeave={e => (e.currentTarget.style.background = 'transparent') }>
                                <td style={{ padding: '4px 10px', color: muted, whiteSpace: 'nowrap' }}>{startLabel} → {endLabel}</td>
                                <td style={{ padding: '4px 6px', color: '#d29922', whiteSpace: 'nowrap' }}>{dur}</td>
                                <td style={{ padding: '4px 6px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {urCause
                                    ? <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.04em', padding: '1px 4px', borderRadius: 3, background: `${urCauseColor}22`, border: `1px solid ${urCauseColor}55`, color: urCauseColor, whiteSpace: 'nowrap' }}>
                                        {CAUSE_LABEL[urCause]}
                                      </span>
                                    : reasons.length > 0
                                      ? <span style={{ color: muted }}>{reasons.join(' · ')}</span>
                                      : <span style={{ color: '#484f58' }}>—</span>}
                                </td>
                                <td style={{ padding: '4px 6px', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  <span style={{ color: '#58a6ff' }}>{url}</span>
                                </td>
                                {/* Before: Inst | Req | CPU | Mem */}
                                <td style={{ padding: '4px 6px' }}>
                                  {instBefore.length === 0 ? <span style={{ color: '#484f58' }}>—</span> :
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      {instBefore.map((inst, ii) => {
                                        const lineColor = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length];
                                        return (
                                          <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
                                            <span style={{ color: lineColor, flexShrink: 0 }}>●</span>
                                            <span style={{ color: '#484f58', whiteSpace: 'nowrap' }}>{inst.avg}% / {inst.min}%</span>
                                          </div>
                                        );
                                      })}
                                    </div>}
                                </td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', color: '#484f58' }}>
                                  {reqBefore > 0 ? <><span style={{ color: failBefore > 0 ? '#d29922' : '#484f58' }}>{failBefore.toLocaleString()}</span><span> / </span><span>{reqBefore.toLocaleString()}</span></> : '—'}
                                </td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{cpuBefore != null ? `${cpuBefore.toFixed(1)}%` : '—'}</td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{memBefore != null ? `${memBefore.toFixed(1)}%` : '—'}</td>
                                {/* During: Inst | Req | CPU | Mem */}
                                <td style={{ padding: '4px 6px', borderLeft: '1px solid rgba(255,255,255,0.06)' }}>
                                  {instDuring.length === 0 ? <span style={{ color: '#484f58' }}>—</span> :
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      {instDuring.map((inst, ii) => {
                                        const lineColor = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length];
                                        const hc = (inst.avg ?? 100) < 50 ? 'hsl(var(--destructive))' : (inst.avg ?? 100) < 90 ? '#d29922' : '#3fb950';
                                        return (
                                          <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
                                            <span style={{ color: lineColor, flexShrink: 0 }}>●</span>
                                            <span style={{ color: hc, whiteSpace: 'nowrap' }}>{inst.avg}% / {inst.min}%</span>
                                          </div>
                                        );
                                      })}
                                    </div>}
                                </td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                                  {reqDuring > 0 ? <><span style={{ color: failDuring > 0 ? 'hsl(var(--destructive))' : muted }}>{failDuring.toLocaleString()}</span><span style={{ color: '#484f58' }}> / </span><span style={{ color: muted }}>{reqDuring.toLocaleString()}</span></> : <span style={{ color: '#484f58' }}>—</span>}
                                </td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', color: cpuColor, whiteSpace: 'nowrap' }}>{cpuDuring.toFixed(1)}%</td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', color: memColor, whiteSpace: 'nowrap', borderRight: '1px solid rgba(255,255,255,0.06)' }}>{memDuring != null ? `${memDuring.toFixed(1)}%` : '—'}</td>
                                {/* After: Inst | Req | CPU | Mem */}
                                <td style={{ padding: '4px 6px' }}>
                                  {instAfter.length === 0 ? <span style={{ color: '#484f58' }}>—</span> :
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      {instAfter.map((inst, ii) => {
                                        const lineColor = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length];
                                        return (
                                          <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}>
                                            <span style={{ color: lineColor, flexShrink: 0 }}>●</span>
                                            <span style={{ color: '#484f58', whiteSpace: 'nowrap' }}>{inst.avg}% / {inst.min}%</span>
                                          </div>
                                        );
                                      })}
                                    </div>}
                                </td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', color: '#484f58' }}>
                                  {reqAfter > 0 ? <><span style={{ color: failAfter > 0 ? '#d29922' : '#484f58' }}>{failAfter.toLocaleString()}</span><span> / </span><span>{reqAfter.toLocaleString()}</span></> : '—'}
                                </td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{cpuAfter != null ? `${cpuAfter.toFixed(1)}%` : '—'}</td>
                                <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{memAfter != null ? `${memAfter.toFixed(1)}%` : '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ));
                })()}
              </div>
          </div>
        )}
      </div>

    </Card>
    </div>

    {selectedIncident && (
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px 16px' }}
        onClick={() => { setSelectedIncident(null); setPopupChartData(null); setDetectorData(null); setDetectorLoading(false); }}
      >
        <div
          style={{ background: '#0d1117', border: '1px solid #21262d', borderRadius: 10, padding: '0', minWidth: 480, maxWidth: 700, width: '90vw', display: 'flex', flexDirection: 'column', fontSize: 12, maxHeight: '90vh' }}
          onClick={e => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div style={{ background: '#0d1117', borderBottom: '1px solid #21262d', padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Row 1: title + actions + close */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#58a6ff', letterSpacing: '0.08em', textTransform: 'uppercase', flex: 1 }}>Incident Report</span>
              <button
                onClick={() => reportActionsRef.current?.copy()}
                disabled={popupChartLoading || detectorLoading}
                style={{ fontSize: 10, padding: '3px 10px', borderRadius: 5, border: '1px solid #30363d', background: '#161b22', color: (popupChartLoading || detectorLoading) ? '#484f58' : '#8b9ab3', cursor: (popupChartLoading || detectorLoading) ? 'not-allowed' : 'pointer', fontWeight: 600 }}
              >Copy Text</button>
              <button
                onClick={() => reportActionsRef.current?.pdf()}
                disabled={popupChartLoading || detectorLoading}
                style={{ fontSize: 10, padding: '3px 10px', borderRadius: 5, border: '1px solid #30363d', background: '#161b22', color: (popupChartLoading || detectorLoading) ? '#484f58' : '#8b9ab3', cursor: (popupChartLoading || detectorLoading) ? 'not-allowed' : 'pointer', fontWeight: 600 }}
              >Export PDF</button>
              <button onClick={() => { setSelectedIncident(null); setPopupChartData(null); setDetectorData(null); setDetectorLoading(false); reportActionsRef.current = null; }} style={{ background: 'none', border: 'none', color: '#8b9ab3', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px', flexShrink: 0 }}>✕</button>
            </div>
            {/* Row 2: date · time → time · duration · severity · type */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, color: '#8b9ab3', fontWeight: 600 }}>{selectedIncident.date}</span>
              <span style={{ color: '#30363d' }}>·</span>
              <span style={{ fontSize: 11, color: '#e6edf3', fontWeight: 700 }}>{selectedIncident.timeRange} SGT</span>
              <span style={{ color: '#30363d' }}>·</span>
              <span style={{ fontSize: 11, color: '#d29922', fontWeight: 600 }}>{selectedIncident.dur}</span>
              {(selectedIncident.causeLabel || selectedIncident.reasons.length > 0) && (<>
                <span style={{ color: '#30363d' }}>·</span>
                {selectedIncident.causeLabel
                  ? <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', padding: '2px 7px', borderRadius: 3, background: `${selectedIncident.causeColor}22`, border: `1px solid ${selectedIncident.causeColor}55`, color: selectedIncident.causeColor }}>{selectedIncident.causeLabel}</span>
                  : <span style={{ fontSize: 10, color: '#8b9ab3' }}>{selectedIncident.reasons.join(' · ')}</span>}
              </>)}
            </div>
          </div>
          <div className="table-scroll-area" style={{ padding: '0 16px 12px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', flex: 1 }}>
          {popupChartLoading && (
            <div className="animate-pulse" style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10 }}>
              <div style={{ height: 10, width: 120, borderRadius: 4, background: 'rgba(255,255,255,0.08)' }} />
              {[100, 80, 90, 75, 60, 50].map((w, i) => (
                <div key={i} style={{ display: 'flex', gap: 8 }}>
                  <div style={{ height: 9, flex: 1, borderRadius: 3, background: 'rgba(255,255,255,0.05)' }} />
                  <div style={{ height: 9, width: `${w * 0.4}px`, borderRadius: 3, background: 'rgba(255,255,255,0.05)' }} />
                  <div style={{ height: 9, width: `${w * 0.3}px`, borderRadius: 3, background: 'rgba(255,255,255,0.07)' }} />
                </div>
              ))}
              <div style={{ height: 10, width: 140, borderRadius: 4, background: 'rgba(255,255,255,0.08)', marginTop: 6 }} />
              {[90, 70, 55].map((w, i) => (
                <div key={i} style={{ height: 9, width: `${w}%`, borderRadius: 3, background: 'rgba(255,255,255,0.05)' }} />
              ))}
              <div style={{ height: 10, width: 160, borderRadius: 4, background: 'rgba(255,255,255,0.08)', marginTop: 6 }} />
              {[85, 65, 75, 50, 60].map((w, i) => (
                <div key={i} style={{ height: 9, width: `${w}%`, borderRadius: 3, background: 'rgba(255,255,255,0.05)' }} />
              ))}
            </div>
          )}
          {/* ── Metrics Snapshot ── */}
          {false && (() => {
            const si = selectedIncident; if (!si) return null;
            const chartCpu = popupChartData?.cpu ?? si.cpu;
            const chartMem = popupChartData?.memory ?? si.memory;
            const { ivStart, ivEnd } = si;
            const PRE = 5 * 60 * 1000;
            const inRange = (series: Array<{ t: string; v: number }>, s: number, e: number) =>
              series.filter(p => { const t = new Date(p.t).getTime(); return t >= s && t <= e; }).map(p => p.v);
            const inRangeC = (series: Array<{ t: string; count: number }>, s: number, e: number) =>
              series.filter(p => { const t = new Date(p.t).getTime(); return t >= s && t <= e; }).reduce((a, p) => a + p.count, 0);
            const avg = (v: number[]) => v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
            const maxV = (v: number[]) => v.length ? +Math.max(...v).toFixed(1) : null;
            const cpuBefore = inRange(chartCpu.series, ivStart - PRE, ivStart);
            const cpuDuring = inRange(chartCpu.series, ivStart, ivEnd);
            const memBefore = inRange(chartMem.series, ivStart - PRE, ivStart);
            const memDuring = inRange(chartMem.series, ivStart, ivEnd);
            const reqSeries = popupChartData?.requestsSeries ?? metrics.requestsSeries ?? [];
            const failSeries = (() => {
              const m = new Map<string, number>();
              const src = [
                ...(popupChartData?.failedRequestsSeries ?? metrics.failedRequestsSeries ?? []),
                ...(popupChartData?.http4xxSeries ?? metrics.http4xxSeries ?? []),
              ];
              for (const s of src) m.set(s.t, (m.get(s.t) ?? 0) + s.count);
              return Array.from(m.entries()).map(([t, count]) => ({ t, count }));
            })();
            const reqBefore = inRangeC(reqSeries, ivStart - PRE, ivStart);
            const reqDuring = inRangeC(reqSeries, ivStart, ivEnd);
            const failBefore = inRangeC(failSeries, ivStart - PRE, ivStart);
            const failDuring = inRangeC(failSeries, ivStart, ivEnd);
            const availPts = (metrics.availability?.series ?? []).filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
            const availDuring = availPts.length ? +(availPts.reduce((a, p) => a + p.v, 0) / availPts.length).toFixed(1) : null;
            const dim = '#484f58';
            const cpuCol = (v: number | null) => !v ? dim : v > 90 ? 'hsl(var(--destructive))' : v > 70 ? '#d29922' : '#3fb950';
            const memCol = (v: number | null) => !v ? dim : v > 95 ? 'hsl(var(--destructive))' : v > 80 ? '#d29922' : '#3fb950';
            const SRow = ({ label, before, during, bc, dc }: { label: string; before: string | null; during: string | null; bc?: string; dc?: string }) => (
              <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '3px 0', color: dim, fontSize: 10 }}>{label}</td>
                <td style={{ padding: '3px 8px', textAlign: 'right', color: bc ?? '#8b9ab3', fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>{before ?? '—'}</td>
                <td style={{ padding: '3px 0', textAlign: 'right', color: dc ?? '#e6edf3', fontSize: 10, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{during ?? '—'}</td>
              </tr>
            );
            return (
              <div style={{ marginTop: 2, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                <div style={{ fontSize: 9, fontWeight: 700, color: dim, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>Metrics Snapshot</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ color: dim }}>
                      <th style={{ textAlign: 'left', padding: '2px 0', fontWeight: 700, fontSize: 9 }} />
                      <th style={{ textAlign: 'right', padding: '2px 8px', fontWeight: 700, fontSize: 9 }}>Before (5m)</th>
                      <th style={{ textAlign: 'right', padding: '2px 0', fontWeight: 700, fontSize: 9, color: '#8b9ab3' }}>During</th>
                    </tr>
                  </thead>
                  <tbody>
                    <SRow label="CPU avg" before={avg(cpuBefore) != null ? `${avg(cpuBefore)}%` : null} during={avg(cpuDuring) != null ? `${avg(cpuDuring)}%` : null} bc={dim} dc={cpuCol(avg(cpuDuring))} />
                    <SRow label="CPU max" before={maxV(cpuBefore) != null ? `${maxV(cpuBefore)}%` : null} during={maxV(cpuDuring) != null ? `${maxV(cpuDuring)}%` : null} bc={dim} dc={cpuCol(maxV(cpuDuring))} />
                    <SRow label="Mem avg" before={avg(memBefore) != null ? `${avg(memBefore)}%` : null} during={avg(memDuring) != null ? `${avg(memDuring)}%` : null} bc={dim} dc={memCol(avg(memDuring))} />
                    <SRow label="Mem max" before={maxV(memBefore) != null ? `${maxV(memBefore)}%` : null} during={maxV(memDuring) != null ? `${maxV(memDuring)}%` : null} bc={dim} dc={memCol(maxV(memDuring))} />
                    {(reqBefore > 0 || reqDuring > 0) && <SRow label="Requests" before={reqBefore > 0 ? reqBefore.toLocaleString() : '0'} during={reqDuring > 0 ? reqDuring.toLocaleString() : '0'} bc={dim} dc='#58a6ff' />}
                    {(failBefore > 0 || failDuring > 0) && <SRow label="Failed req" before={failBefore.toLocaleString()} during={failDuring.toLocaleString()} bc={failBefore > 0 ? '#d29922' : dim} dc={failDuring === 0 ? '#3fb950' : failDuring / (reqDuring || 1) > 0.1 ? 'hsl(var(--destructive))' : '#d29922'} />}
                    {availDuring != null && <SRow label="Availability" before={null} during={`${availDuring}%`} dc={availDuring! >= 99 ? '#3fb950' : availDuring! >= 95 ? '#d29922' : 'hsl(var(--destructive))'} />}
                    {(popupChartData?.responseTime ?? metrics.responseTime) != null && (() => {
                      const rt = popupChartData?.responseTime ?? metrics.responseTime!;
                      return <SRow label="Response time" before={null} during={`avg ${rt.avg}s · max ${rt.max}s`} dc='#58a6ff' />;
                    })()}
                  </tbody>
                </table>
              </div>
            );
          })()}

          {/* ── Failed Dependencies ── */}
          {false && (() => {
            const deps = popupChartData?.failedDependencies ?? metrics.failedDependencies;
            if (!deps?.length) return null;
            const grouped = new Map<string, { name: string; type: string; target: string; count: number; totalDur: number; times: number }>();
            for (const d of deps) {
              const k = d.name + '||' + d.type;
              const prev = grouped.get(k);
              if (!prev) grouped.set(k, { name: d.name, type: d.type, target: d.target, count: d.failCount, totalDur: d.avgDuration, times: 1 });
              else { prev.count += d.failCount; prev.totalDur += d.avgDuration; prev.times++; }
            }
            const list = Array.from(grouped.values()).sort((a, b) => b.count - a.count);
            return (
              <div style={{ marginTop: 2, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                <button onClick={() => setDepsOpen(v => !v)} style={{ width: '100%', background: 'none', border: 'none', padding: '2px 0 4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#a371f7', letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1, textAlign: 'left' }}>
                    Failed Dependencies ({list.length})
                  </span>
                  <span style={{ fontSize: 9, color: '#484f58' }}>{depsOpen ? '▲' : '▼'}</span>
                </button>
                {depsOpen && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                    <thead>
                      <tr style={{ color: '#484f58', fontWeight: 700, fontSize: 9 }}>
                        <th style={{ textAlign: 'left', padding: '2px 0' }}>Name</th>
                        <th style={{ textAlign: 'left', padding: '2px 8px' }}>Type</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>Fails</th>
                        <th style={{ textAlign: 'right', padding: '2px 0' }}>Avg dur</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((d, i) => (
                        <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '3px 0', color: '#8b9ab3', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</td>
                          <td style={{ padding: '3px 8px', color: '#484f58', whiteSpace: 'nowrap' }}>{d.type}</td>
                          <td style={{ padding: '3px 8px', textAlign: 'right', color: 'hsl(var(--destructive))', fontVariantNumeric: 'tabular-nums' }}>{d.count}</td>
                          <td style={{ padding: '3px 0', textAlign: 'right', color: '#484f58', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{(() => { const ms = d.totalDur / d.times; return ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`; })()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()}

          {/* ── Instance Health ── */}
          {false && (() => {
            const instSeries = popupChartData?.instanceHealthSeries ?? selectedIncident.instanceHealthSeries;
            if (instSeries.length === 0) return null;
            const { ivStart, ivEnd } = selectedIncident;
            const PRE = 5 * 60 * 1000;
            const instStats = instSeries.map((inst, i) => {
              const vals = (range: [number, number]) => inst.series.filter(p => { const t = new Date(p.t).getTime(); return t >= range[0] && t <= range[1]; }).map(p => p.v);
              const avg = (v: number[]) => v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
              const minV = (v: number[]) => v.length ? +Math.min(...v).toFixed(1) : null;
              const before = vals([ivStart - PRE, ivStart]);
              const during = vals([ivStart, ivEnd]);
              const shortName = inst.name.split('_').slice(-2).join('_') || inst.name;
              return { name: inst.name, shortName, beforeAvg: avg(before), duringAvg: avg(during), duringMin: minV(during), color: INSTANCE_PALETTE[i % INSTANCE_PALETTE.length] ?? '#8b9ab3' };
            });
            const hCol = (v: number | null) => !v ? '#484f58' : v < 50 ? 'hsl(var(--destructive))' : v < 90 ? '#d29922' : '#3fb950';
            return (
              <div style={{ marginTop: 2, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                <button onClick={() => setInstOpen(v => !v)} style={{ width: '100%', background: 'none', border: 'none', padding: '2px 0 4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#484f58', letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1, textAlign: 'left' }}>
                    Instance Health ({instStats.length})
                  </span>
                  <span style={{ fontSize: 9, color: '#484f58' }}>{instOpen ? '▲' : '▼'}</span>
                </button>
                {instOpen && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                    <thead>
                      <tr style={{ color: '#484f58', fontWeight: 700, fontSize: 9 }}>
                        <th style={{ textAlign: 'left', padding: '2px 0' }}>Instance</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>Before avg</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>During avg</th>
                        <th style={{ textAlign: 'right', padding: '2px 0' }}>During min</th>
                      </tr>
                    </thead>
                    <tbody>
                      {instStats.map((inst, i) => (
                        <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '3px 0', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inst.name}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <span style={{ color: inst.color, fontSize: 8 }}>●</span>
                              <span style={{ color: '#8b9ab3' }}>{inst.shortName}</span>
                            </span>
                          </td>
                          <td style={{ padding: '3px 8px', textAlign: 'right', color: '#484f58', fontVariantNumeric: 'tabular-nums' }}>{inst.beforeAvg != null ? `${inst.beforeAvg}%` : '—'}</td>
                          <td style={{ padding: '3px 8px', textAlign: 'right', color: hCol(inst.duringAvg), fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{inst.duringAvg != null ? `${inst.duringAvg}%` : '—'}</td>
                          <td style={{ padding: '3px 0', textAlign: 'right', color: hCol(inst.duringMin), fontVariantNumeric: 'tabular-nums' }}>{inst.duringMin != null ? `${inst.duringMin}%` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()}

          {/* ── Health Probes ── */}
          {false && (() => {
            const probes = popupChartData?.instanceProbeSeries ?? metrics.instanceProbeSeries;
            if (!probes?.length) return null;
            const { ivStart, ivEnd } = selectedIncident;
            const probeStats = probes.map((inst, i) => {
              const during = inst.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
              const failures = during.filter(p => p.v < 100).length;
              const minV = during.length ? +Math.min(...during.map(p => p.v)).toFixed(1) : null;
              const avgV = during.length ? +(during.reduce((a, p) => a + p.v, 0) / during.length).toFixed(1) : null;
              const shortName = inst.name.split('_').slice(-2).join('_') || inst.name;
              return { name: inst.name, shortName, failures, total: during.length, minV, avgV, color: INSTANCE_PALETTE[i % INSTANCE_PALETTE.length] ?? '#8b9ab3' };
            }).filter(p => p.failures > 0 || p.minV != null);
            if (probeStats.length === 0) return null;
            return (
              <div style={{ marginTop: 2, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                <button onClick={() => setProbesOpen(v => !v)} style={{ width: '100%', background: 'none', border: 'none', padding: '2px 0 4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: probeStats.some(p => p.failures > 0) ? '#f85149' : '#484f58', letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1, textAlign: 'left' }}>
                    Health Probes ({probeStats.length} instances{probeStats.some(p => p.failures > 0) ? ` · ${probeStats.reduce((a, p) => a + p.failures, 0)} failures` : ''})
                  </span>
                  <span style={{ fontSize: 9, color: '#484f58' }}>{probesOpen ? '▲' : '▼'}</span>
                </button>
                {probesOpen && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                    <thead>
                      <tr style={{ color: '#484f58', fontWeight: 700, fontSize: 9 }}>
                        <th style={{ textAlign: 'left', padding: '2px 0' }}>Instance</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>Failures</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>Probe avg</th>
                        <th style={{ textAlign: 'right', padding: '2px 0' }}>Probe min</th>
                      </tr>
                    </thead>
                    <tbody>
                      {probeStats.map((p, i) => {
                        const fc = p.failures > 0 ? 'hsl(var(--destructive))' : '#3fb950';
                        const vc = (v: number | null) => !v ? '#484f58' : v < 50 ? 'hsl(var(--destructive))' : v < 100 ? '#d29922' : '#3fb950';
                        return (
                          <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '3px 0', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.name}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ color: p.color, fontSize: 8 }}>●</span>
                                <span style={{ color: '#8b9ab3' }}>{p.shortName}</span>
                              </span>
                            </td>
                            <td style={{ padding: '3px 8px', textAlign: 'right', color: fc, fontVariantNumeric: 'tabular-nums' }}>{p.failures} / {p.total}</td>
                            <td style={{ padding: '3px 8px', textAlign: 'right', color: vc(p.avgV), fontVariantNumeric: 'tabular-nums' }}>{p.avgV != null ? `${p.avgV}%` : '—'}</td>
                            <td style={{ padding: '3px 0', textAlign: 'right', color: vc(p.minV), fontVariantNumeric: 'tabular-nums', fontWeight: p.failures > 0 ? 700 : 400 }}>{p.minV != null ? `${p.minV}%` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()}

          {/* ── Traffic (URLs) ── */}
          {false && (() => {
            const ri = popupChartData?.requestInsights;
            if (!ri) return null;
            const topUrls = ri.urls ?? [];
            const failedUrls = ri.failedUrls ?? [];
            if (topUrls.length === 0 && failedUrls.length === 0) return null;
            return (
              <div style={{ marginTop: 2, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                <button onClick={() => setTrafficOpen(v => !v)} style={{ width: '100%', background: 'none', border: 'none', padding: '2px 0 4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#58a6ff', letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1, textAlign: 'left' }}>
                    Traffic During Incident
                  </span>
                  <span style={{ fontSize: 9, color: '#484f58' }}>{trafficOpen ? '▲' : '▼'}</span>
                </button>
                {trafficOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 2 }}>
                    {topUrls.length > 0 && (
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, color: '#484f58', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 3 }}>Top Requests</div>
                        {topUrls.map((u, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)', padding: '2px 0' }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8b9ab3' }} title={u.url}>{u.url}</span>
                            <span style={{ flexShrink: 0, color: '#58a6ff', fontVariantNumeric: 'tabular-nums' }}>{u.rpm} rpm</span>
                            <span style={{ flexShrink: 0, color: '#484f58', fontVariantNumeric: 'tabular-nums' }}>{u.count.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {failedUrls.length > 0 && (
                      <div>
                        <div style={{ fontSize: 9, fontWeight: 700, color: '#484f58', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 3 }}>Failed Endpoints</div>
                        {failedUrls.map((u, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)', padding: '2px 0' }}>
                            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#8b9ab3' }} title={u.url}>{u.url}</span>
                            <span style={{ flexShrink: 0, color: '#f85149', fontVariantNumeric: 'tabular-nums' }}>{u.rpm} rpm</span>
                            <span style={{ flexShrink: 0, color: '#484f58', fontVariantNumeric: 'tabular-nums' }}>{u.count.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {false && (() => {
            const hfSource: Array<{ timestamp: string; ip: string; country: string; userAgent: string; count: number; rpm: number }> =
              (metrics.requestInsights?.highFreq ?? popupChartData?.highFreq ?? []) as Array<{ timestamp: string; ip: string; country: string; userAgent: string; count: number; rpm: number }>;
            const preIncidentHf = hfSource
              .filter(h => new Date(h.timestamp).getTime() < selectedIncident.ivStart)
              .sort((a, b) => b.rpm - a.rpm)
              .slice(0, 5);
            if (preIncidentHf.length === 0) return null;
            return (
              <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                <button
                  onClick={() => setHighFreqOpen(v => !v)}
                  style={{ width: '100%', background: 'none', border: 'none', padding: '2px 0 4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#d29922', letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1, textAlign: 'left' }}>
                    High Frequency Traffic (pre-incident · top {preIncidentHf.length})
                  </span>
                  <span style={{ fontSize: 9, color: '#484f58' }}>{highFreqOpen ? '▲' : '▼'}</span>
                </button>
                {highFreqOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', marginTop: 4 }}>
                    {preIncidentHf.map((h, i) => {
                      const tStart = new Date(h.timestamp);
                      const tEnd   = new Date(tStart.getTime() + 10 * 60 * 1000);
                      const fmtSgt = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '5px 0', borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, color: '#e6edf3', fontWeight: 600 }}>
                              {h.ip || '(unknown)'}{h.country ? ` - ${h.country}` : ''} · {fmtSgt(tStart)} → {fmtSgt(tEnd)} SGT
                            </div>
                            <div style={{ fontSize: 10, color: '#8b9ab3', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {h.userAgent || '(unknown)'}
                            </div>
                          </div>
                          <div style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: '#d29922', whiteSpace: 'nowrap' }}>
                            {h.rpm} rpm
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
          {false && (() => {
            const chartCpu   = popupChartData?.cpu   ?? selectedIncident.cpu;
            const chartMem   = popupChartData?.memory ?? selectedIncident.memory;
            const chartInst  = popupChartData?.instanceHealthSeries ?? selectedIncident.instanceHealthSeries;
            const chartDeps  = popupChartData?.failedDependencies ?? metrics.failedDependencies;
            const chartProbe = popupChartData?.instanceProbeSeries ?? metrics.instanceProbeSeries;
            const events = buildTimeline(chartCpu, chartMem, chartInst, selectedIncident.ivStart, selectedIncident.ivEnd, chartDeps, chartProbe);
            if (events.length === 0) return null;
            return (
              <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
                <button
                  onClick={() => setTimelineOpen(v => !v)}
                  style={{ width: '100%', background: 'none', border: 'none', padding: '2px 0 4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <span style={{ fontSize: 9, fontWeight: 700, color: '#484f58', letterSpacing: '0.06em', textTransform: 'uppercase', flex: 1, textAlign: 'left' }}>
                    Timeline ({events.length} events)
                  </span>
                  <span style={{ fontSize: 9, color: '#484f58' }}>{timelineOpen ? '▲' : '▼'}</span>
                </button>
                {timelineOpen && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 2 }}>
                    {events.map((ev, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 10, ...(ev.isMarker ? { borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 4, marginTop: 2 } : {}) }}>
                        <span style={{ color: '#484f58', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontSize: 9, minWidth: 60 }}>
                          {new Date(ev.t).toLocaleString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span style={{ color: ev.color, flexShrink: 0, width: 12, textAlign: 'center', fontSize: 9 }}>{ev.icon}</span>
                        <span style={{ color: ev.color }}>{ev.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {!popupChartLoading && (() => {
            const { ivStart, ivEnd, causeLabel, causeColor, dur, timeRange, date, reasons } = selectedIncident;
            const PRE = 5 * 60 * 1000;
            const sgtTime = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            const sgtFull = (ms: number) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

            const chartCpu  = popupChartData?.cpu   ?? selectedIncident.cpu;
            const chartMem  = popupChartData?.memory ?? selectedIncident.memory;
            const chartInst = (popupChartData?.instanceHealthSeries?.length ? popupChartData.instanceHealthSeries : null) ?? selectedIncident.instanceHealthSeries;
            const chartDeps = (popupChartData?.failedDependencies?.length ? popupChartData.failedDependencies : null) ?? metrics.failedDependencies;
            const chartProbe = (popupChartData?.instanceProbeSeries?.length ? popupChartData.instanceProbeSeries : null) ?? metrics.instanceProbeSeries;
            const reqSeries  = popupChartData?.requestsSeries ?? metrics.requestsSeries ?? [];
            const failSeries = (() => {
              const m = new Map<string, number>();
              for (const s of [...(popupChartData?.failedRequestsSeries ?? metrics.failedRequestsSeries ?? []), ...(popupChartData?.http4xxSeries ?? metrics.http4xxSeries ?? [])]) m.set(s.t, (m.get(s.t) ?? 0) + s.count);
              return Array.from(m.entries()).map(([t, count]) => ({ t, count }));
            })();

            const inRange  = (series: Array<{ t: string; v: number }>, s: number, e: number) => series.filter(p => { const t = new Date(p.t).getTime(); return t >= s && t <= e; }).map(p => p.v);
            const inRangeC = (series: Array<{ t: string; count: number }>, s: number, e: number) => series.filter(p => { const t = new Date(p.t).getTime(); return t >= s && t <= e; }).reduce((a, p) => a + p.count, 0);
            const avg  = (v: number[]) => v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
            const maxV = (v: number[]) => v.length ? +Math.max(...v).toFixed(1) : null;
            const minV = (v: number[]) => v.length ? +Math.min(...v).toFixed(1) : null;

            const cpuBefore = inRange(chartCpu.series, ivStart - PRE, ivStart);
            const cpuDuring = inRange(chartCpu.series, ivStart, ivEnd);
            const memBefore = inRange(chartMem.series, ivStart - PRE, ivStart);
            const memDuring = inRange(chartMem.series, ivStart, ivEnd);
            const reqBefore  = inRangeC(reqSeries,  ivStart - PRE, ivStart);
            const reqDuring  = inRangeC(reqSeries,  ivStart, ivEnd);
            const failBefore = inRangeC(failSeries, ivStart - PRE, ivStart);
            const failDuring = inRangeC(failSeries, ivStart, ivEnd);
            const availPts   = (metrics.availability?.series ?? []).filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
            const availDuring = availPts.length ? +(availPts.reduce((a, p) => a + p.v, 0) / availPts.length).toFixed(1) : null;
            const rt = popupChartData?.responseTime ?? metrics.responseTime;
            const reqSpikePct = reqBefore > 0 ? Math.round((reqDuring - reqBefore) / reqBefore * 100) : null;

            // Deps grouped
            const depMap = new Map<string, { name: string; type: string; count: number; totalDur: number; times: number }>();
            for (const d of chartDeps ?? []) {
              const k = d.name + '||' + d.type;
              const prev = depMap.get(k);
              if (!prev) depMap.set(k, { name: d.name, type: d.type, count: d.failCount, totalDur: d.avgDuration, times: 1 });
              else { prev.count += d.failCount; prev.totalDur += d.avgDuration; prev.times++; }
            }
            const deps = Array.from(depMap.values()).sort((a, b) => b.count - a.count).slice(0, 5);
            const fmtDur = (ms: number) => ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;

            // Instance health
            const instStats = chartInst.map((inst, i) => {
              const before = inRange(inst.series, ivStart - PRE, ivStart);
              const during = inRange(inst.series, ivStart, ivEnd);
              return { name: inst.name, shortName: inst.name.split('_').slice(-2).join('_') || inst.name, beforeAvg: avg(before), duringAvg: avg(during), duringMin: minV(during), color: INSTANCE_PALETTE[i % INSTANCE_PALETTE.length] ?? '#8b9ab3' };
            });

            // Probe stats
            const probeStats = (chartProbe ?? []).map((inst, i) => {
              const during = inst.series.filter(p => { const t = new Date(p.t).getTime(); return t >= ivStart && t <= ivEnd; });
              const fails  = during.filter(p => p.v < 100);
              return { name: inst.name, shortName: inst.name.split('_').slice(-2).join('_') || inst.name, failures: fails.length, total: during.length, minPct: minV(during.map(p => p.v)), avgPct: avg(during.map(p => p.v)), failTimes: fails.map(p => new Date(p.t).getTime()), color: INSTANCE_PALETTE[i % INSTANCE_PALETTE.length] ?? '#8b9ab3' };
            });

            const events = buildTimeline(chartCpu, chartMem, chartInst, ivStart, ivEnd, chartDeps, chartProbe);

            // Severity + cause detail lookup
            const causeKey = Object.keys(CAUSE_LABEL).find(k => CAUSE_LABEL[k] === causeLabel);
            const causeDetail = causeKey ? CAUSE_DETAIL[causeKey] : null;
            const severity = causeLabel === 'Full Outage' ? 'CRITICAL' : causeLabel === 'Instance Crash' ? 'HIGH' : causeLabel === 'Dependency Failure' ? 'MEDIUM' : 'UNKNOWN';
            const severityColor = severity === 'CRITICAL' ? 'hsl(var(--destructive))' : severity === 'HIGH' ? '#f0883e' : severity === 'MEDIUM' ? '#d29922' : '#484f58';

            // Plain English summary
            const plainEnglish = causeLabel === 'Instance Crash'
              ? 'One or more application instances became unhealthy while others continued serving traffic. This is consistent with an instance-level failure such as an out-of-memory condition, unhandled exception, or container restart.'
              : causeLabel === 'Full Outage'
              ? 'All application instances simultaneously lost health. This pattern is consistent with a platform-level event such as a deployment failure, infrastructure disruption, or a systemic crash affecting the entire app service plan.'
              : causeLabel === 'Dependency Failure'
              ? 'Application instances remained healthy but requests failed at an elevated rate. The failure pattern points to an external dependency becoming unavailable or timing out — likely a database, API, or service bus connection.'
              : reasons.length > 0
              ? `Uptime monitoring detected a service disruption. Reported reason: ${reasons.join('; ')}.`
              : 'A service disruption was detected by uptime monitoring. Insufficient telemetry was available to determine the specific root cause.';

            // Contributing factors
            const factors: string[] = [];
            const cpuMaxD = maxV(cpuDuring);
            const memMaxD = maxV(memDuring);
            if (cpuMaxD && cpuMaxD > 90) factors.push(`CPU exhaustion — peaked at ${cpuMaxD}%`);
            else if (cpuMaxD && cpuMaxD > 70) factors.push(`Elevated CPU — peaked at ${cpuMaxD}%`);
            if (memMaxD && memMaxD > 95) factors.push(`Critical memory pressure — peaked at ${memMaxD}%`);
            else if (memMaxD && memMaxD > 80) factors.push(`Elevated memory — peaked at ${memMaxD}%`);
            if (deps.length > 0) factors.push(`${deps.length} failed dependenc${deps.length === 1 ? 'y' : 'ies'} — ${deps.slice(0, 2).map(d => d.name.split('/').pop() ?? d.name).join(', ')}`);
            if (probeStats.some(p => p.failures > 0)) factors.push(`Health probe failures on ${probeStats.filter(p => p.failures > 0).length} instance(s)`);
            if (reqSpikePct && reqSpikePct > 50) factors.push(`Request spike — ${reqSpikePct}% above baseline`);
            const firstSig = events.find(e => !e.isMarker && e.t >= ivStart);
            const hfAll = ((popupChartData?.highFreq?.length ? popupChartData.highFreq : null) ?? (metrics.requestInsights?.highFreq?.length ? metrics.requestInsights.highFreq : null) ?? []) as Array<{ timestamp: string; lastSeen?: string; ip: string; country: string; userAgent: string; count: number; rpm: number }>;
            const preHfTop5 = hfAll.filter(h => { const t = new Date(h.timestamp).getTime(); return t >= ivStart - PRE && t <= ivEnd; }).sort((a, b) => b.rpm - a.rpm).slice(0, 5);

            // Text export
            const generateText = () => {
              const sep = () => '─'.repeat(60);
              const L: string[] = [];
              L.push(`INCIDENT REPORT — ${appKey}`);
              L.push('═'.repeat(60));
              L.push('');
              L.push('INCIDENT SUMMARY');
              L.push(sep());
              L.push(`App:            ${appKey}`);
              L.push(`Date:           ${date}`);
              L.push(`Window (SGT):   ${timeRange}`);
              L.push(`Duration:       ${dur}`);
              L.push(`Severity:       ${severity}`);
              L.push(`Classification: ${causeLabel ?? 'Unknown'}`);
              L.push('');
              L.push('1. METRICS SNAPSHOT');
              L.push(sep());
              L.push('Metric           Before (5m)    During');
              const pad = (s: string | null, w = 14) => String(s ?? '—').padEnd(w);
              L.push(`CPU avg          ${pad(`${avg(cpuBefore) ?? '—'}%`)}${avg(cpuDuring) ?? '—'}%`);
              L.push(`CPU max          ${pad(`${maxV(cpuBefore) ?? '—'}%`)}${maxV(cpuDuring) ?? '—'}%`);
              L.push(`Mem avg          ${pad(`${avg(memBefore) ?? '—'}%`)}${avg(memDuring) ?? '—'}%`);
              L.push(`Mem max          ${pad(`${maxV(memBefore) ?? '—'}%`)}${maxV(memDuring) ?? '—'}%`);
              if (reqBefore > 0 || reqDuring > 0) L.push(`Requests         ${pad(reqBefore.toLocaleString())}${reqDuring.toLocaleString()}`);
              if (failBefore > 0 || failDuring > 0) L.push(`Failed req       ${pad(failBefore.toLocaleString())}${failDuring.toLocaleString()}`);
              if (availDuring != null) L.push(`Availability     ${pad('—')}${availDuring}%`);
              if (rt) L.push(`Response time    ${pad('—')}avg ${rt.avg}s / max ${rt.max}s`);
              L.push('');
              L.push('2. ROOT CAUSE ANALYSIS');
              L.push(sep());
              L.push(`Primary:      ${(causeLabel ?? reasons.join(', ')) || 'Unknown'}`);
              if (causeDetail) L.push(`Signals:      ${causeDetail.signals}`);
              if (factors.length > 0) { L.push(''); L.push('Contributing Factors:'); factors.forEach(f => L.push(`  • ${f}`)); }
              if (firstSig) { L.push(''); L.push(`First signal: ${sgtTime(firstSig.t)} SGT — ${firstSig.label}`); }
              if (deps.length > 0) {
                L.push(''); L.push('3. DEPENDENCY FAILURES'); L.push(sep());
                deps.forEach(d => L.push(`  [${d.type}] ${d.name}  ×${d.count}  avg ${fmtDur(d.totalDur / d.times)}`));
              }
              if (instStats.length > 0) {
                L.push(''); L.push('4. INSTANCE HEALTH'); L.push(sep());
                instStats.forEach(i => L.push(`  ${i.shortName}  before ${i.beforeAvg ?? '—'}%  →  during avg ${i.duringAvg ?? '—'}% min ${i.duringMin ?? '—'}%`));
              }
              if (probeStats.some(p => p.failures > 0)) {
                L.push(''); L.push('5. HEALTH PROBES'); L.push(sep());
                L.push(`Total failures: ${probeStats.reduce((a, p) => a + p.failures, 0)}`);
                probeStats.filter(p => p.failures > 0).forEach(p => {
                  L.push(`  ${p.shortName}: ${p.failures}/${p.total} failures  min ${p.minPct ?? '—'}%  avg ${p.avgPct ?? '—'}%`);
                  p.failTimes.forEach(t => L.push(`    → ${sgtTime(t)} SGT`));
                });
              }
              const ri = popupChartData?.requestInsights;
              if (reqBefore > 0 || reqDuring > 0 || ri?.urls?.length || ri?.failedUrls?.length) {
                L.push(''); L.push('6. TRAFFIC ANALYSIS'); L.push(sep());
                if (reqBefore > 0 || reqDuring > 0) L.push(`  Requests: ${reqBefore.toLocaleString()} before → ${reqDuring.toLocaleString()} during${reqSpikePct != null ? ` (${reqSpikePct > 0 ? '+' : ''}${reqSpikePct}%)` : ''}`);
                if (failBefore > 0 || failDuring > 0) L.push(`  Failures: ${failBefore.toLocaleString()} before → ${failDuring.toLocaleString()} during`);
                if (ri?.urls?.length) { L.push('  Top Endpoints:'); ri.urls.slice(0, 5).forEach(u => L.push(`    ${u.rpm} rpm  ${u.count}  ${u.url}`)); }
                if (ri?.failedUrls?.length) { L.push('  Failed Endpoints:'); ri.failedUrls.slice(0, 5).forEach(u => L.push(`    ${u.rpm} rpm  ${u.count}  ${u.url}`)); }
                if (preHfTop5.length > 0) { L.push('  High Freq (−5min→end):'); preHfTop5.forEach(h => { const fmtTs = (iso: string) => new Date(iso).toLocaleString('en-GB', { ...SGT, hour: '2-digit', minute: '2-digit', second: '2-digit' }); const tr = h.lastSeen ? `${fmtTs(h.timestamp)} → ${fmtTs(h.lastSeen)}` : fmtTs(h.timestamp); L.push(`    ${h.ip}  ${h.country ?? ''}  ${tr}  ${h.count.toLocaleString()} reqs  ${h.rpm} rpm  UA: ${h.userAgent || '?'}`); }); }
              }
              if (events.length > 0) {
                L.push(''); L.push('7. TIMELINE'); L.push(sep());
                events.forEach(e => L.push(`  ${sgtTime(e.t)} SGT  ${e.icon}  ${e.label}`));
              }
              if (detectorData && !detectorLoading) {
                const visDetCats = detectorData.categories.filter(cat => cat.queries.some(q => q.result.rows.length > 0));
                if (visDetCats.length > 0) {
                  L.push(''); L.push('8. DETECTOR ANALYSIS'); L.push(sep());
                  for (const cat of visDetCats) {
                    L.push(`  [${cat.label}]`);
                    for (const q of cat.queries.filter(qq => qq.result.rows.length > 0)) {
                      L.push(`    ${q.name}:`);
                      if (q.result.error) {
                        L.push(`      Error: ${q.result.error}`);
                      } else {
                        for (const row of q.result.rows.slice(0, 10)) {
                          L.push(`      ${row.map(v => v == null ? '—' : String(v)).join('  ')}`);
                        }
                        if (q.result.rows.length > 10) L.push(`      … +${q.result.rows.length - 10} more`);
                      }
                    }
                  }
                }
              }
              L.push(''); L.push('─'.repeat(60));
              L.push(`Generated: ${sgtFull(Date.now())} SGT  |  DevForge`);
              return L.join('\n');
            };

            const exportPDF = () => {
              const txt = generateText().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
              const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Incident Report — ${appKey}</title><style>body{font-family:'Courier New',monospace;font-size:10px;padding:20px;white-space:pre-wrap;word-break:break-word;color:#000}@media print{body{font-size:9px;padding:10px}}</style></head><body>${txt}</body></html>`;
              const iframe = document.createElement('iframe');
              iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;border:none';
              document.body.appendChild(iframe);
              iframe.contentDocument!.open();
              iframe.contentDocument!.write(html);
              iframe.contentDocument!.close();
              iframe.contentWindow!.focus();
              iframe.contentWindow!.print();
              setTimeout(() => { try { document.body.removeChild(iframe); } catch {} }, 2000);
            };

            // Wire actions to ref so popup header can call them
            reportActionsRef.current = {
              copy: () => navigator.clipboard.writeText(generateText()),
              pdf:  exportPDF,
            };

            // Shared styles
            const dim = '#484f58', sub = '#8b9ab3';
            const cpuCol  = (v: number | null) => !v ? dim : v > 90 ? 'hsl(var(--destructive))' : v > 70 ? '#d29922' : '#3fb950';
            const memCol  = (v: number | null) => !v ? dim : v > 95 ? 'hsl(var(--destructive))' : v > 80 ? '#d29922' : '#3fb950';
            const hCol    = (v: number | null) => !v ? dim : v < 50 ? 'hsl(var(--destructive))' : v < 90 ? '#d29922' : '#3fb950';
            const SecHead = ({ n, label, color = dim }: { n: string; label: string; color?: string }) => (
              <div style={{ fontSize: 9, fontWeight: 700, color, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '14px 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ color: dim }}>{n}</span>
                <span style={{ color }}>{label}</span>
                <span style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.05)', display: 'inline-block' }} />
              </div>
            );
            const TRow = ({ label, before, during, dc }: { label: string; before: string | null; during: string | null; dc?: string }) => (
              <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                <td style={{ padding: '3px 0', color: dim, fontSize: 10 }}>{label}</td>
                <td style={{ padding: '3px 12px', textAlign: 'right', color: sub, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>{before ?? '—'}</td>
                <td style={{ padding: '3px 0', textAlign: 'right', color: dc ?? '#e6edf3', fontSize: 10, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{during ?? '—'}</td>
              </tr>
            );

            return (
              <div style={{ marginTop: 0 }}>
                {/* 1. Metrics Snapshot */}
                <SecHead n="1." label="Metrics Snapshot" color="#3fb950" />
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr style={{ color: dim, fontSize: 9, fontWeight: 700 }}>
                    <th style={{ textAlign: 'left', padding: '2px 0' }} />
                    <th style={{ textAlign: 'right', padding: '2px 12px' }}>Before (5m)</th>
                    <th style={{ textAlign: 'right', padding: '2px 0', color: sub }}>During</th>
                  </tr></thead>
                  <tbody>
                    <TRow label="CPU avg"      before={avg(cpuBefore)  != null ? `${avg(cpuBefore)}%`  : null} during={avg(cpuDuring)  != null ? `${avg(cpuDuring)}%`  : null} dc={cpuCol(avg(cpuDuring))} />
                    <TRow label="CPU max"      before={maxV(cpuBefore) != null ? `${maxV(cpuBefore)}%` : null} during={maxV(cpuDuring) != null ? `${maxV(cpuDuring)}%` : null} dc={cpuCol(maxV(cpuDuring))} />
                    <TRow label="Mem avg"      before={avg(memBefore)  != null ? `${avg(memBefore)}%`  : null} during={avg(memDuring)  != null ? `${avg(memDuring)}%`  : null} dc={memCol(avg(memDuring))} />
                    <TRow label="Mem max"      before={maxV(memBefore) != null ? `${maxV(memBefore)}%` : null} during={maxV(memDuring) != null ? `${maxV(memDuring)}%` : null} dc={memCol(maxV(memDuring))} />
                    {(reqBefore > 0 || reqDuring > 0) && <TRow label="Requests"  before={reqBefore.toLocaleString()}  during={reqDuring.toLocaleString()}  dc='#58a6ff' />}
                    {(failBefore > 0 || failDuring > 0) && <TRow label="Failed req" before={failBefore.toLocaleString()} during={failDuring.toLocaleString()} dc={failDuring === 0 ? '#3fb950' : failDuring / (reqDuring || 1) > 0.1 ? 'hsl(var(--destructive))' : '#d29922'} />}
                    {availDuring != null && <TRow label="Availability" before={null} during={`${availDuring}%`} dc={availDuring >= 99 ? '#3fb950' : availDuring >= 95 ? '#d29922' : 'hsl(var(--destructive))'} />}
                    {rt != null && <TRow label="Response time" before={null} during={`avg ${rt.avg}s · max ${rt.max}s`} dc='#58a6ff' />}
                  </tbody>
                </table>

                {/* 3. Root Cause */}
                <SecHead n="2." label="Root Cause Analysis" color="hsl(var(--destructive))" />
                <div style={{ fontSize: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div><span style={{ color: dim }}>Primary: </span><span style={{ color: causeColor, fontWeight: 700 }}>{(causeLabel ?? reasons.join(', ')) || 'Unknown'}</span></div>
                  {causeDetail && <div style={{ color: sub, fontSize: 10 }}><span style={{ color: dim }}>Signals: </span>{causeDetail.signals}</div>}
                  {factors.length > 0 && (
                    <div>
                      <div style={{ color: dim, fontSize: 9, marginBottom: 3 }}>Contributing Factors:</div>
                      {factors.map((f, i) => <div key={i} style={{ display: 'flex', gap: 6, color: sub, wordBreak: 'break-word', overflowWrap: 'anywhere' }}><span style={{ color: dim, flexShrink: 0 }}>•</span><span>{f}</span></div>)}
                    </div>
                  )}
                  {firstSig && (
                    <div style={{ fontSize: 10, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                      <span style={{ color: dim }}>First signal: </span>
                      <span style={{ color: firstSig.color, fontVariantNumeric: 'tabular-nums' }}>{sgtTime(firstSig.t)} SGT</span>
                      <span style={{ color: dim }}> — </span>
                      <span style={{ color: firstSig.color }}>{firstSig.label}</span>
                    </div>
                  )}
                </div>

                {/* 4. Dependency Failures */}
                {deps.length > 0 && (
                  <>
                    <SecHead n="3." label="Dependency Failures" color="#a371f7" />
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                      <thead><tr style={{ color: dim, fontWeight: 700, fontSize: 9 }}>
                        <th style={{ textAlign: 'left', padding: '2px 0' }}>Name</th>
                        <th style={{ textAlign: 'left', padding: '2px 8px' }}>Type</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>Fails</th>
                        <th style={{ textAlign: 'right', padding: '2px 0' }}>Avg dur</th>
                      </tr></thead>
                      <tbody>
                        {deps.map((d, i) => (
                          <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '3px 0', color: sub, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.name}>{d.name}</td>
                            <td style={{ padding: '3px 8px', color: dim, whiteSpace: 'nowrap' }}>{d.type}</td>
                            <td style={{ padding: '3px 8px', textAlign: 'right', color: 'hsl(var(--destructive))', fontVariantNumeric: 'tabular-nums' }}>{d.count}</td>
                            <td style={{ padding: '3px 0', textAlign: 'right', color: dim, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmtDur(d.totalDur / d.times)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {/* 5. Instance Health */}
                {instStats.length > 0 && (
                  <>
                    <SecHead n="4." label="Instance Health" />
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
                      <thead><tr style={{ color: dim, fontWeight: 700, fontSize: 9 }}>
                        <th style={{ textAlign: 'left', padding: '2px 0' }}>Instance</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>Before avg</th>
                        <th style={{ textAlign: 'right', padding: '2px 8px' }}>During avg</th>
                        <th style={{ textAlign: 'right', padding: '2px 0' }}>During min</th>
                      </tr></thead>
                      <tbody>
                        {instStats.map((inst, i) => (
                          <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ padding: '3px 0', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={inst.name}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><span style={{ color: inst.color, fontSize: 8 }}>●</span><span style={{ color: sub }}>{inst.shortName}</span></span>
                            </td>
                            <td style={{ padding: '3px 8px', textAlign: 'right', color: dim, fontVariantNumeric: 'tabular-nums' }}>{inst.beforeAvg != null ? `${inst.beforeAvg}%` : '—'}</td>
                            <td style={{ padding: '3px 8px', textAlign: 'right', color: hCol(inst.duringAvg), fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{inst.duringAvg != null ? `${inst.duringAvg}%` : '—'}</td>
                            <td style={{ padding: '3px 0', textAlign: 'right', color: hCol(inst.duringMin), fontVariantNumeric: 'tabular-nums' }}>{inst.duringMin != null ? `${inst.duringMin}%` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}

                {/* 6. Health Probes */}
                {probeStats.some(p => p.failures > 0) && (
                  <>
                    <SecHead n="5." label="Health Probes" color="#f85149" />
                    <div style={{ fontSize: 10, color: dim, marginBottom: 6 }}>
                      Total: <span style={{ color: 'hsl(var(--destructive))', fontWeight: 700 }}>{probeStats.reduce((a, p) => a + p.failures, 0)}</span> failures across <span style={{ color: sub }}>{probeStats.filter(p => p.failures > 0).length}</span> instance(s)
                    </div>
                    {probeStats.filter(p => p.failures > 0).map((p, i) => (
                      <div key={i} style={{ marginBottom: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                          <span style={{ color: p.color, fontSize: 8 }}>●</span>
                          <span style={{ color: sub, fontSize: 10, fontWeight: 600 }}>{p.shortName}</span>
                          <span style={{ color: dim, fontSize: 9 }}>— {p.failures}/{p.total} failures · min {p.minPct ?? '—'}% · avg {p.avgPct ?? '—'}%</span>
                        </div>
                        <div style={{ paddingLeft: 14, display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>
                          {p.failTimes.map((t, j) => <span key={j} style={{ fontSize: 9, color: 'hsl(var(--destructive))', fontVariantNumeric: 'tabular-nums' }}>{sgtTime(t)} SGT</span>)}
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {/* 7. Traffic Analysis */}
                {(() => {
                  const ri = popupChartData?.requestInsights;
                  if (!ri && reqBefore === 0 && reqDuring === 0 && preHfTop5.length === 0) return null;
                  const preHf = preHfTop5;
                  return (
                    <>
                      <SecHead n="6." label="Traffic Analysis" color="#58a6ff" />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10 }}>
                        {(reqBefore > 0 || reqDuring > 0) && (
                          <div style={{ color: sub }}>
                            Requests: <span style={{ color: dim }}>{reqBefore.toLocaleString()}</span> before → <span style={{ color: '#58a6ff', fontWeight: 600 }}>{reqDuring.toLocaleString()}</span> during{reqSpikePct != null && <span style={{ color: reqSpikePct > 50 ? '#f0883e' : dim }}>{' '}({reqSpikePct > 0 ? '+' : ''}{reqSpikePct}% vs baseline)</span>}
                          </div>
                        )}
                        {(failBefore > 0 || failDuring > 0) && (
                          <div style={{ color: sub }}>
                            Failures: <span style={{ color: dim }}>{failBefore.toLocaleString()}</span> before → <span style={{ color: failDuring > 0 ? 'hsl(var(--destructive))' : '#3fb950', fontWeight: 600 }}>{failDuring.toLocaleString()}</span> during
                          </div>
                        )}
                        {ri?.urls && ri.urls.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <div style={{ color: dim, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>Top Endpoints</div>
                            {ri.urls.slice(0, 5).map((u, i) => (
                              <div key={i} style={{ display: 'flex', gap: 8, borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)', padding: '2px 0' }}>
                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: sub }} title={u.url}>{u.url}</span>
                                <span style={{ flexShrink: 0, color: '#58a6ff', fontVariantNumeric: 'tabular-nums' }}>{u.rpm} rpm</span>
                                <span style={{ flexShrink: 0, color: dim, fontVariantNumeric: 'tabular-nums' }}>{u.count.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {ri?.failedUrls && ri.failedUrls.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <div style={{ color: dim, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>Failed Endpoints</div>
                            {ri.failedUrls.slice(0, 5).map((u, i) => (
                              <div key={i} style={{ display: 'flex', gap: 8, borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)', padding: '2px 0' }}>
                                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: sub }} title={u.url}>{u.url}</span>
                                <span style={{ flexShrink: 0, color: '#f85149', fontVariantNumeric: 'tabular-nums' }}>{u.rpm} rpm</span>
                                <span style={{ flexShrink: 0, color: dim, fontVariantNumeric: 'tabular-nums' }}>{u.count.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {preHf.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <div style={{ color: dim, fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 3 }}>High Frequency Traffic (−5min → end)</div>
                            {preHf.map((h, i) => {
                              const fmtT = (iso: string) => new Date(iso).toLocaleString('en-GB', { ...SGT, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                              const timeRange = h.lastSeen
                                ? `${fmtT(h.timestamp)} → ${fmtT(h.lastSeen)}`
                                : fmtT(h.timestamp);
                              return (
                              <div key={i} style={{ borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.04)', padding: '4px 0' }}>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                  <span style={{ color: sub, fontWeight: 600, whiteSpace: 'nowrap' }}>{h.ip || '(unknown)'}</span>
                                  {h.country && <span style={{ color: dim, fontSize: 9 }}>{h.country}</span>}
                                  <span style={{ flex: 1 }} />
                                  <span style={{ flexShrink: 0, color: '#d29922', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{h.rpm} rpm</span>
                                  <span style={{ flexShrink: 0, color: dim, fontVariantNumeric: 'tabular-nums' }}>{h.count.toLocaleString()} total</span>
                                </div>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 1 }}>
                                  <span style={{ color: dim, fontSize: 9, fontVariantNumeric: 'tabular-nums' }}>{timeRange}</span>
                                  <span style={{ color: '#484f58', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{h.userAgent || '(unknown UA)'}</span>
                                </div>
                              </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </>
                  );
                })()}

                {/* 8. Timeline */}
                {events.length > 0 && (
                  <>
                    <SecHead n="7." label="Timeline" />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {events.map((ev, i) => (
                        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 10, ...(ev.isMarker ? { borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 4, marginTop: 2 } : {}) }}>
                          <span style={{ color: dim, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', fontSize: 9, minWidth: 56 }}>{sgtTime(ev.t)}</span>
                          <span style={{ color: ev.color, flexShrink: 0, width: 10, textAlign: 'center', fontSize: 9 }}>{ev.icon}</span>
                          <span style={{ color: ev.color }}>{ev.label}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {/* Detector Analysis */}
                {detectorLoading && (
                  <div className="animate-pulse" style={{ marginTop: 14, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 9, fontWeight: 700, color: '#484f58', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Detector Analysis</div>
                    {[80, 60, 70, 50].map((w, i) => (
                      <div key={i} style={{ height: 9, width: `${w}%`, borderRadius: 3, background: 'rgba(255,255,255,0.05)', marginBottom: 5 }} />
                    ))}
                  </div>
                )}
                {!detectorLoading && detectorData && (() => {
                  const visibleCats = detectorData.categories.filter(cat =>
                    cat.queries.some(q => q.result.rows.length > 0 || q.result.error)
                  );
                  if (visibleCats.length === 0 && !detectorData.error) return null;
                  return (
                    <>
                      <SecHead n="8." label="Detector Analysis" color="#58a6ff" />
                      {detectorData.error && (
                        <div style={{ fontSize: 10, color: 'hsl(var(--destructive))', marginBottom: 6 }}>{detectorData.error}</div>
                      )}
                      {visibleCats.map(cat => {
                        const nonempty = cat.queries.filter(q => q.result.rows.length > 0 || q.result.error);
                        return (
                          <div key={cat.id} style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, color: cat.color, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{cat.label}</div>
                            {nonempty.map((q, qi) => (
                              <div key={qi} style={{ marginBottom: 6 }}>
                                <div style={{ fontSize: 9, color: sub, marginBottom: 2 }}>{q.name}</div>
                                {q.result.error
                                  ? <span style={{ fontSize: 9, color: 'hsl(var(--destructive))' }}>{q.result.error}</span>
                                  : (
                                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
                                      {q.result.columns.length > 0 && (
                                        <thead>
                                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                                            {q.result.columns.map((col, ci) => (
                                              <th key={ci} style={{ padding: '2px 6px 3px 0', color: '#484f58', fontWeight: 700, textAlign: 'left', whiteSpace: 'nowrap', letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: 8 }}>{col}</th>
                                            ))}
                                          </tr>
                                        </thead>
                                      )}
                                      <tbody>
                                        {q.result.rows.slice(0, 10).map((row, ri) => (
                                          <tr key={ri} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                                            {row.map((val, ci) => {
                                              const str = val == null ? '—'
                                                : typeof val === 'number' ? (Number.isInteger(val) ? val.toLocaleString() : val.toFixed(2))
                                                : typeof val === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(val)
                                                  ? sgtTime(new Date(val).getTime())
                                                  : String(val);
                                              return (
                                                <td key={ci} style={{ padding: '2px 6px 2px 0', color: ci === 0 ? sub : dim, maxWidth: ci === 0 ? 200 : 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                                                  {str}
                                                </td>
                                              );
                                            })}
                                          </tr>
                                        ))}
                                        {q.result.rows.length > 10 && (
                                          <tr><td colSpan={q.result.columns.length || 1} style={{ padding: '2px 0', color: dim, fontSize: 8 }}>+{q.result.rows.length - 10} more rows</td></tr>
                                        )}
                                      </tbody>
                                    </table>
                                  )
                                }
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </>
                  );
                })()}

                {/* Footer */}
                <div style={{ marginTop: 14, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 9, color: '#333d48', display: 'flex', justifyContent: 'space-between' }}>
                  <span>DevForge · {appKey}</span>
                  <span>Generated {sgtFull(Date.now())} SGT</span>
                </div>
              </div>
            );
          })()}
          </div>{/* end scrollable content */}
        </div>
      </div>
    )}

    </>
  );
}
