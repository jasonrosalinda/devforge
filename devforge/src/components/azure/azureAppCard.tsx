import React, { useState, useEffect, useCallback } from 'react';
import { Copy, ChevronDown, ChevronRight, Sparkles, SlidersHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import type { AppMetrics, MetricSeries } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CombinedChart, CHART_COLORS, INSTANCE_PALETTE } from './azureMetricChart';
import { useCopyElementAsImage } from '@/hooks/useCopyElementAsImage';
import { useUptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';

type Status = 'healthy' | 'warning' | 'critical';
export function getStatus(cpuAvg: number, memAvg: number, cpuP99?: number, memP99?: number): Status {
  if (cpuAvg > 90 || memAvg > 95 || (cpuP99 ?? 0) >= 100 || (memP99 ?? 0) >= 100) return 'critical';
  if (cpuAvg > 70 || memAvg > 80  || (cpuP99 ?? 0) > 85  || (memP99 ?? 0) > 90)  return 'warning';
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
  detailsLoading?: boolean;
  detailsLoaded?: boolean;
  onRequestDetails?: () => void;
  azureSettings: AzureSettings;
  uptimeRobotApiKey?: string | undefined;
  uptimeRobotMonitorIds?: string[] | undefined;
  rangeStart?: string | undefined;
  rangeEnd?: string | undefined;
}


function SkeletonBlock({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className ?? ''}`} />;
}

export function AzureAppCard({ appKey, metrics, loading, detailsLoading = false, detailsLoaded = false, onRequestDetails, azureSettings, uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd }: AzureAppCardProps) {
  const { elementRef: cardRef, copyAsImage, isCopying } = useCopyElementAsImage<HTMLDivElement>({
    fileNamePrefix: `azure-${appKey}-${Date.now()}`,
    backgroundColor: '#09090b',
  });
  const { monitors: urMonitors, loading: urLoading, error: urError } = useUptimeRobotMonitor(uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd);
  const [urExpanded, setUrExpanded] = useState(false);
  const [requestsExpanded, setRequestsExpanded] = useState(false);
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [availExpanded, setAvailExpanded] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [visibleBlocks, setVisibleBlocks] = useState({
    cpu: true, memory: true, response: true, requests: true,
    dependencies: true, exceptions: true, instances: true, uptimerobot: true,
  });
  const toggleBlock = (key: keyof typeof visibleBlocks) =>
    setVisibleBlocks(prev => ({ ...prev, [key]: !prev[key] }));
  const [requestsTab, setRequestsTab] = useState<'requests' | 'highfreq' | 'http4xx' | 'http5xx' | 'bots'>('requests');
  const [requestsSource, setRequestsSource] = useState<'fe' | 'api'>('fe');
  const [errTab, setErrTab] = useState<'types' | 'socket' | 'sqlhttp'>('types');
  const [selectedErrType, setSelectedErrType] = useState<string | null>(null);
  const [exceptionsSource, setExceptionsSource] = useState<'fe' | 'api'>('fe');
  const [depsTab, setDepsTab] = useState<'topDeps' | 'failedDeps'>('topDeps');
  const [incidentReportLoading, setIncidentReportLoading] = useState(false);
  const [incidentReportError, setIncidentReportError] = useState<string | null>(null);


  const handleIncidentReport = useCallback(async () => {
    const appCfg = azureSettings?.apps?.find((a) => a.name === appKey);
    setIncidentReportLoading(true);
    setIncidentReportError(null);
    try {
      const effectiveStart = rangeStart ? new Date(rangeStart).getTime() : Date.now() - 24 * 3600_000;
      const effectiveEnd   = rangeEnd   ? new Date(rangeEnd).getTime()   : Date.now();
      const uptimeRobotIncidents = urMonitors.flatMap(mon =>
        (mon.logs ?? [])
          .filter(l => l.type === 1)
          .filter(l => {
            const logStart = l.datetime * 1000;
            const logEnd   = (l.datetime + l.duration) * 1000;
            return logEnd >= effectiveStart && logStart <= effectiveEnd;
          })
          .map(l => ({
            monitor:  mon.friendly_name || mon.url,
            start:    l.datetime * 1000,
            end:      (l.datetime + l.duration) * 1000,
            duration: l.duration,
            reason:   l.reason?.detail ?? '',
          }))
      );
      const result = await (window.electronAPI as any).incidentReport.generate({
        subscriptionId: azureSettings.subscriptionId,
        resourceGroup: appCfg?.resourceGroup,
        appName: appKey,
        appType: appCfg?.type ?? 'appservice',
        appInsightsAppId: appCfg?.appInsightsAppId,
        apiName: appCfg?.apiName,
        apiInsightsAppId: appCfg?.apiInsightsAppId,
        apiType: appCfg?.apiType,
        startMs: effectiveStart,
        endMs: effectiveEnd,
        uptimeRobotIncidents,
      });
      if (!result.success) setIncidentReportError(result.error ?? 'Unknown error');
    } catch (e: any) {
      setIncidentReportError(e?.message ?? 'Unknown error');
    } finally {
      setIncidentReportLoading(false);
    }
  }, [appKey, azureSettings, rangeStart, rangeEnd]);

  // PT1M data fetched separately for the incidents panel — avoids dashboard-interval gaps
  const [incidentDetailMetrics, setIncidentDetailMetrics] = useState<AppMetrics | null>(null);
  const [incidentDetailLoading, setIncidentDetailLoading] = useState(false);

  useEffect(() => {
    if (!urExpanded || !rangeStart || !rangeEnd) return;
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
  const memP99Pct = metrics.memUnit === 'MB' ? 0 : metrics.memory.p99;
  const status = getStatus(metrics.cpu.avg, memPct, metrics.cpu.p99, memP99Pct);
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
  const appConfig = (azureSettings as any)?.apps?.find((a: any) => a.name === appKey) ?? null;
  const resourceGroup = appConfig?.resourceGroup ?? null;
  const hasApi = !!(appConfig?.apiName);
  const hasDb = !!(appConfig?.dbName);
  const feHasInsights = !!(appConfig?.appInsightsAppId);
  const apiHasInsights = !!(appConfig?.apiInsightsAppId);

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
          <h2 className="font-bold text-base m-0">{resourceGroup || metrics.label}</h2>
          <span className="text-xs text-muted-foreground">
            {typeLabel}{planMeta ? ` · ${planMeta}` : ''}
          </span>
          {([
            { tag: 'FE',  show: true,   ai: feHasInsights },
            { tag: 'API', show: hasApi,  ai: apiHasInsights },
            { tag: 'DB',  show: hasDb,   ai: false },
          ] as const).filter(t => t.show).map(({ tag, ai }) => (
            <span key={tag} className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{
              background: ai ? 'rgba(88,166,255,0.12)' : 'rgba(255,255,255,0.06)',
              color:      ai ? '#58a6ff'               : '#8b9ab3',
              border:     `1px solid ${ai ? 'rgba(88,166,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
            }}>
              {tag}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {seriesStart && seriesEnd && (
            <span className="text-[10px] text-muted-foreground">{seriesStart} → {seriesEnd}</span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" title="Toggle visible blocks" data-html2canvas-ignore="true">
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44" data-html2canvas-ignore="true">
              <DropdownMenuLabel className="text-xs">Visible blocks</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {([
                { key: 'cpu',          label: 'CPU' },
                { key: 'memory',       label: 'Memory' },
                { key: 'response',     label: 'Response' },
                { key: 'requests',     label: 'Requests' },
                { key: 'dependencies', label: 'Dependencies' },
                { key: 'exceptions',   label: 'Exceptions' },
                { key: 'instances',    label: 'Instances' },
                { key: 'uptimerobot',  label: 'UptimeRobot' },
              ] as const).map(({ key, label }) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  className="text-xs"
                  checked={visibleBlocks[key]}
                  onCheckedChange={() => toggleBlock(key)}
                >{label}</DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => handleIncidentReport()}
            disabled={incidentReportLoading}
            title={incidentReportLoading ? 'Generating incident report…' : 'Download Incident Report (Markdown — feed to AI agent)'}
            data-html2canvas-ignore="true"
            style={undefined}
          >
            <Sparkles
              className="w-3.5 h-3.5"
              style={incidentReportLoading ? {
                color: '#d29922',
                filter: 'drop-shadow(0 0 6px #d29922)',
                animation: 'sparkle-glow 1.2s ease-in-out infinite',
              } : undefined}
            />
          </Button>
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
      {incidentReportError && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-md text-xs border border-destructive/30 bg-destructive/10 text-destructive flex items-center justify-between">
          <span>Incident report failed: {incidentReportError}</span>
          <button onClick={() => setIncidentReportError(null)} className="ml-2 hover:opacity-70">✕</button>
        </div>
      )}
      {/* Chart — edge to edge */}
      <CombinedChart
        cpu={metrics.cpu}
        memory={metrics.memory}
        downtimeIntervals={downtimeIntervals}
        availabilitySeries={undefined}
        instanceHealthSeries={null}
        apiInstanceHealthSeries={null}
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
              <td className="text-right">P99</td>
              <td className="text-right">Max</td>
            </tr>
          </thead>
          <tbody>
            {visibleBlocks.cpu && (
              <tr>
                <td className="text-muted-foreground font-bold">CPU</td>
                <td className="text-right" style={{ color: CHART_COLORS.cpuAvg }}>{(+metrics.cpu.avg).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.cpuMax }}>{(+metrics.cpu.p99).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.cpuMax }}>{(+metrics.cpu.max).toFixed(2)}%</td>
              </tr>
            )}
            {visibleBlocks.memory && (
              <tr>
                <td className="text-muted-foreground font-bold">Memory</td>
                <td className="text-right" style={{ color: CHART_COLORS.memAvg }}>{(+metrics.memory.avg).toFixed(2)}{metrics.memUnit}</td>
                <td className="text-right" style={{ color: CHART_COLORS.memMax }}>{(+metrics.memory.p99).toFixed(2)}{metrics.memUnit}</td>
                <td className="text-right" style={{ color: CHART_COLORS.memMax }}>{(+metrics.memory.max).toFixed(2)}{metrics.memUnit}</td>
              </tr>
            )}
            {visibleBlocks.response && metrics.responseTime != null && (
              <tr>
                <td className="text-muted-foreground font-bold">Response</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.avg}s</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.p99 != null ? `${metrics.responseTime.p99}s` : '—'}</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.max}s</td>
              </tr>
            )}
            {visibleBlocks.requests && metrics.requests != null && (
              <>
                <tr
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setRequestsExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setRequestsSource('fe'); }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td className="text-muted-foreground font-bold">
                    Requests{requestsExpanded ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
                  </td>
                  {(() => {
                    const ai = metrics.requestInsights;
                    const total4xx = ai?.total4xx ?? (metrics.http4xxSeries ?? []).reduce((a, p) => a + (p.count ?? 0), 0);
                    const total5xx = ai?.total5xx ?? (metrics.failedRequestsSeries ?? []).reduce((a, p) => a + (p.count ?? 0), 0);
                    const reqTotal = ai?.insight?.totalRequests ?? metrics.requests?.total ?? 0;
                    const sep = <span style={{ color: '#484f58' }}>/</span>;
                    return (
                      <>
                        <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                          {spanMinutes > 0 && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                              <span style={{ color: total4xx > 0 ? '#f97316' : '#3fb950' }}>{(total4xx / spanMinutes).toFixed(1)}</span>
                              {sep}
                              <span style={{ color: total5xx > 0 ? '#f85149' : '#3fb950' }}>{(total5xx / spanMinutes).toFixed(1)}</span>
                              {sep}
                              <span style={{ color: '#58a6ff' }}>{(reqTotal / spanMinutes).toFixed(1)}</span>
                            </span>
                          )}
                        </td>
                        <td className="text-right text-muted-foreground">—</td>
                        <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <span style={{ color: total4xx > 0 ? '#f97316' : '#3fb950' }}>{total4xx.toLocaleString()}</span>
                            {sep}
                            <span style={{ color: total5xx > 0 ? '#f85149' : '#3fb950' }}>{total5xx.toLocaleString()}</span>
                            {sep}
                            <span style={{ color: '#58a6ff' }}>{reqTotal.toLocaleString()}</span>
                          </span>
                        </td>
                      </>
                    );
                  })()}
                </tr>
                {requestsExpanded && (
                  <>
                    <tr>
                      <td colSpan={4} className="pb-1">
                        {detailsLoading && !detailsLoaded
                          ? <span className="text-[10px] text-muted-foreground italic">Loading details…</span>
                          : !metrics.requestInsights
                          ? <span className="text-[10px] text-muted-foreground italic">Requires App Insights Application ID in settings</span>
                          : metrics.requestInsights.error
                            ? <span className="text-[10px] text-destructive">{metrics.requestInsights.error}</span>
                            : (() => {
                              const ri = requestsSource === 'api' && metrics.apiRequestInsights
                                ? metrics.apiRequestInsights
                                : metrics.requestInsights;
                              return (
                                <div className="flex flex-col gap-1 pt-1">
                                  {/* FE / API source toggle */}
                                  {metrics.apiRequestInsights && (
                                    <div className="flex gap-0.5 mb-0.5">
                                      {(['fe', 'api'] as const).map(src => (
                                        <button
                                          key={src}
                                          onClick={() => setRequestsSource(src)}
                                          style={{
                                            background: requestsSource === src ? '#58a6ff22' : 'none',
                                            border: `1px solid ${requestsSource === src ? '#58a6ff66' : 'transparent'}`,
                                            color: requestsSource === src ? '#58a6ff' : 'var(--muted-foreground)',
                                            borderRadius: 4, padding: '1px 8px', fontSize: 9,
                                            cursor: 'pointer', fontWeight: requestsSource === src ? 600 : 400,
                                          }}
                                        >{src === 'fe' ? 'FE' : 'API'}</button>
                                      ))}
                                    </div>
                                  )}
                                  {/* Tab buttons */}
                                  <div className="flex gap-0.5 flex-wrap">
                                    {(['highfreq', 'http4xx', 'http5xx', 'requests', 'bots'] as const).map(t => {
                                      const labels: Record<string, string> = { highfreq: 'High Freq', http4xx: 'HTTP 4xx', http5xx: 'HTTP 5xx', requests: 'Requests', bots: 'Bots' };
                                      const colors: Record<string, string> = { highfreq: '#a371f7', http4xx: '#f97316', http5xx: '#f85149', requests: '#58a6ff', bots: '#3fb950' };
                                      const c = colors[t];
                                      return (
                                        <button
                                          key={t}
                                          onClick={() => setRequestsTab(t)}
                                          style={{
                                            background: requestsTab === t ? `${c}22` : 'none',
                                            border: `1px solid ${requestsTab === t ? `${c}66` : 'transparent'}`,
                                            color: requestsTab === t ? c : 'var(--muted-foreground)',
                                            borderRadius: 4, padding: '1px 6px', fontSize: 9,
                                            cursor: 'pointer', fontWeight: requestsTab === t ? 600 : 400,
                                          }}
                                        >{labels[t]}</button>
                                      );
                                    })}
                                  </div>

                                  {/* Requests tab */}
                                  {requestsTab === 'requests' && (
                                    !Array.isArray(ri.urls) || ri.urls.length === 0
                                      ? <span className="text-[10px] text-muted-foreground italic">No request data</span>
                                      : <div className="flex flex-col gap-0.5">
                                        {ri.urls.map((u, i) => (
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
                                    !Array.isArray(ri.highFreq) || ri.highFreq.length === 0
                                      ? <span className="text-[10px] text-muted-foreground italic">No high-frequency traffic detected</span>
                                      : <div className="flex flex-col gap-0.5">
                                        {ri.highFreq.map((u, i) => {
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

                                  {/* HTTP 4xx tab */}
                                  {requestsTab === 'http4xx' && (
                                    !Array.isArray(ri.failed4xxUrls) || ri.failed4xxUrls.length === 0
                                      ? <span className="text-[10px] text-muted-foreground italic">No HTTP 4xx data</span>
                                      : <div className="flex flex-col gap-0.5">
                                        {ri.failed4xxUrls.map((u, i) => (
                                          <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                            <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={u.url}>{u.url}</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{u.totalCount > 0 ? `${(u.count / u.totalCount * 100).toFixed(1)}%` : '—'}</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#f97316' }}>{u.count.toLocaleString()}</span>
                                          </div>
                                        ))}
                                      </div>
                                  )}

                                  {/* HTTP 5xx tab */}
                                  {requestsTab === 'http5xx' && (
                                    !Array.isArray(ri.failed5xxUrls) || ri.failed5xxUrls.length === 0
                                      ? <span className="text-[10px] text-muted-foreground italic">No HTTP 5xx data</span>
                                      : <div className="flex flex-col gap-0.5">
                                        {ri.failed5xxUrls.map((u, i) => (
                                          <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                            <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={u.url}>{u.url}</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{u.totalCount > 0 ? `${(u.count / u.totalCount * 100).toFixed(1)}%` : '—'}</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#f85149' }}>{u.count.toLocaleString()}</span>
                                          </div>
                                        ))}
                                      </div>
                                  )}

                                  {/* Bots tab */}
                                  {requestsTab === 'bots' && (
                                    !Array.isArray(ri.bots) || ri.bots.length === 0
                                      ? <span className="text-[10px] text-muted-foreground italic">No bot traffic detected</span>
                                      : <div className="flex flex-col gap-0.5">
                                        {ri.bots.slice(0, 10).map((b, i) => (
                                          <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                            <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={b.userAgent}>{b.userAgent}</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#3fb950' }}>{b.rpm} rpm</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{b.count.toLocaleString()}</span>
                                          </div>
                                        ))}
                                      </div>
                                  )}
                                </div>
                              );
                            })()
                        }
                      </td>
                    </tr>
                  </>
                )}
              </>
            )}
            {visibleBlocks.dependencies && metrics.appInsightsConfigured && metrics.requestInsights && !metrics.requestInsights.error && (() => {
              const insight = metrics.requestInsights.insight;
              if (!insight) return null;
              const depP99      = insight.dependencyP99 ?? 0;
              const depTotal    = insight.totalDependencies ?? 0;
              const depFailRate = insight.dependencyFailureRate ?? 0;
              const topDeps     = metrics.requestInsights.topDependencies ?? [];
              const failedDeps  = metrics.failedDependencies ?? [];
              const hasDetail   = topDeps.length > 0 || failedDeps.length > 0 || insight.totalDependencies > 0 || insight.failedDependencies > 0;
              return (
                <>
                  <tr
                    style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                    onClick={() => hasDetail && setDepsExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                    onMouseEnter={e => hasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      Dependencies
                      {hasDetail && (depsExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      )}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums" style={{ color: depP99 > 5000 ? '#f85149' : depP99 > 1000 ? '#d29922' : '#58a6ff' }}>
                      {depP99 > 0 ? `${Math.round(depP99).toLocaleString()}ms` : '—'}
                    </td>
                    <td className="text-right tabular-nums">
                      {depTotal > 0 ? (() => { const c = depFailRate > 5 ? '#f85149' : depFailRate > 0 ? '#d29922' : '#3fb950'; return insight.failedDependencies > 0
  ? <><span style={{ color: c, fontWeight: 400, fontSize: 10 }}>{insight.failedDependencies.toLocaleString()} ({depFailRate.toFixed(1)}%)</span><span style={{ color: '#3fb950' }}> / {depTotal.toLocaleString()}</span></>
  : <span style={{ color: '#3fb950' }}>{depTotal.toLocaleString()}</span>; })() : '—'}
                    </td>
                  </tr>
                  {depsExpanded && hasDetail && (
                    <>
                      {detailsLoading && !detailsLoaded && (
                        <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Loading details…</td></tr>
                      )}
                      {(!detailsLoading || detailsLoaded) && <tr>
                        <td colSpan={4} style={{ paddingTop: 4, paddingBottom: 2 }}>
                          <div className="flex gap-0.5">
                            {([
                              { key: 'topDeps',    label: 'Top Deps',    color: '#58a6ff' },
                              { key: 'failedDeps', label: 'Failed Deps', color: '#f85149' },
                            ] as const).map(t => (
                              <button
                                key={t.key}
                                onClick={e => { e.stopPropagation(); setDepsTab(t.key); }}
                                style={{
                                  background: depsTab === t.key ? `${t.color}22` : 'none',
                                  border: `1px solid ${depsTab === t.key ? `${t.color}66` : 'transparent'}`,
                                  color: depsTab === t.key ? t.color : 'var(--muted-foreground)',
                                  borderRadius: 4, padding: '1px 6px', fontSize: 9,
                                  cursor: 'pointer', fontWeight: depsTab === t.key ? 600 : 400,
                                }}
                              >{t.label}</button>
                            ))}
                          </div>
                        </td>
                      </tr>}
                      {detailsLoaded && depsTab === 'topDeps' && (
                        topDeps.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No dependency data</td></tr>
                          : topDeps.map((d, i) => (
                            <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                              <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.name} → ${d.target}`}>{d.name || d.target}</td>
                              <td className="text-right tabular-nums text-muted-foreground">—</td>
                              <td className="text-right tabular-nums" style={{ color: d.p99 > 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{d.p99.toLocaleString()}ms</td>
                              <td className="text-right tabular-nums">
                                {d.totalCount > 0 ? (() => { const r = d.failCount / d.totalCount; const c = r > 0.05 ? '#f85149' : d.failCount > 0 ? '#d29922' : '#3fb950'; return d.failCount > 0
  ? <><span style={{ color: c, fontWeight: 400, fontSize: 10 }}>{d.failCount.toLocaleString()} ({(r * 100).toFixed(1)}%)</span><span style={{ color: '#3fb950' }}> / {d.totalCount.toLocaleString()}</span></>
  : <span style={{ color: '#3fb950' }}>{d.totalCount.toLocaleString()}</span>; })() : '—'}
                              </td>
                            </tr>
                          ))
                      )}
                      {detailsLoaded && depsTab === 'failedDeps' && (
                        failedDeps.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No failed dependencies</td></tr>
                          : failedDeps.slice(0, 10).map((d, i) => (
                            <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                              <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.name} → ${d.target}`}>{d.name || d.target}</td>
                              <td className="text-right tabular-nums text-muted-foreground">—</td>
                              <td className="text-right tabular-nums" style={{ color: d.p99 > 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{d.p99.toLocaleString()}ms</td>
                              <td className="text-right tabular-nums">
                                {d.totalCount > 0 ? (() => { const r = d.failCount / d.totalCount; const c = r > 0.05 ? '#f85149' : d.failCount > 0 ? '#d29922' : '#3fb950'; return d.failCount > 0
  ? <><span style={{ color: c, fontWeight: 400, fontSize: 10 }}>{d.failCount.toLocaleString()} ({(r * 100).toFixed(1)}%)</span><span style={{ color: '#3fb950' }}> / {d.totalCount.toLocaleString()}</span></>
  : <span style={{ color: '#3fb950' }}>{d.totalCount.toLocaleString()}</span>; })() : '—'}
                              </td>
                            </tr>
                          ))
                      )}
                    </>
                  )}
                </>
              );
            })()}
            {visibleBlocks.exceptions && metrics.appInsightsConfigured && metrics.requestInsights && !metrics.requestInsights.error && (() => {
              const errorCount   = metrics.requestInsights.errorCount ?? 0;
              const socketEx     = metrics.requestInsights.insight?.socketExceptions ?? 0;
              const errorTypes   = metrics.requestInsights.errorTypes ?? [];
              const snatList     = metrics.requestInsights.snatIndicators ?? [];
              const errorDetails = metrics.requestInsights.errorDetails ?? [];
              const hasDetail    = errorTypes.length > 0 || snatList.length > 0;
              if (errorCount === 0 && !hasDetail) return null;
              const errColor = errorCount === 0 ? '#3fb950' : errorCount <= 10 ? '#d29922' : '#f85149';
              const sockColor = socketEx === 0 ? '#484f58' : socketEx <= 5 ? '#d29922' : '#f85149';
              return (
                <>
                  <tr
                    style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                    onClick={() => { if (hasDetail) { setErrorsExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setSelectedErrType(null); setExceptionsSource('fe'); } }}
                    onMouseEnter={e => hasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      Exceptions
                      {hasDetail && (errorsExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      )}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums">
                      <span style={{ color: sockColor }}>{socketEx.toLocaleString()}</span>
                      <span style={{ color: '#484f58' }}> / </span>
                      <span style={{ color: errColor }}>{errorCount.toLocaleString()}</span>
                    </td>
                  </tr>
                  {errorsExpanded && hasDetail && detailsLoading && !detailsLoaded && (
                    <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Loading details…</td></tr>
                  )}
                  {errorsExpanded && hasDetail && (!detailsLoading || detailsLoaded) && (() => {
                    const eri = exceptionsSource === 'api' && metrics.apiRequestInsights
                      ? metrics.apiRequestInsights
                      : metrics.requestInsights!;
                    const eriTypes   = eri.errorTypes   ?? [];
                    const eriSnat    = eri.snatDetails   ?? [];
                    const eriSqlHttp = eri.sqlHttpDetails ?? [];
                    const eriDetails = eri.errorDetails  ?? [];
                    const hasApiExc  = !!(metrics.apiRequestInsights?.errorTypes?.length || metrics.apiRequestInsights?.snatDetails?.length || metrics.apiRequestInsights?.sqlHttpDetails?.length);
                    const getMeaningfulFrame = (raw: string) => {
                      try {
                        const frames = JSON.parse(raw) as Array<{ assembly?: string; fileName?: string; line?: number; method?: string }>;
                        return frames.find(f => {
                          const asm = f.assembly ?? '';
                          return asm && !asm.startsWith('System.') && !asm.startsWith('Microsoft.') && !asm.startsWith('mscorlib') && !asm.startsWith('netstandard');
                        }) ?? frames[0] ?? null;
                      } catch { return null; }
                    };
                    const renderDetailSubRows = (rows: typeof eriDetails, accentColor: string) => {
                      if (rows.length === 0) return null;
                      const byType = rows.reduce<Map<string, typeof eriDetails>>(
                        (m, d) => { const k = d.type || 'Unknown'; m.set(k, [...(m.get(k) ?? []), d]); return m; },
                        new Map()
                      );
                      return Array.from(byType.entries()).map(([typ, recs], ti) => {
                        const grouped = recs.reduce<Map<string, { d: typeof recs[0]; count: number }>>(
                          (map, d) => {
                            const key = d.operation_Name || '(unknown path)';
                            const ex = map.get(key);
                            if (ex) ex.count++;
                            else map.set(key, { d, count: 1 });
                            return map;
                          },
                          new Map()
                        );
                        return (
                          <React.Fragment key={ti}>
                            <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                              <td colSpan={3} className="truncate" style={{ color: accentColor, paddingLeft: 20, maxWidth: 0, fontWeight: 500 }} title={typ}>{typ}</td>
                              <td className="text-right tabular-nums" style={{ color: recs.length > 10 ? '#f85149' : recs.length > 3 ? '#d29922' : '#484f58' }}>{recs.length.toLocaleString()}</td>
                            </tr>
                            {Array.from(grouped.values()).map(({ d, count }, j) => {
                              const frame = d.parsedStack ? getMeaningfulFrame(d.parsedStack) : null;
                              return (
                                <tr key={j} style={{ borderTop: '1px solid rgba(255,255,255,0.03)', fontSize: 9, background: `${accentColor}08` }}>
                                  <td colSpan={4} style={{ paddingLeft: 32, paddingTop: 4, paddingBottom: 4 }}>
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                          <span style={{ color: 'var(--muted-foreground)' }} title={d.operation_Name}>{d.operation_Name || '(unknown path)'}</span>
                                          {d.method && <span style={{ color: accentColor }} title="Method">{d.method}</span>}
                                        </div>
                                        {(d.innermostType || d.innermostMethod) && (
                                          <div style={{ color: '#484f58', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                            {d.innermostType && <span title="Innermost type">{d.innermostType}</span>}
                                            {d.innermostMethod && <span style={{ color: accentColor, opacity: 0.7 }} title="Innermost method">{d.innermostMethod}</span>}
                                          </div>
                                        )}
                                        {frame && (
                                          <div style={{ color: '#3fb950', fontFamily: 'monospace' }} title="Most meaningful stack frame">
                                            {frame.method}{frame.fileName ? ` @ ${frame.fileName}${frame.line ? `:${frame.line}` : ''}` : ''}
                                          </div>
                                        )}
                                      </div>
                                      {count > 1 && <span style={{ color: accentColor, fontWeight: 600, flexShrink: 0, marginTop: 1 }}>Ã—{count}</span>}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </React.Fragment>
                        );
                      });
                    };
                    return (
                    <>
                      <tr>
                        <td colSpan={4} style={{ paddingTop: 4, paddingBottom: 2 }}>
                          <div className="flex flex-col gap-1">
                            {hasApiExc && (
                              <div className="flex gap-0.5">
                                {(['fe', 'api'] as const).map(src => (
                                  <button
                                    key={src}
                                    onClick={e => { e.stopPropagation(); setExceptionsSource(src); setSelectedErrType(null); }}
                                    style={{
                                      background: exceptionsSource === src ? '#f8514922' : 'none',
                                      border: `1px solid ${exceptionsSource === src ? '#f8514966' : 'transparent'}`,
                                      color: exceptionsSource === src ? '#f85149' : 'var(--muted-foreground)',
                                      borderRadius: 4, padding: '1px 8px', fontSize: 9,
                                      cursor: 'pointer', fontWeight: exceptionsSource === src ? 600 : 400,
                                    }}
                                  >{src === 'fe' ? 'FE' : 'API'}</button>
                                ))}
                              </div>
                            )}
                            <div className="flex gap-0.5">
                              {([
                                { key: 'types',  label: 'By Type',       color: '#f85149' },
                                { key: 'socket', label: 'SNAT / Socket',  color: '#a371f7' },
                                { key: 'sqlhttp', label: 'SQL / HTTP',    color: '#d29922' },
                              ] as const).map(t => (
                                <button
                                  key={t.key}
                                  onClick={e => { e.stopPropagation(); setErrTab(t.key); setSelectedErrType(null); }}
                                  style={{
                                    background: errTab === t.key ? `${t.color}22` : 'none',
                                    border: `1px solid ${errTab === t.key ? `${t.color}66` : 'transparent'}`,
                                    color: errTab === t.key ? t.color : 'var(--muted-foreground)',
                                    borderRadius: 4, padding: '1px 6px', fontSize: 9,
                                    cursor: 'pointer', fontWeight: errTab === t.key ? 600 : 400,
                                  }}
                                >{t.label}</button>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                      {errTab === 'types' && (
                        eriTypes.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No exception type data</td></tr>
                          : eriTypes.map((e, i) => {
                            const isSelected = selectedErrType === e.type;
                            const filtered = eriDetails.filter(d => d.type === e.type);
                            return (
                              <React.Fragment key={i}>
                                <tr
                                  style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10, cursor: eriDetails.length > 0 ? 'pointer' : 'default', background: isSelected ? 'rgba(248,81,73,0.06)' : 'transparent' }}
                                  onClick={e2 => { e2.stopPropagation(); setSelectedErrType(prev => prev === e.type ? null : e.type); }}
                                  onMouseEnter={ev => { if (errorDetails.length > 0) ev.currentTarget.style.background = isSelected ? 'rgba(248,81,73,0.1)' : 'rgba(255,255,255,0.02)'; }}
                                  onMouseLeave={ev => { ev.currentTarget.style.background = isSelected ? 'rgba(248,81,73,0.06)' : 'transparent'; }}
                                >
                                  <td colSpan={3} className="truncate" style={{ color: isSelected ? '#f85149' : 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={e.type}>
                                    {eriDetails.length > 0 && (isSelected
                                      ? <ChevronDown size={9} style={{ marginRight: 3, display: 'inline', verticalAlign: 'middle', flexShrink: 0 }} />
                                      : <ChevronRight size={9} style={{ marginRight: 3, display: 'inline', verticalAlign: 'middle', flexShrink: 0 }} />
                                    )}
                                    {e.type}
                                  </td>
                                  <td className="text-right tabular-nums" style={{ color: e.count > 10 ? '#f85149' : e.count > 3 ? '#d29922' : '#484f58' }}>{e.count.toLocaleString()}</td>
                                </tr>
                                {isSelected && filtered.length === 0 && (
                                  <tr style={{ fontSize: 9 }}>
                                    <td colSpan={4} style={{ paddingLeft: 32, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No detail records available</td>
                                  </tr>
                                )}
                                {isSelected && (() => {
                                  const grouped = filtered.reduce<Map<string, { d: typeof filtered[0]; count: number }>>(
                                    (map, d) => {
                                      const key = d.operation_Name || '(unknown path)';
                                      const existing = map.get(key);
                                      if (existing) existing.count++;
                                      else map.set(key, { d, count: 1 });
                                      return map;
                                    },
                                    new Map()
                                  );
                                  return Array.from(grouped.values()).map(({ d, count }, j) => {
                                    const frame = d.parsedStack ? getMeaningfulFrame(d.parsedStack) : null;
                                    return (
                                      <tr key={j} style={{ borderTop: '1px solid rgba(255,255,255,0.03)', fontSize: 9, background: 'rgba(248,81,73,0.03)' }}>
                                        <td colSpan={4} style={{ paddingLeft: 32, paddingTop: 4, paddingBottom: 4 }}>
                                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                                            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                              {/* Path + method */}
                                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <span style={{ color: 'var(--muted-foreground)' }} title={d.operation_Name}>{d.operation_Name || '(unknown path)'}</span>
                                                {d.method && <span style={{ color: '#a371f7' }} title="Method">{d.method}</span>}
                                              </div>
                                              {/* Innermost cause */}
                                              {(d.innermostType || d.innermostMethod) && (
                                                <div style={{ color: '#484f58', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                  {d.innermostType && <span title="Innermost type">{d.innermostType}</span>}
                                                  {d.innermostMethod && <span style={{ color: '#a371f7' }} title="Innermost method">{d.innermostMethod}</span>}
                                                </div>
                                              )}
                                              {/* Stack frame */}
                                              {frame && (
                                                <div style={{ color: '#3fb950', fontFamily: 'monospace' }} title="Most meaningful stack frame">
                                                  {frame.method}{frame.fileName ? ` @ ${frame.fileName}${frame.line ? `:${frame.line}` : ''}` : ''}
                                                </div>
                                              )}
                                            </div>
                                            {count > 1 && <span style={{ color: '#f85149', fontWeight: 600, flexShrink: 0, marginTop: 1 }}>Ã—{count}</span>}
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  });
                                })()}
                              </React.Fragment>
                            );
                          })
                      )}
                      {errTab === 'socket' && (
                        eriSnat.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No SNAT / Socket exceptions detected</td></tr>
                          : renderDetailSubRows(eriSnat, '#a371f7')
                      )}
                      {errTab === 'sqlhttp' && (
                        eriSqlHttp.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No SQL / HTTP timeout exceptions detected</td></tr>
                          : renderDetailSubRows(eriSqlHttp, '#d29922')
                      )}
                    </>
                    );
                  })()}
                </>
              );
            })()}
            {visibleBlocks.instances && (metrics.availability != null || (metrics.instances?.length ?? 0) > 0 || (metrics.apiInstances?.length ?? 0) > 0) && (() => {
              const availPct = metrics.availability?.pct ?? null;
              const availColor = availPct == null ? 'var(--muted-foreground)' : availPct >= 99 ? '#3fb950' : availPct >= 95 ? '#d29922' : 'hsl(var(--destructive))';
              const feInstances = metrics.instances ?? [];
              const apiInstances = metrics.apiInstances ?? [];
              const feNames = new Set(feInstances.map(i => i.name.toLowerCase()));
              const apiNames = new Set(apiInstances.map(i => i.name.toLowerCase()));
              const allInstances = [
                ...feInstances.map(i => ({ ...i, role: apiNames.has(i.name.toLowerCase()) ? 'both' : 'fe' as const })),
                ...apiInstances
                  .filter(i => !feNames.has(i.name.toLowerCase()))
                  .map(i => ({ ...i, role: 'api' as const })),
              ];
              const hasInstances = allInstances.length > 0;
              const allSeriesVals = (metrics.instanceHealthSeries ?? []).flatMap(s => s.series.map(p => p.v));
              const instAvgHealth = allSeriesVals.length ? allSeriesVals.reduce((s, v) => s + v, 0) / allSeriesVals.length : null;
              const instMinHealth = allSeriesVals.length ? Math.min(...allSeriesVals) : null;
              const healthColor = (v: number | null) => v == null ? 'var(--muted-foreground)' : v >= 99 ? '#3fb950' : v >= 90 ? '#d29922' : '#f85149';

              return (
                <>
                  <tr
                    style={{ cursor: hasInstances ? 'pointer' : 'default' }}
                    onClick={() => hasInstances && setAvailExpanded(v => !v)}
                    onMouseEnter={e => hasInstances && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      Instances{hasInstances && (availExpanded ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />)}
                    </td>
                    <td className="text-right tabular-nums" style={{ color: instAvgHealth != null ? healthColor(instAvgHealth) : 'var(--muted-foreground)' }}>
                      {instAvgHealth != null ? `${instAvgHealth.toFixed(2)}%` : '—'}
                    </td>
                    <td className="text-right text-muted-foreground">—</td>
                    <td className="text-right tabular-nums" style={{ color: instMinHealth != null ? healthColor(instMinHealth) : 'var(--muted-foreground)' }}>
                      {instMinHealth != null ? `${instMinHealth.toFixed(2)}% - min` : '—'}
                    </td>
                  </tr>
                  {availExpanded && allInstances.map((inst, i) => {
                    const shortInstName = inst.name.split('_').slice(-1)[0] || inst.name;
                    const instHealthSeries = metrics.instanceHealthSeries ?? [];
                    const apiHealthSeries = metrics.apiInstanceHealthSeries ?? [];
                    const apiOnly = inst.role === 'api';
                    const activeSeries = apiOnly ? apiHealthSeries : instHealthSeries;
                    const preSeriesIdx = activeSeries.findIndex(
                      s => s.name === inst.name ||
                           s.name.toLowerCase() === inst.name.toLowerCase() ||
                           s.name.toLowerCase().includes(shortInstName.toLowerCase()) ||
                           inst.name.toLowerCase().includes(s.name.toLowerCase())
                    );
                    const preVals = preSeriesIdx >= 0 ? (activeSeries[preSeriesIdx]?.series.map(p => p.v) ?? []) : [];
                    const apiOnlyIdx = apiOnly
                      ? apiInstances.filter(a => !feNames.has(a.name.toLowerCase())).findIndex(a => a.name === inst.name)
                      : -1;
                    const seriesIdx = preSeriesIdx;
                    const series = seriesIdx >= 0 ? activeSeries[seriesIdx] : undefined;
                    const colorIdx = apiOnly
                      ? (feInstances.length + (apiOnlyIdx >= 0 ? apiOnlyIdx : i)) % INSTANCE_PALETTE.length
                      : seriesIdx >= 0 ? seriesIdx % INSTANCE_PALETTE.length : i % INSTANCE_PALETTE.length;
                    const instanceColor = INSTANCE_PALETTE[colorIdx];
                    const vals = preVals;
                    // For API instances with no metric data, derive a fallback from ARM healthStatus
                    const statusFallback = (apiOnly && inst.healthPct === null && !vals.length)
                      ? (inst.healthStatus === 'Healthy' ? 100 : inst.healthStatus === 'Degraded' ? 70 : inst.healthStatus === 'Stopped' ? 0 : null)
                      : null;
                    const fallbackPct = inst.healthPct ?? statusFallback;
                    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : fallbackPct;
                    const latest = vals.length ? vals[vals.length - 1] : fallbackPct;
                    const minVal = vals.length ? Math.min(...vals) : fallbackPct;
                    if (avg === null && latest === null && minVal === null) return null;
                    const hc = (v: number | null) => v == null ? '#8b9ab3' : v >= 99 ? '#3fb950' : v >= 90 ? '#d29922' : 'hsl(var(--destructive))';
                    const avgColor = hc(avg);
                    const shortName = inst.name.split('_').slice(-2).join('_') || inst.name;
                    // roleName from App Insights overrides ARM-based role detection
                    const seriesRoleName = series?.roleName ?? null;
                    const effectiveRole = seriesRoleName
                      ? (seriesRoleName === appConfig?.apiName ? 'api' : 'fe')
                      : inst.role;
                    return (
                      <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td className="truncate max-w-0" style={{ paddingLeft: 20, color: instanceColor }} title={inst.name}>
                          {shortName}
                          {seriesRoleName && (
                            <span style={{ marginLeft: 5, fontSize: 9, color: '#484f58', fontWeight: 600, letterSpacing: '0.04em' }}>
                              {seriesRoleName}
                            </span>
                          )}
                        </td>
                        <td className="text-right tabular-nums" style={{ color: avgColor }}>{avg != null ? `${avg.toFixed(2)}%` : '—'}</td>
                        <td className="text-right tabular-nums" style={{ color: hc(latest) }}>{latest != null ? `${latest.toFixed(2)}%` : '—'}</td>
                        <td className="text-right tabular-nums" style={{ color: hc(minVal) }}>{minVal != null ? `${minVal.toFixed(2)}% - min` : '—'}</td>
                      </tr>
                    );
                  })}
                </>
              );
            })()}
            {visibleBlocks.uptimerobot && urMonitors.length > 0 && (() => {
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
                    onClick={() => totalIncidents > 0 && setUrExpanded(v => !v)}
                    style={{ cursor: totalIncidents > 0 ? 'pointer' : 'default' }}
                    onMouseEnter={e => totalIncidents > 0 && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      UptimeRobot{totalIncidents > 0 && (urExpanded ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />)}
                    </td>
                    <td className="text-right tabular-nums" colSpan={2} style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: incidentColor }}>{totalIncidents} incident{totalIncidents !== 1 ? 's' : ''}</span>
                      {totalDownSec > 0 && <span style={{ color: '#484f58' }}> · </span>}
                      {totalDownSec > 0 && <span style={{ color: incidentColor }}>{fmtDur(totalDownSec)} down</span>}
                    </td>
                    <td className="text-right tabular-nums" style={{ color: uptimeColor, whiteSpace: 'nowrap' }}>
                      {uptimePct != null ? `${uptimePct.toFixed(2)}% uptime` : '—'}
                    </td>
                  </tr>
                  {totalIncidents > 0 && urExpanded && (
                    <tr>
                      <td colSpan={4} style={{ padding: 0 }}>
                        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                          {(urLoading || (incidentDetailLoading && totalIncidents > 0)) && <div style={{ padding: '6px 10px', fontSize: 10, color: '#8b9ab3' }}>{urLoading ? 'Loading monitors…' : 'Loading…'}</div>}
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
                                      {['Instances','RPM','CPU','Mem','Instances','RPM','CPU','Mem','Instances','RPM','CPU','Mem'].map((h, i) => (
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
                                      const duringMin = Math.max(1, (ivEnd - ivStart) / 60000);
                                      const reqBeforeRPM = reqBefore > 0 ? Math.round(reqBefore / 4 * 10) / 10 : 0;
                                      const reqDuringRPM = reqDuring > 0 ? Math.round(reqDuring / duringMin * 10) / 10 : 0;
                                      const reqAfterRPM  = reqAfter  > 0 ? Math.round(reqAfter  / 5 * 10) / 10 : 0;
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
                                      return (
                                        <tr key={logKey} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
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
                                          <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', color: '#484f58' }}>{reqBefore > 0 ? reqBeforeRPM : '—'}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{cpuBefore != null ? `${cpuBefore.toFixed(1)}%` : '—'}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: '#484f58', whiteSpace: 'nowrap' }}>{memBefore != null ? `${memBefore.toFixed(1)}%` : '—'}</td>
                                          <td style={{ padding: '4px 6px', borderLeft: '1px solid rgba(255,255,255,0.06)' }}>{instDuring.length === 0 ? <span style={{ color: '#484f58' }}>—</span> : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{instDuring.map((inst, ii) => { const lc = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length]; const hc = (inst.avg ?? 100) < 50 ? 'hsl(var(--destructive))' : (inst.avg ?? 100) < 90 ? '#d29922' : '#3fb950'; return <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}><span style={{ color: lc }}>●</span><span style={{ color: hc }}>{inst.avg}% / {inst.min}%</span></div>; })}</div>}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', color: muted }}>{reqDuring > 0 ? reqDuringRPM : <span style={{ color: '#484f58' }}>—</span>}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: cpuColor, whiteSpace: 'nowrap' }}>{cpuDuring.toFixed(1)}%</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', color: memColor, whiteSpace: 'nowrap', borderRight: '1px solid rgba(255,255,255,0.06)' }}>{memDuring != null ? `${memDuring.toFixed(1)}%` : '—'}</td>
                                          <td style={{ padding: '4px 6px' }}>{instAfter.length === 0 ? <span style={{ color: '#484f58' }}>—</span> : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{instAfter.map((inst, ii) => { const lc = instanceColorMap.get(inst.name) ?? INSTANCE_PALETTE[ii % INSTANCE_PALETTE.length]; return <div key={ii} title={inst.name} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 9 }}><span style={{ color: lc }}>●</span><span style={{ color: '#484f58' }}>{inst.avg}% / {inst.min}%</span></div>; })}</div>}</td>
                                          <td style={{ padding: '4px 6px', textAlign: 'right', whiteSpace: 'nowrap', color: '#484f58' }}>{reqAfter > 0 ? reqAfterRPM : '—'}</td>
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
          </tbody>
        </table>
        </div>
        )}


      </div>

    </Card>
    </div>


    </>
  );
}
