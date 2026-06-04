import React, { useState, useEffect, useCallback } from 'react';
import { Copy, Share2, ChevronDown, ChevronRight, Sparkles, SlidersHorizontal, ScanSearch } from 'lucide-react';
import { marked } from 'marked';
import { toast } from 'sonner';
import { RcaDialog, type RcaStatus } from './rcaDialog';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CombinedChart, CHART_COLORS, INSTANCE_PALETTE } from './azureMetricChart';
import { AppRemarks, buildRemarks } from './azureAppRemarks';
import { useCopyElementAsImage, loadHtml2Canvas } from '@/hooks/useCopyElementAsImage';
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


interface SnatResult {
  score: number; label: string; color: string;
  socketScore: number; depFailScore: number; depTimeoutScore: number;
  depP99Score: number; connGrowthScore: number; http5xxScore: number;
  connGrowth: number;
  baseConfidence: number; contradictionFactor: number;
  contradictionReasons: string[]; adjustedConfidence: number;
  hotDepFactor: number; retryStormFactor: number; depCallRatio: number;
}

function snatScore(opts: {
  socketExceptions: number;
  dependencyFailureRate: number;
  dependencyTimeouts: number;
  dependencyP99Ms: number;
  connectionBaseline: number;
  connectionCurrent: number;
  http5xxRate: number;
  cpuAvg: number;
  memoryAvg: number;
  topDepTrafficPct: number;
  threadPoolStarvation: boolean;
  totalDependencies: number;
  totalRequests: number;
}): SnatResult {
  const { socketExceptions, dependencyFailureRate, dependencyTimeouts,
          dependencyP99Ms, connectionBaseline, connectionCurrent,
          http5xxRate, cpuAvg, memoryAvg, topDepTrafficPct, threadPoolStarvation,
          totalDependencies, totalRequests } = opts;

  const socketScore     = Math.min(socketExceptions / 50, 1.0);
  const depFailScore    = Math.min(dependencyFailureRate / 20, 1.0);
  const depTimeoutScore = Math.min(dependencyTimeouts / 25, 1.0);
  const depP99Score     = Math.min(dependencyP99Ms / 5000, 1.0);
  const connGrowth      = Math.max(connectionCurrent - connectionBaseline, 0);
  const connGrowthScore = Math.min(connGrowth / 64, 1.0);
  const http5xxScore    = Math.min(http5xxRate / 5, 1.0);

  const baseConfidence = 100 * (
    0.30 * socketScore +
    0.25 * depFailScore +
    0.20 * depTimeoutScore +
    0.15 * depP99Score +
    0.05 * connGrowthScore +
    0.05 * http5xxScore
  );

  let contradictionFactor = 1.0;
  const contradictionReasons: string[] = [];
  if (cpuAvg >= 0 && cpuAvg > 85) { contradictionFactor *= 0.7; contradictionReasons.push(`High CPU (${cpuAvg.toFixed(0)}%) ×0.7`); }
  if (memoryAvg >= 0 && memoryAvg > 90) { contradictionFactor *= 0.8; contradictionReasons.push(`High Memory (${memoryAvg.toFixed(0)}%) ×0.8`); }
  if (threadPoolStarvation) { contradictionFactor *= 0.6; contradictionReasons.push('Thread Pool Starvation ×0.6'); }
  const adjustedConfidence = baseConfidence * contradictionFactor;

  const hotDepFactor  = 1 + Math.min(topDepTrafficPct / 100, 0.3);
  const depCallRatio  = totalRequests > 0 ? totalDependencies / totalRequests : 0;
  const retryStormFactor = 1 + Math.min(Math.max(depCallRatio - 3, 0) / 15, 0.25);
  const score = Math.min(adjustedConfidence * hotDepFactor * retryStormFactor, 100);

  const label = score >= 81 ? 'Critical' : score >= 61 ? 'High' : score >= 41 ? 'Medium' : score >= 21 ? 'Low' : 'Healthy';
  const color = score >= 81 ? '#f85149' : score >= 61 ? '#e6773d' : score >= 41 ? '#d29922' : score >= 21 ? '#58a6ff' : '#3fb950';

  return {
    score, label, color,
    socketScore, depFailScore, depTimeoutScore, depP99Score, connGrowthScore, http5xxScore,
    connGrowth, baseConfidence, contradictionFactor, contradictionReasons, adjustedConfidence,
    hotDepFactor, retryStormFactor, depCallRatio,
  };
}

const SNAT_FACTOR_COLORS = {
  socket:  '#06b6d4',
  depFail: '#ec4899',
  depTO:   '#a855f7',
  depP99:  '#fbbf24',
  conn:    '#4ade80',
  http5xx: '#ef4444',
} as const;

const SNAT_FACTOR_TIPS = {
  socket:  'Socket Exceptions: count of App Insights exception logs matching SocketException patterns. Source: requestInsights.insight.socketExceptions',
  depFail: 'Dependencies Failure Rate: percentage of failed dependency calls. Source: App Insights dependencies where success == false / totalDependencies × 100',
  depTO:   'Dependencies Timeouts: sum of dependency calls returning timeout-class result codes (408, 500, 502, 503, 504). Source: requestInsights.dependencyTimeouts',
  depP99:  'Dependencies P99: 99th-percentile dependency call duration in ms. Source: App Insights percentile(duration, 99) on dependencies',
  conn:    'Connection Growth: increase in active TCP connections (second-half avg − first-half avg). Source: Azure Monitor AppConnections metric',
  http5xx: 'HTTP 5xx Rate: percentage of requests returning 5xx status. Source: App Insights requests where resultCode startswith "5" / totalRequests × 100',
} as const;

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
    remarks: true, cpu: true, memory: true, response: true, requests: true,
    dependencies: true, exceptions: true, instances: true, uptimerobot: true,
    frontend: true, api: true, snatRisk: true,
  });
  const toggleBlock = (key: keyof typeof visibleBlocks) =>
    setVisibleBlocks(prev => ({ ...prev, [key]: !prev[key] }));
  const [requestsTab, setRequestsTab] = useState<'requests' | 'highfreq' | 'http4xx' | 'http5xx' | 'bots'>('requests');
  const [requestsAPITab, setRequestsAPITab] = useState<'requests' | 'highfreq' | 'http4xx' | 'http5xx' | 'bots'>('requests');
  const [requestsAPIExpanded, setRequestsAPIExpanded] = useState(false);
  const [selectedErrType, setSelectedErrType] = useState<string | null>(null);
  const [errAPIExpanded, setErrAPIExpanded] = useState(false);
  const [selectedErrAPIType, setSelectedErrAPIType] = useState<string | null>(null);
  const [snatExpanded, setSnatExpanded] = useState(false);
  const [snatAPIExpanded, setSnatAPIExpanded] = useState(false);
  const [depsTab, setDepsTab] = useState<'topDeps' | 'failedDeps' | 'timeoutDeps'>('topDeps');
  const [depsAPITab, setDepsAPITab] = useState<'topDeps' | 'failedDeps' | 'timeoutDeps'>('topDeps');
  const [depsAPIExpanded, setDepsAPIExpanded] = useState(false);
  const [incidentReportLoading, setIncidentReportLoading] = useState(false);
  const [incidentReportError, setIncidentReportError] = useState<string | null>(null);
  const [rcaOpen, setRcaOpen] = useState(false);
  const [rcaStatus, setRcaStatus] = useState<RcaStatus>('running');
  const [rcaText, setRcaText] = useState('');
  const [rcaError, setRcaError] = useState<string | null>(null);
  const [rcaStages, setRcaStages] = useState<string[]>([]);

  useEffect(() => {
    setUrExpanded(false);
    setRequestsExpanded(false);
    setDepsExpanded(false);
    setErrorsExpanded(false);
    setAvailExpanded(false);
    setRequestsAPIExpanded(false);
    setErrAPIExpanded(false);
    setSnatExpanded(false);
    setSnatAPIExpanded(false);
    setDepsAPIExpanded(false);
    setSelectedErrType(null);
    setSelectedErrAPIType(null);
  }, [metrics.cpu.avg]);


  // Shared payload for both the incident-report download and the Claude RCA.
  const buildIncidentPayload = useCallback(() => {
    const appCfg = azureSettings?.apps?.find((a) => a.name === appKey);
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
    return {
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
    };
  }, [appKey, azureSettings, rangeStart, rangeEnd, urMonitors]);

  const handleIncidentReport = useCallback(async () => {
    setIncidentReportLoading(true);
    setIncidentReportError(null);
    try {
      const result = await window.electronAPI.incidentReport.generate(buildIncidentPayload() as any);
      if (!result.success) setIncidentReportError(result.error ?? 'Unknown error');
    } catch (e: any) {
      setIncidentReportError(e?.message ?? 'Unknown error');
    } finally {
      setIncidentReportLoading(false);
    }
  }, [buildIncidentPayload]);

  const handleRunRca = useCallback(async () => {
    setRcaOpen(true);
    setRcaStatus('running');
    setRcaText('');
    setRcaError(null);
    setRcaStages([]);
    const offChunk = window.electronAPI.incidentReport.onRcaChunk(({ appKey: k, chunk }) => {
      if (k === appKey) setRcaText(prev => prev + chunk);
    });
    const offProgress = window.electronAPI.incidentReport.onRcaProgress(({ appKey: k, stage }) => {
      if (k === appKey) setRcaStages(prev => [...prev, stage]);
    });
    try {
      const result = await window.electronAPI.incidentReport.rca(buildIncidentPayload());
      if (result.success && result.rca) {
        setRcaText(result.rca);
        setRcaStatus('done');
      } else {
        setRcaError(result.error ?? 'Unknown error');
        setRcaStatus('error');
      }
    } catch (e: any) {
      setRcaError(e?.message ?? 'Unknown error');
      setRcaStatus('error');
    } finally {
      offChunk();
      offProgress();
    }
  }, [appKey, buildIncidentPayload]);

  const exportRca = useCallback(async () => {
    try {
      const { startMs, endMs } = buildIncidentPayload();
      const result = await window.electronAPI.incidentReport.saveRca({ appName: appKey, startMs, endMs, markdown: rcaText });
      if (!result.success) throw new Error(result.error ?? 'Save failed');
      await navigator.clipboard.writeText(rcaText);
      toast.success('RCA saved & markdown copied');
    } catch (e: any) {
      toast.error('Export failed', { description: e?.message });
    }
  }, [appKey, buildIncidentPayload, rcaText]);

  const copyRcaForTeams = useCallback(async () => {
    try {
      const htmlBody = marked.parse(rcaText, { async: false }) as string;
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html':  new Blob([htmlBody], { type: 'text/html' }),
          'text/plain': new Blob([rcaText], { type: 'text/plain' }),
        }),
      ]);
      toast.success('Copied for Teams');
    } catch (e: any) {
      toast.error('Copy failed', { description: e?.message });
    }
  }, [rcaText]);

  // Eagerly fetch details when CPI data is available (top dependency % needed for accurate score)
  useEffect(() => {
    if (!metrics.appInsightsConfigured || !metrics.requestInsights || metrics.requestInsights.error) return;
    if (detailsLoaded || detailsLoading) return;
    onRequestDetails?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics.appInsightsConfigured, !!metrics.requestInsights]);

  // PT1M data fetched separately for the incidents panel — avoids dashboard-interval gaps
  const [incidentDetailMetrics, setIncidentDetailMetrics] = useState<AppMetrics | null>(null);
  const [incidentDetailLoading, setIncidentDetailLoading] = useState(false);

  const [isTeamsCopying, setIsTeamsCopying] = useState(false);

  const copyForTeams = async () => {
    const card = cardRef.current;
    if (!card || isCopying || isTeamsCopying) return;
    setIsTeamsCopying(true);

    const { text: remarksText, severity } = buildRemarks(metrics, rangeStart, rangeEnd, visibleBlocks, urMonitors);
    const severityColor: Record<string, string> = { ok: '#3fb950', warning: '#d29922', critical: '#f85149' };
    const color = severityColor[severity] ?? '#333';

    const originalRemarks = card.querySelector('[data-remarks]') as HTMLElement | null;
    if (originalRemarks) originalRemarks.setAttribute('data-html2canvas-ignore', 'true');

    try {
      const html2canvas = await loadHtml2Canvas();
      const canvas: HTMLCanvasElement = await html2canvas(card, {
        backgroundColor: '#09090b', scale: 2, logging: false, useForeignObject: false,
      });
      const imageBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png'),
      );
      const dataUrl = canvas.toDataURL('image/png');
      const htmlBody = `<div style="display:block;"><div style="display:block;"><img src="${dataUrl}" style="width:100%;display:block;"/></div><div style="display:block;margin-top:8px;font-family:sans-serif;font-size:13px;"><b style="color:#555;">Remarks: </b><b style="color:${color};">${remarksText || '—'}</b></div></div>`;
      const plainText = `Remarks: ${remarksText || '—'}`;

      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': imageBlob,
          'text/html': new Blob([htmlBody], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ]);
    } catch (err) {
      console.error('Copy for Teams failed:', err);
    } finally {
      if (originalRemarks) originalRemarks.removeAttribute('data-html2canvas-ignore');
      setIsTeamsCopying(false);
    }
  };

  const hasUrIncidents = !urLoading && urMonitors.some(m => (m.logs ?? []).some(l => l.type === 1));
  useEffect(() => {
    if (!hasUrIncidents || !rangeStart || !rangeEnd) return;
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
  }, [hasUrIncidents, rangeStart, rangeEnd, appKey]);

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
  const urDowntimeIntervals = urMonitors.flatMap(mon =>
    (mon.logs ?? []).filter(l => l.type === 1).map(l => ({
      start: l.datetime * 1000,
      end: (l.datetime + l.duration) * 1000,
    }))
  );

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

  const getMeaningfulFrame = (raw: string) => {
    try {
      const frames = JSON.parse(raw) as Array<{ assembly?: string; fileName?: string; line?: number; method?: string }>;
      return frames.find(f => {
        const asm = f.assembly ?? '';
        return asm && !asm.startsWith('System.') && !asm.startsWith('Microsoft.') && !asm.startsWith('mscorlib') && !asm.startsWith('netstandard');
      }) ?? frames[0] ?? null;
    } catch { return null; }
  };

  type ErrDetail = { timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string };
  const renderErrTypes = (
    types: Array<{ type: string; count: number }>,
    details: ErrDetail[] | null | undefined,
    selType: string | null,
    setSelType: (t: string | null) => void,
  ): React.ReactNode => (
    types.length === 0
      ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No exception type data</td></tr>
      : <>{types.map((e, i) => {
        const isSelected = selType === e.type;
        const filtered = (details ?? []).filter(d => d.type === e.type);
        return (
          <React.Fragment key={i}>
            <tr
              style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10, cursor: (details?.length ?? 0) > 0 ? 'pointer' : 'default', background: isSelected ? 'rgba(248,81,73,0.06)' : 'transparent' }}
              onClick={e2 => { e2.stopPropagation(); setSelType(isSelected ? null : e.type); }}
              onMouseEnter={ev => { if ((details?.length ?? 0) > 0) ev.currentTarget.style.background = isSelected ? 'rgba(248,81,73,0.1)' : 'rgba(255,255,255,0.02)'; }}
              onMouseLeave={ev => { ev.currentTarget.style.background = isSelected ? 'rgba(248,81,73,0.06)' : 'transparent'; }}
            >
              <td colSpan={3} className="truncate" style={{ color: isSelected ? '#f85149' : 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={e.type}>
                {(details?.length ?? 0) > 0 && (isSelected
                  ? <ChevronDown size={9} style={{ marginRight: 3, display: 'inline', verticalAlign: 'middle', flexShrink: 0 }} />
                  : <ChevronRight size={9} style={{ marginRight: 3, display: 'inline', verticalAlign: 'middle', flexShrink: 0 }} />
                )}
                {e.type}
              </td>
              <td className="text-right tabular-nums" style={{ color: e.count > 10 ? '#f85149' : e.count > 3 ? '#d29922' : '#484f58' }}>{e.count.toLocaleString()}</td>
            </tr>
            {isSelected && filtered.length === 0 && (
              <tr style={{ fontSize: 9 }}><td colSpan={4} style={{ paddingLeft: 32, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No detail records available</td></tr>
            )}
            {isSelected && (() => {
              const grouped = filtered.reduce<Map<string, { d: ErrDetail; count: number }>>(
                (map, d) => { const key = d.operation_Name || '(unknown path)'; const ex = map.get(key); if (ex) ex.count++; else map.set(key, { d, count: 1 }); return map; },
                new Map()
              );
              return Array.from(grouped.values()).map(({ d, count }, j) => {
                const frame = d.parsedStack ? getMeaningfulFrame(d.parsedStack) : null;
                return (
                  <tr key={j} style={{ borderTop: '1px solid rgba(255,255,255,0.03)', fontSize: 9, background: 'rgba(248,81,73,0.03)' }}>
                    <td colSpan={4} style={{ paddingLeft: 32, paddingTop: 4, paddingBottom: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: 'var(--muted-foreground)' }} title={d.operation_Name}>{d.operation_Name || '(unknown path)'}</span>
                            {d.method && <span style={{ color: '#a371f7' }} title="Method">{d.method}</span>}
                          </div>
                          {(d.innermostType || d.innermostMethod) && (
                            <div style={{ color: '#484f58', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {d.innermostType && <span title="Innermost type">{d.innermostType}</span>}
                              {d.innermostMethod && <span style={{ color: '#a371f7', opacity: 0.7 }} title="Innermost method">{d.innermostMethod}</span>}
                            </div>
                          )}
                          {frame && (
                            <div style={{ color: '#3fb950', fontFamily: 'monospace' }} title="Most meaningful stack frame">
                              {frame.method}{frame.fileName ? ` @ ${frame.fileName}${frame.line ? `:${frame.line}` : ''}` : ''}
                            </div>
                          )}
                        </div>
                        {count > 1 && <span style={{ color: '#f85149', fontWeight: 600, flexShrink: 0, marginTop: 1 }}>×{count}</span>}
                      </div>
                    </td>
                  </tr>
                );
              });
            })()}
          </React.Fragment>
        );
      })}</>
  );

  const feConPts = metrics.connections?.series ?? [];
  const feConMid = Math.floor(feConPts.length / 2);
  const feConHalfAvg = (arr: typeof feConPts) => arr.length ? arr.reduce((s, p) => s + p.v, 0) / arr.length : 0;
  const feConA1 = feConHalfAvg(feConPts.slice(0, feConMid));
  const feConA2 = feConHalfAvg(feConPts.slice(feConMid));

  const apiConPts = metrics.apiConnections?.series ?? [];
  const apiConMid = Math.floor(apiConPts.length / 2);
  const apiConHalfAvg = (arr: typeof apiConPts) => arr.length ? arr.reduce((s, p) => s + p.v, 0) / arr.length : 0;
  const apiConA1 = apiConHalfAvg(apiConPts.slice(0, apiConMid));
  const apiConA2 = apiConHalfAvg(apiConPts.slice(apiConMid));

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
            { tag: 'Frontend',  show: true,   ai: feHasInsights },
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
                { key: 'remarks',      label: 'Remarks' },
                { key: 'cpu',          label: 'CPU' },
                { key: 'memory',       label: 'Memory' },
                { key: 'response',     label: 'Response' },
                { key: 'requests',     label: 'Requests' },
                { key: 'dependencies', label: 'Dependencies' },
                { key: 'exceptions',   label: 'Exceptions' },
                { key: 'instances',    label: 'Instances' },
                { key: 'uptimerobot',  label: 'UptimeRobot' },
                { key: 'frontend',     label: 'Frontend' },
                { key: 'api',          label: 'API' },
                { key: 'snatRisk',     label: 'CPI' },
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
            onClick={() => handleRunRca()}
            disabled={rcaOpen && rcaStatus === 'running'}
            title="Run Claude RCA on captured metrics"
            data-html2canvas-ignore="true"
          >
            <ScanSearch
              className="w-3.5 h-3.5"
              style={(rcaOpen && rcaStatus === 'running') ? {
                color: '#58a6ff',
                filter: 'drop-shadow(0 0 6px #58a6ff)',
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
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={copyForTeams}
            style={{ visibility: (isCopying || isTeamsCopying) ? 'hidden' : 'visible' }}
            title="Copy for Teams (image + remarks text)"
            data-html2canvas-ignore="true"
          >
            <Share2 className="w-3.5 h-3.5" />
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
        urDowntimeIntervals={urDowntimeIntervals}
        availabilitySeries={undefined}
        instanceHealthSeries={null}
        apiInstanceHealthSeries={null}
        loading={false}
      />

      {/* Metrics + Downtime incidents */}
      <div className="px-4 pt-3 pb-3 text-xs font-medium flex flex-col gap-3">

        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1" style={{ tableLayout: 'fixed' }}><colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /></colgroup>
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
                <td className="text-muted-foreground font-bold" title="CPU: average and max CPU utilization of the App Service instance(s), sourced from Azure Monitor CpuPercentage metric. High sustained CPU may indicate compute saturation unrelated to SNAT.">CPU</td>
                <td className="text-right" style={{ color: CHART_COLORS.cpuAvg }}>{(+metrics.cpu.avg).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.cpuMax }}>{(+metrics.cpu.p99).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.cpuMax }}>{(+metrics.cpu.max).toFixed(2)}%</td>
              </tr>
            )}
            {visibleBlocks.memory && (
              <tr>
                <td className="text-muted-foreground font-bold" title="Memory: average and max memory utilization of the App Service instance(s), sourced from Azure Monitor MemoryPercentage metric. High memory may cause GC pressure and connection pool exhaustion.">Memory</td>
                <td className="text-right" style={{ color: CHART_COLORS.memAvg }}>{(+metrics.memory.avg).toFixed(2)}{metrics.memUnit}</td>
                <td className="text-right" style={{ color: CHART_COLORS.memMax }}>{(+metrics.memory.p99).toFixed(2)}{metrics.memUnit}</td>
                <td className="text-right" style={{ color: CHART_COLORS.memMax }}>{(+metrics.memory.max).toFixed(2)}{metrics.memUnit}</td>
              </tr>
            )}
            {visibleBlocks.response && metrics.responseTime != null && (
              <tr>
                <td className="text-muted-foreground font-bold" title="Response Time: average and P99 server-side request duration in seconds, sourced from App Insights request telemetry. Elevated P99 often correlates with SNAT port wait or slow downstream dependencies.">Response</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.avg}s</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.p99 != null ? `${metrics.responseTime.p99}s` : '—'}</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{metrics.responseTime.max}s</td>
              </tr>
            )}
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
              const crashedInstCount = instMinHealth != null && instMinHealth < 1
                ? (metrics.instanceHealthSeries ?? []).filter(s => s.series.some(p => p.v < 1)).length
                : 0;
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
                      <span title="Instances: individual App Service instances (scale-out units). Each instance has its own SNAT port allocation — more instances means more total SNAT ports available. Health % reflects App Insights availability probe results per instance.">Instances</span>{hasInstances && (availExpanded ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />)}
                    </td>
                    <td className="text-right tabular-nums" style={{ color: instAvgHealth != null ? healthColor(instAvgHealth) : 'var(--muted-foreground)' }}>
                      {instAvgHealth != null ? `${instAvgHealth.toFixed(2)}%` : '—'}
                    </td>
                    <td className="text-right text-muted-foreground">—</td>
                    <td className="text-right tabular-nums" style={{ color: instMinHealth != null ? healthColor(instMinHealth) : 'var(--muted-foreground)' }}>
                      {instMinHealth != null ? `${instMinHealth.toFixed(2)}%${crashedInstCount > 0 ? ` · ${crashedInstCount} inst` : ''} - min` : '—'}
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
                    const preSeriesPoints = preSeriesIdx >= 0 ? (activeSeries[preSeriesIdx]?.series ?? []) : [];
                    const preVals = preSeriesPoints.map(p => p.v);
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
                    const latest = vals.length ? (vals[vals.length - 1] ?? null) : fallbackPct;
                    const minVal = vals.length ? Math.min(...vals) : fallbackPct;
                    const minIdx = vals.length ? vals.indexOf(Math.min(...vals)) : -1;
                    const minTimeIso = minIdx >= 0 ? (preSeriesPoints[minIdx]?.t ?? null) : null;
                    if (avg === null && latest === null && minVal === null) return null;
                    const hc = (v: number | null) => v == null ? '#8b9ab3' : v >= 99 ? '#3fb950' : v >= 90 ? '#d29922' : 'hsl(var(--destructive))';
                    const avgColor = hc(avg);
                    const shortName = inst.name.split('_').slice(-2).join('_') || inst.name;
                    // roleName from App Insights overrides ARM-based role detection
                    const seriesRoleName = series?.roleName ?? null;
                    const effectiveRole = seriesRoleName
                      ? (seriesRoleName === appConfig?.apiName ? 'api' : 'fe')
                      : inst.role;

                    // First / last seen — derived from the per-instance series.
                    // A point exists in the series only when the instance produced traffic in that bucket,
                    // so first point ≈ when instance came online and last point ≈ last activity.
                    const firstSeenIso = preSeriesPoints.length ? (preSeriesPoints[0]?.t ?? null) : null;
                    const lastSeenIso  = preSeriesPoints.length ? (preSeriesPoints[preSeriesPoints.length - 1]?.t ?? null) : null;
                    const fmtDt = (iso: string) => {
                      const d = new Date(iso);
                      return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
                    };
                    // Determine "still active": lastSeen within 1 granularity bucket of rangeEnd.
                    const rangeEndMs = rangeEnd ? new Date(rangeEnd).getTime() : Date.now();
                    const stillActive = lastSeenIso
                      ? (rangeEndMs - new Date(lastSeenIso).getTime()) <= 15 * 60 * 1000
                      : false;
                    const lifecycle = firstSeenIso && lastSeenIso
                      ? `${fmtDt(firstSeenIso)} → ${stillActive ? fmtDt(new Date(rangeEndMs).toISOString()) : fmtDt(lastSeenIso)}`
                      : null;
                    return (
                      <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        <td className="truncate max-w-0" style={{ paddingLeft: 20, color: instanceColor }} title={inst.name}>
                          <div>
                            {shortName}
                            {seriesRoleName && (
                              <span style={{ marginLeft: 5, fontSize: 9, color: '#484f58', fontWeight: 600, letterSpacing: '0.04em' }}>
                                {seriesRoleName}
                              </span>
                            )}
                          </div>
                          {lifecycle && (
                            <div style={{ fontSize: 9, color: '#6e7681', fontWeight: 400, marginTop: 1 }}>
                              {lifecycle}
                            </div>
                          )}
                        </td>
                        <td className="text-right tabular-nums" style={{ color: avgColor }}>{avg != null ? `${avg.toFixed(2)}%` : '—'}</td>
                        <td className="text-right tabular-nums" style={{ color: hc(latest) }}>{latest != null ? <>{latest.toFixed(2)}%{lastSeenIso && <span style={{ fontSize: 9, color: '#6e7681', fontWeight: 400, marginLeft: 4 }}>{new Date(lastSeenIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}</> : '—'}</td>
                        <td className="text-right tabular-nums" style={{ color: hc(minVal) }}>{minVal != null ? <>{minVal.toFixed(2)}%<span style={{ marginLeft: 4 }}>- min</span>{minTimeIso && <span style={{ fontSize: 9, color: '#6e7681', fontWeight: 400, marginLeft: 4 }}>{new Date(minTimeIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>}</> : '—'}</td>
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
                      <span title="UptimeRobot: external uptime monitoring data. Reports incidents (periods where the endpoint was unreachable from outside Azure) and overall uptime percentage within the selected time range.">UptimeRobot</span>{totalIncidents > 0 && (urExpanded ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />)}
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
                          {(urLoading || incidentDetailLoading) && <div style={{ padding: '6px 10px', fontSize: 10, color: '#8b9ab3' }}>{urLoading ? 'Loading monitors…' : 'Loading incident details…'}</div>}
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

          {(feHasInsights || metrics.connections != null) && visibleBlocks.frontend && (
          <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1" style={{ tableLayout: 'fixed' }}><colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead>
              <tr className="text-muted-foreground font-bold">
                <td>Frontend</td>
                <td></td>
                <td className="text-right">P99</td>
                <td className="text-right">Max</td>
              </tr>
            </thead>
            <tbody>
            {visibleBlocks.requests && metrics.requests != null && (
              <>
                <tr
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setRequestsExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <td className="text-muted-foreground font-bold">
                    <span title="Requests: total HTTP requests received by the app within the selected time range, sourced from App Insights. Includes total count, failure count (non-2xx/3xx), and failure rate. Expand to see top URLs, slow endpoints, and error breakdowns.">Requests</span>{requestsExpanded ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
                  </td>
                  {(() => {
                    const ai = metrics.requestInsights;
                    const total4xx = ai?.total4xx ?? (metrics.http4xxSeries ?? []).reduce((a, p) => a + (p.count ?? 0), 0);
                    const total5xx = ai?.total5xx ?? (metrics.failedRequestsSeries ?? []).reduce((a, p) => a + (p.count ?? 0), 0);
                    const reqTotal = ai?.insight?.totalRequests ?? metrics.requests?.total ?? 0;
                    const errTotal = total4xx + total5xx;
                    const pct = reqTotal > 0 ? (errTotal / reqTotal * 100) : 0;
                    const errColor = pct >= 10 ? '#f85149' : errTotal > 0 ? '#f97316' : '#3fb950';
                    const feSeries = metrics.failedRequestsSeries ?? [];
                    const feMid = Math.floor(feSeries.length / 2);
                    const feAvg = (arr: typeof feSeries) => arr.length ? arr.reduce((s, p) => s + (p.count ?? 0), 0) / arr.length : 0;
                    const fe1 = feAvg(feSeries.slice(0, feMid)); const fe2 = feAvg(feSeries.slice(feMid));
                    const isSpiking5xx = feSeries.length >= 2 && fe2 >= 1 && fe2 > fe1 * 1.05;
                    return (
                      <>
                        <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                          <span style={{ color: isSpiking5xx ? '#f85149' : total5xx > 0 ? '#f97316' : '#3fb950', fontSize: 10 }}>5xx - {total5xx.toLocaleString()}</span>
                        </td>
                        <td className="text-right" style={{ color: '#58a6ff' }}>
                          {ai?.insight?.requestP99 != null ? `${Math.round(ai.insight.requestP99)}ms` : '—'}
                        </td>
                        <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                          {errTotal > 0
                            ? <><span style={{ color: errColor, fontWeight: 400, fontSize: 10 }}>{errTotal.toLocaleString()} ({pct.toFixed(1)}%)</span><span style={{ color: '#58a6ff' }}> / {reqTotal.toLocaleString()}</span></>
                            : <span style={{ color: '#3fb950' }}>{reqTotal.toLocaleString()}</span>
                          }
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
                              const ri = metrics.requestInsights;
                              return (
                                <div className="flex flex-col gap-1 pt-1">
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
                                    Array.isArray(ri.failed5xxUrls) && ri.failed5xxUrls.length > 0
                                      ? <div className="flex flex-col gap-0.5">
                                        {ri.failed5xxUrls.map((u, i) => (
                                          <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                            <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={u.url}>{u.url}</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{u.totalCount > 0 ? `${(u.count / u.totalCount * 100).toFixed(1)}%` : '—'}</span>
                                            <span className="flex-shrink-0 tabular-nums" style={{ color: '#f85149' }}>{u.count.toLocaleString()}</span>
                                          </div>
                                        ))}
                                      </div>
                                      : (() => {
                                          const armPts = (metrics.failedRequestsSeries ?? []).filter(p => (p.count ?? 0) > 0).sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
                                          if (!armPts.length) return <span className="text-[10px] text-muted-foreground italic">No HTTP 5xx data</span>;
                                          return (
                                            <div className="flex flex-col gap-0.5">
                                              <span className="text-[10px] text-muted-foreground italic mb-1">URL breakdown unavailable — ARM 5xx spikes:</span>
                                              {armPts.slice(0, 10).map((p, i) => (
                                                <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                                  <span className="flex-shrink-0 tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{new Date(p.t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                                  <span className="flex-shrink-0 tabular-nums" style={{ color: '#f85149' }}>{(p.count ?? 0).toLocaleString()} errors</span>
                                                </div>
                                              ))}
                                            </div>
                                          );
                                        })()
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
            {metrics.connections != null && (() => {
              const a1 = feConA1; const a2 = feConA2;
              const diff = a2 - a1;
              const threshold = feConHalfAvg(feConPts) * 0.05;
              const trend = feConPts.length < 2 ? null : diff > threshold ? '↑' : diff < -threshold ? '↓' : '→';
              const trendColor = trend === '↑' ? '#f85149' : '#3fb950';
              return (
                <tr>
                  <td className="text-muted-foreground font-bold" title="Connections: active outbound TCP connections from the App Service instance(s), sourced from Azure Monitor AppConnections metric. Growing connection counts can indicate SNAT port accumulation or connection pool leaks.">Connections</td>
                  <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                    {trend
                      ? <span style={{ fontSize: 10, color: trendColor }}>Trend - {Math.round(a1)} {trend} {Math.round(a2)}</span>
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.connections.p99)}</td>
                  <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.connections.max)}</td>
                </tr>
              );
            })()}
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
                      <span title="Dependencies: outbound calls made by the app to external services (SQL, HTTP APIs, storage, etc.), tracked by App Insights. Shows total call count, failure count, failure rate, and P99 latency. High failure or timeout rates are key CPI signals.">Dependencies</span>
                      {hasDetail && (depsExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {(() => { const total = (metrics.requestInsights.dependencyTimeouts ?? []).reduce((s, d) => s + d.count, 0); return <span style={{ color: total > 0 ? '#f97316' : '#3fb950', fontSize: 10 }}>Timeout - {total}</span>; })()}
                    </td>
                    <td className="text-right tabular-nums" style={{ color: depP99 > 5000 ? '#f85149' : depP99 > 1000 ? '#d29922' : '#58a6ff' }}>
                      {depP99 > 0 ? `${Math.round(depP99).toLocaleString()}ms` : '—'}
                    </td>
                    <td className="text-right tabular-nums">
                      {depTotal > 0 ? (() => { const c = depFailRate >= 10 ? '#f85149' : depFailRate > 0 ? '#d29922' : '#3fb950'; return insight.failedDependencies > 0
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
                              { key: 'topDeps',     label: 'Top Deps',     color: '#58a6ff' },
                              { key: 'failedDeps',  label: 'Failed Deps',  color: '#f85149' },
                              { key: 'timeoutDeps', label: 'Timeout Deps', color: '#f97316' },
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
                              <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                              <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{d.p99.toLocaleString()}ms</td>
                              <td className="text-right tabular-nums">
                                {d.totalCount > 0 ? (() => { const r = d.failCount / d.totalCount; const c = r >= 0.10 ? '#f85149' : d.failCount > 0 ? '#d29922' : '#3fb950'; return d.failCount > 0
  ? <><span style={{ color: c, fontWeight: 400, fontSize: 10 }}>{d.failCount.toLocaleString()} ({(r * 100).toFixed(1)}%)</span><span style={{ color: '#3fb950' }}> / {d.totalCount.toLocaleString()}</span></>
  : <span style={{ color: '#3fb950' }}>{d.totalCount.toLocaleString()}</span>; })() : '—'}
                              </td>
                            </tr>
                          ))
                      )}
                      {detailsLoaded && depsTab === 'timeoutDeps' && (() => {
                        const tDeps = (metrics.requestInsights.dependencyTimeouts ?? []).slice().sort((a, b) => b.count - a.count).slice(0, 10);
                        return tDeps.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No timeout dependencies</td></tr>
                          : <>{tDeps.map((d, i) => (
                            <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                              <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={d.name}>{d.name}</td>
                              <td className="text-right tabular-nums text-muted-foreground">—</td>
                              <td className="text-right tabular-nums text-muted-foreground">—</td>
                              <td className="text-right tabular-nums" style={{ color: '#f97316' }}>{d.count.toLocaleString()}</td>
                            </tr>
                          ))}</>;
                      })()}
                      {detailsLoaded && depsTab === 'failedDeps' && (
                        failedDeps.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No failed dependencies</td></tr>
                          : failedDeps.slice(0, 10).map((d, i) => (
                            <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                              <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.name} → ${d.target}`}>{d.name || d.target}</td>
                              <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                              <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{d.p99.toLocaleString()}ms</td>
                              <td className="text-right tabular-nums">
                                {d.totalCount > 0 ? (() => { const r = d.failCount / d.totalCount; const c = r >= 0.10 ? '#f85149' : d.failCount > 0 ? '#d29922' : '#3fb950'; return d.failCount > 0
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
              const errorCount = metrics.requestInsights.errorCount ?? 0;
              const errorTypes = metrics.requestInsights.errorTypes ?? [];
              const hasDetail  = errorTypes.length > 0;
              if (errorCount === 0 && !hasDetail) return null;
              const errColor = errorCount === 0 ? '#3fb950' : errorCount <= 10 ? '#d29922' : '#f85149';
              const socketExc = metrics.requestInsights.insight?.socketExceptions ?? 0;
              return (
                <>
                  <tr
                    style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                    onClick={() => { if (hasDetail) { setErrorsExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setSelectedErrType(null); } }}
                    onMouseEnter={e => hasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      <span title="Exceptions: unhandled application exceptions captured by App Insights, grouped by type. Includes socket exceptions (key CPI signal), SQL/HTTP errors, and general runtime failures. Expand to see breakdown by exception type and individual error details.">Exceptions</span>
                      {hasDetail && (errorsExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      )}
                    </td>
                    <td className="text-right tabular-nums" style={{ whiteSpace: 'nowrap' }}>
                      <span style={{ color: socketExc > 10 ? '#f85149' : socketExc > 0 ? '#f97316' : '#3fb950', fontSize: 10 }}>Socket - {socketExc.toLocaleString()}</span>
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums" style={{ color: errColor }}>{errorCount.toLocaleString()}</td>
                  </tr>
                  {errorsExpanded && hasDetail && detailsLoading && !detailsLoaded && (
                    <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Loading details…</td></tr>
                  )}
                  {errorsExpanded && hasDetail && (!detailsLoading || detailsLoaded) && (
                    renderErrTypes(errorTypes, metrics.requestInsights!.errorDetails ?? [], selectedErrType, setSelectedErrType)
                  )}
                </>
              );
            })()}
            {visibleBlocks.snatRisk && metrics.type !== 'containerapp' && metrics.appInsightsConfigured && metrics.requestInsights && !metrics.requestInsights.error && (() => {
              const snatDetails  = metrics.requestInsights.snatDetails ?? [];
              const count        = snatDetails.length;
              const feInsight    = metrics.requestInsights.insight;
              const socketExc    = feInsight?.socketExceptions      ?? 0;
              const depFailRate  = feInsight?.dependencyFailureRate ?? 0;
              const depTimeouts  = (metrics.requestInsights.dependencyTimeouts ?? []).reduce((s, d) => s + d.count, 0);
              const depP99Ms     = feInsight?.dependencyP99         ?? 0;
              const fe5xx        = metrics.requestInsights.total5xx ?? 0;
              const feReqTotal   = feInsight?.totalRequests         ?? 0;
              const fe5xxRate    = feReqTotal > 0 ? (fe5xx / feReqTotal) * 100 : 0;
              const topDeps      = metrics.requestInsights.topDependencies ?? [];
              const topDepTrafficPct = (topDeps[0] && feReqTotal > 0) ? (topDeps[0].totalCount / feReqTotal * 100) : 0;
              const threadPoolStarvation = (metrics.requestInsights.sqlHttpDetails ?? [])
                .some(d => /thread.?pool|threadabort|starvation/i.test(d.innermostMessage + d.outerMessage));
              const feCpuAvg = metrics.cpu.avg;
              const feMemAvg = metrics.memUnit === '%' ? +metrics.memory.avg : -1;
              const risk = snatScore({
                socketExceptions: socketExc,
                dependencyFailureRate: depFailRate,
                dependencyTimeouts: depTimeouts,
                dependencyP99Ms: depP99Ms,
                connectionBaseline: feConA1,
                connectionCurrent: feConA2,
                http5xxRate: fe5xxRate,
                cpuAvg: feCpuAvg,
                memoryAvg: feMemAvg,
                topDepTrafficPct,
                threadPoolStarvation,
                totalDependencies: feInsight?.totalDependencies ?? 0,
                totalRequests: feReqTotal,
              });
              const subscores = [
                { key: 'socket'  as const, label: 'Socket Exceptions',     raw: `${socketExc}`,                    norm: risk.socketScore,     wt: 30, pts: 30 * risk.socketScore,     normFormulaRaw: `${socketExc}`,                    normFormulaThreshold: '50 exceptions' },
                { key: 'depFail' as const, label: 'Dependencies Failure',  raw: `${depFailRate.toFixed(1)}%`,      norm: risk.depFailScore,    wt: 25, pts: 25 * risk.depFailScore,    normFormulaRaw: `${depFailRate.toFixed(1)}%`,       normFormulaThreshold: '20% fail rate' },
                { key: 'depTO'   as const, label: 'Dependencies Timeouts', raw: `${depTimeouts}`,                  norm: risk.depTimeoutScore, wt: 20, pts: 20 * risk.depTimeoutScore, normFormulaRaw: `${depTimeouts}`,                   normFormulaThreshold: '25 timeouts' },
                { key: 'depP99'  as const, label: 'Dependencies P99',      raw: `${Math.round(depP99Ms)}ms`,       norm: risk.depP99Score,     wt: 15, pts: 15 * risk.depP99Score,     normFormulaRaw: `${Math.round(depP99Ms)}ms`,        normFormulaThreshold: '5000ms P99' },
                { key: 'conn'    as const, label: 'Connection Growth',     raw: `+${Math.round(risk.connGrowth)}`, norm: risk.connGrowthScore, wt: 5,  pts: 5  * risk.connGrowthScore, normFormulaRaw: `${Math.round(risk.connGrowth)}`,   normFormulaThreshold: '64 new conns' },
                { key: 'http5xx' as const, label: 'HTTP 5xx Rate',         raw: `${fe5xxRate.toFixed(1)}%`,        norm: risk.http5xxScore,    wt: 5,  pts: 5  * risk.http5xxScore,    normFormulaRaw: `${fe5xxRate.toFixed(1)}%`,         normFormulaThreshold: '5% error rate' },
              ];
              return (
                <>
                  <tr
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSnatExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      <span title="Connection Pressure Index (CPI): measures the probability that SNAT port exhaustion or dependency connection pressure is contributing to failures. Combines socket exceptions, dependency failure rate, timeouts, P99 latency, connection growth, and HTTP 5xx rate into a normalized 0–100 confidence score.">Connection Pressure Index</span>
                      {snatExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      }
                    </td>
                    <td className="text-right tabular-nums" style={{ color: risk.color }}>{risk.score.toFixed(1)}</td>
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums" style={{ color: risk.color }}>{risk.label}</td>
                  </tr>
                  {snatExpanded && (
                    <tr>
                      <td colSpan={4} style={{ paddingBottom: 8, paddingTop: 2 }}>
                        <div style={{ fontSize: 10, paddingLeft: 8, paddingRight: 8 }}>
                          <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
                          <div style={{ flex: '0 0 auto', minWidth: 320, display: 'flex', flexDirection: 'column' }}>
                          {/* Section A: Normalized subscores */}
                          <div style={{ display: 'grid', gridTemplateColumns: '130px 55px 120px 50px 35px auto', gap: 5, color: '#6e7681', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 3, marginBottom: 4 }}>
                            <span>Factor</span><span style={{ textAlign: 'right' }}>Raw Value</span><span style={{ paddingLeft: 8 }}>Formula</span><span style={{ textAlign: 'right' }}>Normalized</span><span style={{ textAlign: 'right' }}>Weight</span><span style={{ textAlign: 'right' }}>Points</span>
                          </div>
                          {subscores.map((b, i) => {
                            const cc = b.pts >= 12 ? '#f85149' : b.pts >= 6 ? '#e6773d' : b.pts > 0 ? '#d29922' : '#3fb950';
                            return (
                              <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 55px 120px 50px 35px auto', gap: 5, marginBottom: 3 }}>
                                <span style={{ color: SNAT_FACTOR_COLORS[b.key], fontWeight: 600 }} title={SNAT_FACTOR_TIPS[b.key]}>{b.label}</span>
                                <span style={{ color: '#8b949e', textAlign: 'right' }}>{b.raw}</span>
                                <span style={{ color: '#6e7681', paddingLeft: 8 }}><em>{b.normFormulaRaw}</em> / <strong>{b.normFormulaThreshold}</strong></span>
                                <span style={{ color: '#6e7681', textAlign: 'right' }}>{b.norm.toFixed(2)}</span>
                                <span style={{ color: '#6e7681', textAlign: 'right' }}>{b.wt}%</span>
                                <span style={{ color: cc, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{b.pts.toFixed(1)}</span>
                              </div>
                            );
                          })}
                          <div style={{ display: 'grid', gridTemplateColumns: '130px 55px 120px 50px 35px auto', gap: 5, marginTop: 'auto', paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                            <span style={{ color: '#e6edf3', fontWeight: 700 }} title="Base Confidence: weighted sum of the 6 normalized subscores × 100">Base Confidence</span>
                            <span />
                            <span />
                            <span />
                            <span />
                            <span style={{ color: '#e6edf3', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} title="Base Confidence: Σ (weight × norm_score) × 100">{risk.baseConfidence.toFixed(1)}</span>
                          </div>
                          </div>
                          <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: 16 }}>
                          {/* Section B: Score stages */}
                          {(() => {
                            const stagesGrid = '130px 80px 200px 1fr 90px';
                            const cBase   = '#e6edf3';
                            const cContra = risk.contradictionFactor < 1 ? '#f97316' : '#3fb950';
                            const cAdj    = '#818cf8';
                            const cHotDep = '#fb923c';
                            const cRetry  = '#14b8a6';
                            const cFinal  = risk.color;
                            const tipBase   = 'Base Confidence: weighted sum of the 6 normalized subscores above, scaled to 0–100';
                            const tipContra = 'Contradiction Factor: penalty applied when high CPU, memory, or thread-pool starvation indicates the issue is NOT SNAT-related';
                            const tipAdj    = 'Adjusted Confidence: Base Confidence after applying Contradiction Factor';
                            const tipHot    = 'Hot Dependency Factor: amplifies score when one dependency dominates traffic (likely SNAT bottleneck candidate)';
                            const tipRetry  = 'Retry Storm Factor: amplifies score when dependency call volume far exceeds request volume (indicates retry loops)';
                            const tipFinal  = 'Final Score = Adjusted Confidence × Hot Dependency Factor × Retry Storm Factor (capped at 100)';
                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                                <div style={{ display: 'grid', gridTemplateColumns: stagesGrid, gap: 5, color: '#6e7681', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 3, marginBottom: 4 }}>
                                  <span>Stage</span><span>Factor</span><span>Formula</span><span>Detail (substituted values → result)</span><span style={{ textAlign: 'right' }}>Value</span>
                                </div>
                                {([
                                  {
                                    stageColor: cBase,
                                    stageTip: tipBase,
                                    stage: 'Base Confidence',
                                    multiplier: '',
                                    multiplierColor: '#6e7681',
                                    formula: '',
                                    detail: '' as React.ReactNode,
                                    value: risk.baseConfidence.toFixed(1),
                                    color: cBase,
                                  },
                                  {
                                    stageColor: cContra,
                                    stageTip: tipContra,
                                    stage: 'Contradiction',
                                    multiplier: `×${risk.contradictionFactor.toFixed(2)}`,
                                    multiplierColor: cContra,
                                    formula: 'CPU Avg>85%→×0.7 · Memory Avg>90%→×0.8 · ThreadPool→×0.6',
                                    detail: (
                                      <>
                                        <span style={{ color: CHART_COLORS.cpuAvg }} title="CPU Utilization (avg): comes from Azure Monitor CpuPercentage metric (App Service Performance → CPU Avg line)">CPU Utilization (avg) </span>
                                        <span style={{ color: feCpuAvg >= 0 ? (feCpuAvg > 85 ? '#f97316' : CHART_COLORS.cpuAvg) : '#6e7681', fontWeight: 600 }} title="CPU Utilization (avg): comes from Azure Monitor CpuPercentage metric">{feCpuAvg >= 0 ? `${feCpuAvg.toFixed(1)}%` : 'N/A'}</span>
                                        <span style={{ color: feCpuAvg > 85 ? '#f97316' : '#6e7681' }}>{feCpuAvg >= 0 ? (feCpuAvg > 85 ? ' >85% → ×0.7' : ' ≤85% (none)') : ''}</span>
                                        <span style={{ color: '#6e7681' }}> · </span>
                                        <span style={{ color: CHART_COLORS.memAvg }} title="Memory Utilization (avg): comes from Azure Monitor MemoryPercentage metric (App Service Performance → Mem Avg line)">Memory Utilization (avg) </span>
                                        <span style={{ color: feMemAvg >= 0 ? (feMemAvg > 90 ? '#f97316' : CHART_COLORS.memAvg) : '#6e7681', fontWeight: 600 }} title="Memory Utilization (avg): comes from Azure Monitor MemoryPercentage metric">{feMemAvg >= 0 ? `${feMemAvg.toFixed(1)}%` : 'N/A'}</span>
                                        <span style={{ color: feMemAvg > 90 ? '#f97316' : '#6e7681' }}>{feMemAvg >= 0 ? (feMemAvg > 90 ? ' >90% → ×0.8' : ' ≤90% (none)') : ''}</span>
                                        <span style={{ color: '#6e7681' }}> · </span>
                                        <span style={{ color: '#a5b4fc' }} title="Thread Pool Starvation: detected by pattern-matching SNAT/SQL exception messages for ThreadPool/ThreadAbort/Starvation strings">Thread Pool Starvation </span>
                                        <span style={{ color: threadPoolStarvation ? '#f97316' : '#6e7681', fontWeight: 600 }} title="Thread Pool Starvation indicator">{threadPoolStarvation ? 'detected → ×0.6' : '(none)'}</span>
                                      </>
                                    ) as React.ReactNode,
                                    value: `×${risk.contradictionFactor.toFixed(2)}`,
                                    color: cContra,
                                  },
                                  {
                                    stageColor: cAdj,
                                    stageTip: tipAdj,
                                    stage: 'Adjusted Confidence',
                                    multiplier: '',
                                    multiplierColor: '#6e7681',
                                    formula: 'baseConfidence × contradictionFactor',
                                    detail: (
                                      <>
                                        <span style={{ color: cBase }}>Base Confidence (</span>
                                        <span style={{ color: cBase, fontWeight: 600 }} title={tipBase}>{risk.baseConfidence.toFixed(1)}</span>
                                        <span style={{ color: cBase }}>) </span>
                                        <span style={{ color: '#6e7681' }}>× </span>
                                        <span style={{ color: cContra }}>Contradiction (</span>
                                        <span style={{ color: cContra, fontWeight: 600 }} title={tipContra}>{risk.contradictionFactor.toFixed(2)}</span>
                                        <span style={{ color: cContra }}>)</span>
                                      </>
                                    ) as React.ReactNode,
                                    value: risk.adjustedConfidence.toFixed(1),
                                    color: cAdj,
                                  },
                                  {
                                    stageColor: cHotDep,
                                    stageTip: tipHot,
                                    stage: 'Hot Dependency',
                                    multiplier: `×${risk.hotDepFactor.toFixed(2)}`,
                                    multiplierColor: cHotDep,
                                    formula: '1 + min(topDependency% / 100, 0.30)',
                                    detail: (topDepTrafficPct > 0
                                      ? (<>
                                          <span style={{ color: '#6e7681' }}>1 + min(</span>
                                          <span style={{ color: cHotDep, fontWeight: 600 }}>{topDepTrafficPct.toFixed(1)}%</span>
                                          <span style={{ color: '#6e7681' }}> / 100, 0.30) = 1 + {Math.min(topDepTrafficPct / 100, 0.30).toFixed(3)}</span>
                                        </>)
                                      : detailsLoading && !detailsLoaded
                                        ? <span style={{ color: '#6e7681' }}>calculating…</span>
                                        : 'no dominant dependency → ×1.00') as React.ReactNode,
                                    value: `×${risk.hotDepFactor.toFixed(2)}`,
                                    color: cHotDep,
                                  },
                                  ...(topDeps[0] ? [{
                                    stageColor: '#6e7681',
                                    stageTip: `Top dependency by call volume: ${topDeps[0].name}${topDeps[0].target ? ` → ${topDeps[0].target}` : ''}`,
                                    stage: '↳ Top Dependency %',
                                    multiplier: '',
                                    multiplierColor: '#6e7681',
                                    formula: '',
                                    detail: (<>
                                      <span style={{ color: '#6e7681' }}>({topDeps[0].name} — {topDeps[0].totalCount.toLocaleString()} calls) / {feReqTotal.toLocaleString()} reqs = </span>
                                      <span style={{ color: cHotDep, fontWeight: 600 }}>{topDepTrafficPct.toFixed(1)}%</span>
                                    </>) as React.ReactNode,
                                    value: '',
                                    color: cHotDep,
                                  }] : []),
                                  {
                                    stageColor: cRetry,
                                    stageTip: tipRetry,
                                    stage: 'Retry Storm',
                                    multiplier: `×${risk.retryStormFactor.toFixed(2)}`,
                                    multiplierColor: cRetry,
                                    formula: '1 + min(max(ratio−3, 0) / 15, 0.25)',
                                    detail: (risk.depCallRatio > 0
                                      ? (<>
                                          <span style={{ color: '#6e7681' }}>1 + min(max(</span>
                                          <span style={{ color: cRetry, fontWeight: 600 }} title="Dependency Amplification Ratio: totalDependencies / totalRequests">{risk.depCallRatio.toFixed(1)}</span>
                                          <span style={{ color: '#6e7681' }}> − 3, 0) / 15, 0.25) = 1 + min({(Math.max(risk.depCallRatio - 3, 0) / 15).toFixed(3)}, 0.25)</span>
                                        </>)
                                      : 'no dependency call data → ×1.00') as React.ReactNode,
                                    value: `×${risk.retryStormFactor.toFixed(2)}`,
                                    color: cRetry,
                                  },
                                  {
                                    stageColor: '#6e7681',
                                    stageTip: `Total dependency calls vs total requests in the selected period`,
                                    stage: '↳ Dependency Amplification Ratio',
                                    multiplier: '',
                                    multiplierColor: '#6e7681',
                                    formula: '',
                                    detail: (<><span style={{ color: '#6e7681' }}>{(feInsight?.totalDependencies ?? 0).toLocaleString()} total dependency / {feReqTotal.toLocaleString()} total request = </span><span style={{ color: cRetry, fontWeight: 600 }}>{risk.depCallRatio.toFixed(1)}</span></>) as React.ReactNode,
                                    value: '',
                                    color: cRetry,
                                  },
                                ] as Array<{ stageColor: string; stageTip: string; stage: string; multiplier: string; multiplierColor: string; formula: string; detail: React.ReactNode; value: string; color: string }>).map((r, i) => (
                                  <div key={i} style={{ display: 'grid', gridTemplateColumns: stagesGrid, gap: 5, marginBottom: 3, paddingBottom: i === 1 ? 4 : 0, borderBottom: i === 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
                                    <span style={{ color: r.stageColor, fontWeight: 600 }} title={r.stageTip}>{r.stage}</span>
                                    <span style={{ color: r.multiplierColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{r.multiplier}</span>
                                    <span style={{ color: '#8b949e' }}>{r.formula}</span>
                                    <span style={{ color: '#6e7681' }}>{r.detail}</span>
                                    <span style={{ color: r.color, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} title={r.stageTip}>{r.value}</span>
                                  </div>
                                ))}
                                <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 'auto', paddingTop: 4, display: 'grid', gridTemplateColumns: stagesGrid, gap: 5, fontWeight: 700 }}>
                                  <span style={{ color: detailsLoading && !detailsLoaded ? '#6e7681' : cFinal }} title={tipFinal}>{detailsLoading && !detailsLoaded ? '—' : risk.label}</span>
                                  <span />
                                  <span />
                                  <span />
                                  <span style={{ color: detailsLoading && !detailsLoaded ? '#6e7681' : cFinal, textAlign: 'right' }} title={tipFinal}>{detailsLoading && !detailsLoaded ? 'calculating…' : `${risk.score.toFixed(1)} / 100`}</span>
                                </div>
                              </div>
                            );
                          })()}
                          </div>
                          </div>
                          {/* Section C: Severity guide */}
                          <div style={{ marginTop: 5, textAlign: 'right' }}>
                            <span style={{ color: '#3fb950' }}>0–20 Healthy</span>
                            <span style={{ color: '#6e7681' }}> · </span>
                            <span style={{ color: '#58a6ff' }}>21–40 Low</span>
                            <span style={{ color: '#6e7681' }}> · </span>
                            <span style={{ color: '#d29922' }}>41–60 Medium</span>
                            <span style={{ color: '#6e7681' }}> · </span>
                            <span style={{ color: '#e6773d' }}>61–80 High</span>
                            <span style={{ color: '#6e7681' }}> · </span>
                            <span style={{ color: '#f85149' }}>81–100 Critical</span>
                          </div>
                          {/* Section D: Port exhaustion diagnostics */}
                          {risk.score >= 81 && socketExc > 0 && (
                            <div style={{ color: '#f85149', marginTop: 4, fontWeight: 700 }}>🔴 Probable SNAT Port Exhaustion — socket exceptions detected with critical score</div>
                          )}
                          {risk.score >= 61 && risk.score < 81 && socketExc > 0 && (
                            <div style={{ color: '#e6773d', marginTop: 4 }}>⚠ SNAT port pressure detected — monitor socket exception trend</div>
                          )}
                          {risk.score >= 81 && socketExc === 0 && (
                            <div style={{ color: '#f85149', marginTop: 4 }}>🔴 Critical SNAT risk — check network connectivity and dependency health</div>
                          )}
                          {/* Section E: SNAT exception details */}
                          {count > 0 && (
                            <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
                              <div style={{ color: '#6e7681', marginBottom: 4, fontWeight: 600 }}>SNAT Exceptions ({count})</div>
                              {detailsLoading && !detailsLoaded
                                ? <span style={{ fontStyle: 'italic', color: 'var(--muted-foreground)' }}>Loading…</span>
                                : snatDetails.slice(0, 20).map((s, i) => (
                                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '45px 1fr 1fr', gap: 6, color: '#cdd9e5', marginBottom: 2 }}>
                                      <span style={{ color: '#6e7681' }}>{new Date(s.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.operation_Name || '—'}</span>
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#f85149' }}>{s.innermostMessage || s.outerMessage || '—'}</span>
                                    </div>
                                  ))
                              }
                            </div>
                          )}
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

          {hasApi && visibleBlocks.api && (
          <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1" style={{ tableLayout: 'fixed' }}><colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead>
              <tr className="text-muted-foreground font-bold">
                <td>API</td>
                <td></td>
                <td className="text-right">P99</td>
                <td className="text-right">Max</td>
              </tr>
            </thead>
            <tbody>
              {visibleBlocks.requests && apiHasInsights && (
                <>
                  <tr
                    style={{ cursor: 'pointer' }}
                    onClick={() => { setRequestsAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      Requests{requestsAPIExpanded ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
                    </td>
                    {(() => {
                      const ai = metrics.apiRequestInsights;
                      const total4xx = ai?.total4xx ?? 0;
                      const total5xx = ai?.total5xx ?? 0;
                      const reqTotal = ai?.insight?.totalRequests ?? 0;
                      const errTotal = total4xx + total5xx;
                      const pct = reqTotal > 0 ? (errTotal / reqTotal * 100) : 0;
                      const errColor = pct >= 10 ? '#f85149' : errTotal > 0 ? '#f97316' : '#3fb950';
                      return (
                        <>
                          <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                            <span style={{ color: total5xx > 0 ? '#f97316' : '#3fb950', fontSize: 10 }}>5xx - {total5xx.toLocaleString()}</span>
                          </td>
                          <td className="text-right" style={{ color: '#58a6ff' }}>
                            {ai?.insight?.requestP99 != null ? `${Math.round(ai.insight.requestP99)}ms` : '—'}
                          </td>
                          <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                            {errTotal > 0
                              ? <><span style={{ color: errColor, fontWeight: 400, fontSize: 10 }}>{errTotal.toLocaleString()} ({pct.toFixed(1)}%)</span><span style={{ color: '#58a6ff' }}> / {reqTotal.toLocaleString()}</span></>
                              : <span style={{ color: '#3fb950' }}>{reqTotal.toLocaleString()}</span>
                            }
                          </td>
                        </>
                      );
                    })()}
                  </tr>
                  {requestsAPIExpanded && (
                    <>
                      <tr>
                        <td colSpan={4} className="pb-1">
                          {detailsLoading && !detailsLoaded
                            ? <span className="text-[10px] text-muted-foreground italic">Loading details…</span>
                            : !metrics.apiRequestInsights
                            ? <span className="text-[10px] text-muted-foreground italic">Requires API App Insights Application ID in settings</span>
                            : metrics.apiRequestInsights.error
                              ? <span className="text-[10px] text-destructive">{metrics.apiRequestInsights.error}</span>
                              : (() => {
                                const ri = metrics.apiRequestInsights;
                                return (
                                  <div className="flex flex-col gap-1 pt-1">
                                    <div className="flex gap-0.5 flex-wrap">
                                      {(['highfreq', 'http4xx', 'http5xx', 'requests', 'bots'] as const).map(t => {
                                        const labels: Record<string, string> = { highfreq: 'High Freq', http4xx: 'HTTP 4xx', http5xx: 'HTTP 5xx', requests: 'Requests', bots: 'Bots' };
                                        const colors: Record<string, string> = { highfreq: '#a371f7', http4xx: '#f97316', http5xx: '#f85149', requests: '#58a6ff', bots: '#3fb950' };
                                        const c = colors[t];
                                        return (
                                          <button
                                            key={t}
                                            onClick={() => setRequestsAPITab(t)}
                                            style={{
                                              background: requestsAPITab === t ? `${c}22` : 'none',
                                              border: `1px solid ${requestsAPITab === t ? `${c}66` : 'transparent'}`,
                                              color: requestsAPITab === t ? c : 'var(--muted-foreground)',
                                              borderRadius: 4, padding: '1px 6px', fontSize: 9,
                                              cursor: 'pointer', fontWeight: requestsAPITab === t ? 600 : 400,
                                            }}
                                          >{labels[t]}</button>
                                        );
                                      })}
                                    </div>
                                    {requestsAPITab === 'requests' && (
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
                                    {requestsAPITab === 'highfreq' && (
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
                                    {requestsAPITab === 'http4xx' && (
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
                                    {requestsAPITab === 'http5xx' && (
                                      Array.isArray(ri.failed5xxUrls) && ri.failed5xxUrls.length > 0
                                        ? <div className="flex flex-col gap-0.5">
                                          {ri.failed5xxUrls.map((u, i) => (
                                            <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                              <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }} title={u.url}>{u.url}</span>
                                              <span className="flex-shrink-0 tabular-nums" style={{ color: '#484f58' }}>{u.totalCount > 0 ? `${(u.count / u.totalCount * 100).toFixed(1)}%` : '—'}</span>
                                              <span className="flex-shrink-0 tabular-nums" style={{ color: '#f85149' }}>{u.count.toLocaleString()}</span>
                                            </div>
                                          ))}
                                        </div>
                                        : <span className="text-[10px] text-muted-foreground italic">No 5xx captured in App Insights — may be logged with resultCode 0 or missing</span>
                                    )}
                                    {requestsAPITab === 'bots' && (
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
              {metrics.apiConnections != null && (() => {
                const a1 = apiConA1; const a2 = apiConA2;
                const diff = a2 - a1;
                const threshold = apiConHalfAvg(apiConPts) * 0.05;
                const trend = apiConPts.length < 2 ? null : diff > threshold ? '↑' : diff < -threshold ? '↓' : '→';
                const trendColor = trend === '↑' ? '#f85149' : '#3fb950';
                return (
                  <tr>
                    <td className="text-muted-foreground font-bold" title="Connections: active outbound TCP connections from the App Service instance(s), sourced from Azure Monitor AppConnections metric. Growing connection counts can indicate SNAT port accumulation or connection pool leaks.">Connections</td>
                    <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                      {trend
                        ? <span style={{ fontSize: 10, color: trendColor }}>Trend - {Math.round(a1)} {trend} {Math.round(a2)}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.apiConnections.p99)}</td>
                    <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.apiConnections.max)}</td>
                  </tr>
                );
              })()}
              {visibleBlocks.dependencies && apiHasInsights && metrics.apiRequestInsights && !metrics.apiRequestInsights.error && (() => {
                const apiInsight  = metrics.apiRequestInsights.insight;
                if (!apiInsight) return null;
                const depP99      = apiInsight.dependencyP99 ?? 0;
                const depTotal    = apiInsight.totalDependencies ?? 0;
                const depFailRate = apiInsight.dependencyFailureRate ?? 0;
                const topDeps     = metrics.apiRequestInsights.topDependencies ?? [];
                const failedDeps  = metrics.apiFailedDependencies ?? [];
                const hasDetail   = topDeps.length > 0 || failedDeps.length > 0 || apiInsight.totalDependencies > 0 || apiInsight.failedDependencies > 0;
                return (
                  <>
                    <tr
                      style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                      onClick={() => hasDetail && setDepsAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                      onMouseEnter={e => hasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="text-muted-foreground font-bold">
                        <span title="Dependencies: outbound calls made by the app to external services (SQL, HTTP APIs, storage, etc.), tracked by App Insights. Shows total call count, failure count, failure rate, and P99 latency. High failure or timeout rates are key CPI signals.">Dependencies</span>
                        {hasDetail && (depsAPIExpanded
                          ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                          : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        )}
                      </td>
                      <td className="text-right tabular-nums">
                        {(() => { const total = (metrics.apiRequestInsights?.dependencyTimeouts ?? []).reduce((s, d) => s + d.count, 0); return <span style={{ color: total > 0 ? '#f97316' : '#3fb950', fontSize: 10 }}>Timeout - {total}</span>; })()}
                      </td>
                      <td className="text-right tabular-nums" style={{ color: depP99 > 5000 ? '#f85149' : depP99 > 1000 ? '#d29922' : '#58a6ff' }}>
                        {depP99 > 0 ? `${Math.round(depP99).toLocaleString()}ms` : '—'}
                      </td>
                      <td className="text-right tabular-nums">
                        {depTotal > 0 ? (() => { const c = depFailRate >= 10 ? '#f85149' : depFailRate > 0 ? '#d29922' : '#3fb950'; return apiInsight.failedDependencies > 0
  ? <><span style={{ color: c, fontWeight: 400, fontSize: 10 }}>{apiInsight.failedDependencies.toLocaleString()} ({depFailRate.toFixed(1)}%)</span><span style={{ color: '#3fb950' }}> / {depTotal.toLocaleString()}</span></>
  : <span style={{ color: '#3fb950' }}>{depTotal.toLocaleString()}</span>; })() : '—'}
                      </td>
                    </tr>
                    {depsAPIExpanded && hasDetail && (
                      <>
                        {detailsLoading && !detailsLoaded && (
                          <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Loading details…</td></tr>
                        )}
                        {(!detailsLoading || detailsLoaded) && <tr>
                          <td colSpan={4} style={{ paddingTop: 4, paddingBottom: 2 }}>
                            <div className="flex gap-0.5">
                              {([
                                { key: 'topDeps',     label: 'Top Deps',     color: '#58a6ff' },
                                { key: 'failedDeps',  label: 'Failed Deps',  color: '#f85149' },
                                { key: 'timeoutDeps', label: 'Timeout Deps', color: '#f97316' },
                              ] as const).map(t => (
                                <button
                                  key={t.key}
                                  onClick={e => { e.stopPropagation(); setDepsAPITab(t.key); }}
                                  style={{
                                    background: depsAPITab === t.key ? `${t.color}22` : 'none',
                                    border: `1px solid ${depsAPITab === t.key ? `${t.color}66` : 'transparent'}`,
                                    color: depsAPITab === t.key ? t.color : 'var(--muted-foreground)',
                                    borderRadius: 4, padding: '1px 6px', fontSize: 9,
                                    cursor: 'pointer', fontWeight: depsAPITab === t.key ? 600 : 400,
                                  }}
                                >{t.label}</button>
                              ))}
                            </div>
                          </td>
                        </tr>}
                        {detailsLoaded && depsAPITab === 'topDeps' && (
                          topDeps.length === 0
                            ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No dependency data</td></tr>
                            : topDeps.map((d, i) => (
                              <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                                <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.name} → ${d.target}`}>{d.name || d.target}</td>
                                <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                                <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{d.p99.toLocaleString()}ms</td>
                                <td className="text-right tabular-nums">
                                  {d.totalCount > 0 ? (() => { const r = d.failCount / d.totalCount; const c = r >= 0.10 ? '#f85149' : d.failCount > 0 ? '#d29922' : '#3fb950'; return d.failCount > 0
  ? <><span style={{ color: c, fontWeight: 400, fontSize: 10 }}>{d.failCount.toLocaleString()} ({(r * 100).toFixed(1)}%)</span><span style={{ color: '#3fb950' }}> / {d.totalCount.toLocaleString()}</span></>
  : <span style={{ color: '#3fb950' }}>{d.totalCount.toLocaleString()}</span>; })() : '—'}
                                </td>
                              </tr>
                            ))
                        )}
                        {detailsLoaded && depsAPITab === 'timeoutDeps' && (() => {
                          const tDeps = (metrics.apiRequestInsights?.dependencyTimeouts ?? []).slice().sort((a, b) => b.count - a.count).slice(0, 10);
                          return tDeps.length === 0
                            ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No timeout dependencies</td></tr>
                            : <>{tDeps.map((d, i) => (
                              <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                                <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={d.name}>{d.name}</td>
                                <td className="text-right tabular-nums text-muted-foreground">—</td>
                                <td className="text-right tabular-nums text-muted-foreground">—</td>
                                <td className="text-right tabular-nums" style={{ color: '#f97316' }}>{d.count.toLocaleString()}</td>
                              </tr>
                            ))}</>;
                        })()}
                        {detailsLoaded && depsAPITab === 'failedDeps' && (
                          failedDeps.length === 0
                            ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No failed dependencies</td></tr>
                            : failedDeps.slice(0, 10).map((d, i) => (
                              <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                                <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.name} → ${d.target}`}>{d.name || d.target}</td>
                                <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                                <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{d.p99.toLocaleString()}ms</td>
                                <td className="text-right tabular-nums">
                                  {d.totalCount > 0 ? (() => { const r = d.failCount / d.totalCount; const c = r >= 0.10 ? '#f85149' : d.failCount > 0 ? '#d29922' : '#3fb950'; return d.failCount > 0
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
              {visibleBlocks.exceptions && apiHasInsights && metrics.apiRequestInsights && !metrics.apiRequestInsights.error && (() => {
                const apiErrorCount = metrics.apiRequestInsights.errorCount ?? 0;
                const apiErrorTypes = metrics.apiRequestInsights.errorTypes ?? [];
                const apiHasDetail  = apiErrorTypes.length > 0;
                const apiErrColor = apiErrorCount === 0 ? '#3fb950' : apiErrorCount <= 10 ? '#d29922' : '#f85149';
                const apiSocketExc = metrics.apiRequestInsights.insight?.socketExceptions ?? 0;
                return (
                  <>
                    <tr
                      style={{ cursor: apiHasDetail ? 'pointer' : 'default' }}
                      onClick={() => { if (apiHasDetail) { setErrAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setSelectedErrAPIType(null); } }}
                      onMouseEnter={e => apiHasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="text-muted-foreground font-bold">
                        <span title="Exceptions: unhandled application exceptions captured by App Insights, grouped by type. Includes socket exceptions (key CPI signal), SQL/HTTP errors, and general runtime failures. Expand to see breakdown by exception type and individual error details.">Exceptions</span>
                        {apiHasDetail && (errAPIExpanded
                          ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                          : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        )}
                      </td>
                      <td className="text-right tabular-nums" style={{ whiteSpace: 'nowrap' }}>
                        <span style={{ color: apiSocketExc > 10 ? '#f85149' : apiSocketExc > 0 ? '#f97316' : '#3fb950', fontSize: 10 }}>Socket - {apiSocketExc.toLocaleString()}</span>
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">—</td>
                      <td className="text-right tabular-nums" style={{ color: apiErrColor }}>{apiErrorCount.toLocaleString()}</td>
                    </tr>
                    {errAPIExpanded && apiHasDetail && detailsLoading && !detailsLoaded && (
                      <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Loading details…</td></tr>
                    )}
                    {errAPIExpanded && apiHasDetail && (!detailsLoading || detailsLoaded) && (
                      renderErrTypes(apiErrorTypes, metrics.apiRequestInsights!.errorDetails ?? [], selectedErrAPIType, setSelectedErrAPIType)
                    )}
                  </>
                );
              })()}
              {visibleBlocks.snatRisk && metrics.type !== 'containerapp' && apiHasInsights && metrics.apiRequestInsights && !metrics.apiRequestInsights.error && (() => {
                const snatDetails     = metrics.apiRequestInsights.snatDetails ?? [];
                const count           = snatDetails.length;
                const apiInsight      = metrics.apiRequestInsights.insight;
                const apiSocketExc    = apiInsight?.socketExceptions      ?? 0;
                const apiDepFailRate  = apiInsight?.dependencyFailureRate ?? 0;
                const apiDepTimeouts  = (metrics.apiRequestInsights.dependencyTimeouts ?? []).reduce((s, d) => s + d.count, 0);
                const apiDepP99Ms     = apiInsight?.dependencyP99         ?? 0;
                const api5xx          = metrics.apiRequestInsights.total5xx ?? 0;
                const apiReqTotal     = apiInsight?.totalRequests         ?? 0;
                const api5xxRate      = apiReqTotal > 0 ? (api5xx / apiReqTotal) * 100 : 0;
                const apiTopDeps      = metrics.apiRequestInsights.topDependencies ?? [];
                const apiTopDepTrafficPct = (apiTopDeps[0] && apiReqTotal > 0) ? (apiTopDeps[0].totalCount / apiReqTotal * 100) : 0;
                const apiThreadPoolStarvation = (metrics.apiRequestInsights.sqlHttpDetails ?? [])
                  .some(d => /thread.?pool|threadabort|starvation/i.test(d.innermostMessage + d.outerMessage));
                const risk = snatScore({
                  socketExceptions: apiSocketExc,
                  dependencyFailureRate: apiDepFailRate,
                  dependencyTimeouts: apiDepTimeouts,
                  dependencyP99Ms: apiDepP99Ms,
                  connectionBaseline: apiConA1,
                  connectionCurrent: apiConA2,
                  http5xxRate: api5xxRate,
                  cpuAvg: metrics.cpu.avg,
                  memoryAvg: metrics.memUnit === '%' ? +metrics.memory.avg : -1,
                  topDepTrafficPct: apiTopDepTrafficPct,
                  threadPoolStarvation: apiThreadPoolStarvation,
                  totalDependencies: apiInsight?.totalDependencies ?? 0,
                  totalRequests: apiReqTotal,
                });
                const subscores = [
                  { key: 'socket'  as const, label: 'Socket Exceptions',     raw: `${apiSocketExc}`,                 norm: risk.socketScore,     wt: 30, pts: 30 * risk.socketScore,     normFormulaRaw: `${apiSocketExc}`,                 normFormulaThreshold: '50 exceptions' },
                  { key: 'depFail' as const, label: 'Dependencies Failure',  raw: `${apiDepFailRate.toFixed(1)}%`,   norm: risk.depFailScore,    wt: 25, pts: 25 * risk.depFailScore,    normFormulaRaw: `${apiDepFailRate.toFixed(1)}%`,    normFormulaThreshold: '20% fail rate' },
                  { key: 'depTO'   as const, label: 'Dependencies Timeouts', raw: `${apiDepTimeouts}`,               norm: risk.depTimeoutScore, wt: 20, pts: 20 * risk.depTimeoutScore, normFormulaRaw: `${apiDepTimeouts}`,                normFormulaThreshold: '25 timeouts' },
                  { key: 'depP99'  as const, label: 'Dependencies P99',      raw: `${Math.round(apiDepP99Ms)}ms`,    norm: risk.depP99Score,     wt: 15, pts: 15 * risk.depP99Score,     normFormulaRaw: `${Math.round(apiDepP99Ms)}ms`,     normFormulaThreshold: '5000ms P99' },
                  { key: 'conn'    as const, label: 'Connection Growth',     raw: `+${Math.round(risk.connGrowth)}`, norm: risk.connGrowthScore, wt: 5,  pts: 5  * risk.connGrowthScore, normFormulaRaw: `${Math.round(risk.connGrowth)}`,   normFormulaThreshold: '64 new conns' },
                  { key: 'http5xx' as const, label: 'HTTP 5xx Rate',         raw: `${api5xxRate.toFixed(1)}%`,       norm: risk.http5xxScore,    wt: 5,  pts: 5  * risk.http5xxScore,    normFormulaRaw: `${api5xxRate.toFixed(1)}%`,        normFormulaThreshold: '5% error rate' },
                ];
                return (
                  <>
                    <tr
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSnatAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="text-muted-foreground font-bold">
                        <span title="Connection Pressure Index (CPI): measures the probability that SNAT port exhaustion or dependency connection pressure is contributing to failures. Combines socket exceptions, dependency failure rate, timeouts, P99 latency, connection growth, and HTTP 5xx rate into a normalized 0–100 confidence score.">Connection Pressure Index</span>
                        {snatAPIExpanded
                          ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                          : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        }
                      </td>
                      <td className="text-right tabular-nums" style={{ color: risk.color }}>{risk.score.toFixed(1)}</td>
                      <td className="text-right tabular-nums text-muted-foreground">—</td>
                      <td className="text-right tabular-nums" style={{ color: risk.color }}>{risk.label}</td>
                    </tr>
                    {snatAPIExpanded && (
                      <tr>
                        <td colSpan={4} style={{ paddingBottom: 8, paddingTop: 2 }}>
                          <div style={{ fontSize: 10, paddingLeft: 8, paddingRight: 8 }}>
                            <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
                            <div style={{ flex: '0 0 auto', minWidth: 320, display: 'flex', flexDirection: 'column' }}>
                            {/* Section A: Normalized subscores */}
                            <div style={{ display: 'grid', gridTemplateColumns: '130px 55px 120px 50px 35px auto', gap: 5, color: '#6e7681', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 3, marginBottom: 4 }}>
                              <span>Factor</span><span style={{ textAlign: 'right' }}>Raw Value</span><span style={{ paddingLeft: 8 }}>Formula</span><span style={{ textAlign: 'right' }}>Normalized</span><span style={{ textAlign: 'right' }}>Weight</span><span style={{ textAlign: 'right' }}>Points</span>
                            </div>
                            {subscores.map((b, i) => {
                              const cc = b.pts >= 12 ? '#f85149' : b.pts >= 6 ? '#e6773d' : b.pts > 0 ? '#d29922' : '#3fb950';
                              return (
                                <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 55px 120px 50px 35px auto', gap: 5, marginBottom: 3 }}>
                                  <span style={{ color: SNAT_FACTOR_COLORS[b.key], fontWeight: 600 }} title={SNAT_FACTOR_TIPS[b.key]}>{b.label}</span>
                                  <span style={{ color: '#8b949e', textAlign: 'right' }}>{b.raw}</span>
                                  <span style={{ color: '#6e7681', paddingLeft: 8 }}><em>{b.normFormulaRaw}</em> / <strong>{b.normFormulaThreshold}</strong></span>
                                  <span style={{ color: '#6e7681', textAlign: 'right' }}>{b.norm.toFixed(2)}</span>
                                  <span style={{ color: '#6e7681', textAlign: 'right' }}>{b.wt}%</span>
                                  <span style={{ color: cc, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{b.pts.toFixed(1)}</span>
                                </div>
                              );
                            })}
                            <div style={{ display: 'grid', gridTemplateColumns: '130px 55px 120px 50px 35px auto', gap: 5, marginTop: 'auto', paddingTop: 4, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                              <span style={{ color: '#e6edf3', fontWeight: 700 }} title="Base Confidence: weighted sum of the 6 normalized subscores × 100">Base Confidence</span>
                              <span />
                              <span />
                              <span />
                              <span />
                              <span style={{ color: '#e6edf3', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }} title="Base Confidence: Σ (weight × norm_score) × 100">{risk.baseConfidence.toFixed(1)}</span>
                            </div>
                            </div>
                            <div style={{ flex: 1, minWidth: 0, borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: 16 }}>
                            {/* Section B: Score stages */}
                            {(() => {
                              const stagesGrid = '130px 80px 200px 1fr 90px';
                              const cBase   = '#e6edf3';
                              const cContra = risk.contradictionFactor < 1 ? '#f97316' : '#3fb950';
                              const cAdj    = '#818cf8';
                              const cHotDep = '#fb923c';
                              const cRetry  = '#14b8a6';
                              const cFinal  = risk.color;
                              const tipBase   = 'Base Confidence: weighted sum of the 6 normalized subscores above, scaled to 0–100';
                              const tipContra = 'Contradiction Factor: penalty applied when high CPU, memory, or thread-pool starvation indicates the issue is NOT SNAT-related';
                              const tipAdj    = 'Adjusted Confidence: Base Confidence after applying Contradiction Factor';
                              const tipHot    = 'Hot Dependency Factor: amplifies score when one dependency dominates traffic (likely SNAT bottleneck candidate)';
                              const tipRetry  = 'Retry Storm Factor: amplifies score when dependency call volume far exceeds request volume (indicates retry loops)';
                              const tipFinal  = 'Final Score = Adjusted Confidence × Hot Dependency Factor × Retry Storm Factor (capped at 100)';
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                                  <div style={{ display: 'grid', gridTemplateColumns: stagesGrid, gap: 5, color: '#6e7681', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 3, marginBottom: 4 }}>
                                    <span>Stage</span><span>Factor</span><span>Formula</span><span>Detail (substituted values → result)</span><span style={{ textAlign: 'right' }}>Value</span>
                                  </div>
                                  {([
                                    {
                                      stageColor: cBase,
                                      stageTip: tipBase,
                                      stage: 'Base Confidence',
                                      multiplier: '',
                                      multiplierColor: '#6e7681',
                                      formula: '',
                                      detail: '' as React.ReactNode,
                                      value: risk.baseConfidence.toFixed(1),
                                      color: cBase,
                                    },
                                    {
                                      stageColor: cContra,
                                      stageTip: tipContra,
                                      stage: 'Contradiction',
                                      multiplier: `×${risk.contradictionFactor.toFixed(2)}`,
                                      multiplierColor: cContra,
                                      formula: 'CPU Avg>85%→×0.7 · Memory Avg>90%→×0.8 · ThreadPool→×0.6',
                                      detail: (
                                        <>
                                          <span style={{ color: CHART_COLORS.cpuAvg }} title="CPU Utilization (avg): shared App Service Plan resource — same value as FE">CPU Utilization (avg) </span>
                                          <span style={{ color: metrics.cpu.avg >= 0 ? (metrics.cpu.avg > 85 ? '#f97316' : CHART_COLORS.cpuAvg) : '#6e7681', fontWeight: 600 }} title="CPU Utilization (avg): shared App Service Plan resource">{metrics.cpu.avg >= 0 ? `${metrics.cpu.avg.toFixed(1)}%` : 'N/A'}</span>
                                          <span style={{ color: metrics.cpu.avg > 85 ? '#f97316' : '#6e7681' }}>{metrics.cpu.avg >= 0 ? (metrics.cpu.avg > 85 ? ' >85% → ×0.7' : ' ≤85% (none)') : ''}</span>
                                          <span style={{ color: '#6e7681' }}> · </span>
                                          <span style={{ color: CHART_COLORS.memAvg }} title="Memory Utilization (avg): shared App Service Plan resource — same value as FE">Memory Utilization (avg) </span>
                                          {(() => { const apiMemAvg = metrics.memUnit === '%' ? +metrics.memory.avg : -1; return (<><span style={{ color: apiMemAvg >= 0 ? (apiMemAvg > 90 ? '#f97316' : CHART_COLORS.memAvg) : '#6e7681', fontWeight: 600 }} title="Memory Utilization (avg): shared App Service Plan resource">{apiMemAvg >= 0 ? `${apiMemAvg.toFixed(1)}%` : 'N/A'}</span><span style={{ color: apiMemAvg > 90 ? '#f97316' : '#6e7681' }}>{apiMemAvg >= 0 ? (apiMemAvg > 90 ? ' >90% → ×0.8' : ' ≤90% (none)') : ''}</span></>); })()}
                                          <span style={{ color: '#6e7681' }}> · </span>
                                          <span style={{ color: '#a5b4fc' }} title="Thread Pool Starvation: detected by pattern-matching SNAT/SQL exception messages for ThreadPool/ThreadAbort/Starvation strings">Thread Pool Starvation </span>
                                          <span style={{ color: apiThreadPoolStarvation ? '#f97316' : '#6e7681', fontWeight: 600 }} title="Thread Pool Starvation indicator">{apiThreadPoolStarvation ? 'detected → ×0.6' : '(none)'}</span>
                                        </>
                                      ) as React.ReactNode,
                                      value: risk.contradictionReasons.length > 0 ? risk.contradictionReasons.join(', ') : 'None',
                                      color: cContra,
                                    },
                                    {
                                      stageColor: cAdj,
                                      stageTip: tipAdj,
                                      stage: 'Adjusted Confidence',
                                      multiplier: '',
                                      multiplierColor: '#6e7681',
                                      formula: 'baseConfidence × contradictionFactor',
                                      detail: (
                                        <>
                                          <span style={{ color: cBase }}>Base Confidence (</span>
                                          <span style={{ color: cBase, fontWeight: 600 }} title={tipBase}>{risk.baseConfidence.toFixed(1)}</span>
                                          <span style={{ color: cBase }}>) </span>
                                          <span style={{ color: '#6e7681' }}>× </span>
                                          <span style={{ color: cContra }}>Contradiction (</span>
                                          <span style={{ color: cContra, fontWeight: 600 }} title={tipContra}>{risk.contradictionFactor.toFixed(2)}</span>
                                          <span style={{ color: cContra }}>)</span>
                                        </>
                                      ) as React.ReactNode,
                                      value: risk.adjustedConfidence.toFixed(1),
                                      color: cAdj,
                                    },
                                    {
                                      stageColor: cHotDep,
                                      stageTip: tipHot,
                                      stage: 'Hot Dependency',
                                      multiplier: `×${risk.hotDepFactor.toFixed(2)}`,
                                      multiplierColor: cHotDep,
                                      formula: '1 + min(topDependency% / 100, 0.30)',
                                      detail: (apiTopDepTrafficPct > 0
                                        ? (<>
                                            <span style={{ color: '#6e7681' }}>1 + min(</span>
                                            <span style={{ color: cHotDep, fontWeight: 600 }}>{apiTopDepTrafficPct.toFixed(1)}%</span>
                                            <span style={{ color: '#6e7681' }}> / 100, 0.30) = 1 + {Math.min(apiTopDepTrafficPct / 100, 0.30).toFixed(3)}</span>
                                          </>)
                                        : detailsLoading && !detailsLoaded
                                          ? <span style={{ color: '#6e7681' }}>calculating…</span>
                                          : 'no dominant dependency → ×1.00') as React.ReactNode,
                                      value: `×${risk.hotDepFactor.toFixed(2)}`,
                                      color: cHotDep,
                                    },
                                    ...(apiTopDeps[0] ? [{
                                      stageColor: '#6e7681',
                                      stageTip: `Top dependency by call volume: ${apiTopDeps[0].name}${apiTopDeps[0].target ? ` → ${apiTopDeps[0].target}` : ''}`,
                                      stage: '↳ Top Dependency %',
                                      multiplier: '',
                                      multiplierColor: '#6e7681',
                                      formula: '',
                                      detail: (<>
                                        <span style={{ color: '#6e7681' }}>({apiTopDeps[0].name} — {apiTopDeps[0].totalCount.toLocaleString()} calls) / {apiReqTotal.toLocaleString()} reqs = </span>
                                        <span style={{ color: cHotDep, fontWeight: 600 }}>{apiTopDepTrafficPct.toFixed(1)}%</span>
                                      </>) as React.ReactNode,
                                      value: '',
                                      color: cHotDep,
                                    }] : []),
                                    {
                                      stageColor: cRetry,
                                      stageTip: tipRetry,
                                      stage: 'Retry Storm',
                                      multiplier: `×${risk.retryStormFactor.toFixed(2)}`,
                                      multiplierColor: cRetry,
                                      formula: '1 + min(max(ratio−3, 0) / 15, 0.25)',
                                      detail: (risk.depCallRatio > 0
                                        ? (<>
                                            <span style={{ color: '#6e7681' }}>1 + min(max(</span>
                                            <span style={{ color: cRetry, fontWeight: 600 }} title="Dependency Amplification Ratio: totalDependencies / totalRequests">{risk.depCallRatio.toFixed(1)}</span>
                                            <span style={{ color: '#6e7681' }}> − 3, 0) / 15, 0.25) = 1 + min({(Math.max(risk.depCallRatio - 3, 0) / 15).toFixed(3)}, 0.25)</span>
                                          </>)
                                        : 'no dependency call data → ×1.00') as React.ReactNode,
                                      value: `×${risk.retryStormFactor.toFixed(2)}`,
                                      color: cRetry,
                                    },
                                    {
                                      stageColor: '#6e7681',
                                      stageTip: `Total dependency calls vs total requests in the selected period`,
                                      stage: '↳ Dependency Amplification Ratio',
                                      multiplier: '',
                                      multiplierColor: '#6e7681',
                                      formula: '',
                                      detail: (<><span style={{ color: '#6e7681' }}>{(apiInsight?.totalDependencies ?? 0).toLocaleString()} total dependency / {apiReqTotal.toLocaleString()} total request = </span><span style={{ color: cRetry, fontWeight: 600 }}>{risk.depCallRatio.toFixed(1)}</span></>) as React.ReactNode,
                                      value: '',
                                      color: cRetry,
                                    },
                                  ] as Array<{ stageColor: string; stageTip: string; stage: string; multiplier: string; multiplierColor: string; formula: string; detail: React.ReactNode; value: string; color: string }>).map((r, i) => (
                                    <div key={i} style={{ display: 'grid', gridTemplateColumns: stagesGrid, gap: 5, marginBottom: 3, paddingBottom: i === 1 ? 4 : 0, borderBottom: i === 1 ? '1px solid rgba(255,255,255,0.08)' : 'none' }}>
                                      <span style={{ color: r.stageColor, fontWeight: 600 }} title={r.stageTip}>{r.stage}</span>
                                      <span style={{ color: r.multiplierColor, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{r.multiplier}</span>
                                      <span style={{ color: '#8b949e' }}>{r.formula}</span>
                                      <span style={{ color: '#6e7681' }}>{r.detail}</span>
                                      <span style={{ color: r.color, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} title={r.stageTip}>{r.value}</span>
                                    </div>
                                  ))}
                                  <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 'auto', paddingTop: 4, display: 'grid', gridTemplateColumns: stagesGrid, gap: 5, fontWeight: 700 }}>
                                    <span style={{ color: detailsLoading && !detailsLoaded ? '#6e7681' : cFinal }} title={tipFinal}>{detailsLoading && !detailsLoaded ? '—' : risk.label}</span>
                                    <span />
                                    <span />
                                    <span />
                                    <span style={{ color: detailsLoading && !detailsLoaded ? '#6e7681' : cFinal, textAlign: 'right' }} title={tipFinal}>{detailsLoading && !detailsLoaded ? 'calculating…' : `${risk.score.toFixed(1)} / 100`}</span>
                                  </div>
                                </div>
                              );
                            })()}
                            </div>
                            </div>
                            {/* Section C: Severity guide */}
                            <div style={{ marginTop: 5, textAlign: 'right' }}>
                              <span style={{ color: '#3fb950' }}>0–20 Healthy</span>
                              <span style={{ color: '#6e7681' }}> · </span>
                              <span style={{ color: '#58a6ff' }}>21–40 Low</span>
                              <span style={{ color: '#6e7681' }}> · </span>
                              <span style={{ color: '#d29922' }}>41–60 Medium</span>
                              <span style={{ color: '#6e7681' }}> · </span>
                              <span style={{ color: '#e6773d' }}>61–80 High</span>
                              <span style={{ color: '#6e7681' }}> · </span>
                              <span style={{ color: '#f85149' }}>81–100 Critical</span>
                            </div>
                            {/* Section D: Port exhaustion diagnostics */}
                            {risk.score >= 81 && apiSocketExc > 0 && (
                              <div style={{ color: '#f85149', marginTop: 4, fontWeight: 700 }}>🔴 Probable SNAT Port Exhaustion — socket exceptions detected with critical score</div>
                            )}
                            {risk.score >= 61 && risk.score < 81 && apiSocketExc > 0 && (
                              <div style={{ color: '#e6773d', marginTop: 4 }}>⚠ SNAT port pressure detected — monitor socket exception trend</div>
                            )}
                            {risk.score >= 81 && apiSocketExc === 0 && (
                              <div style={{ color: '#f85149', marginTop: 4 }}>🔴 Critical SNAT risk — check network connectivity and dependency health</div>
                            )}
                            {/* Section E: SNAT exception details */}
                            {count > 0 && (
                              <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
                                <div style={{ color: '#6e7681', marginBottom: 4, fontWeight: 600 }}>SNAT Exceptions ({count})</div>
                                {detailsLoading && !detailsLoaded
                                  ? <span style={{ fontStyle: 'italic', color: 'var(--muted-foreground)' }}>Loading…</span>
                                  : snatDetails.slice(0, 20).map((s, i) => (
                                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '45px 1fr 1fr', gap: 6, color: '#cdd9e5', marginBottom: 2 }}>
                                        <span style={{ color: '#6e7681' }}>{new Date(s.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}</span>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.operation_Name || '—'}</span>
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#f85149' }}>{s.innermostMessage || s.outerMessage || '—'}</span>
                                      </div>
                                    ))
                                }
                              </div>
                            )}
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


      </div>

      {visibleBlocks.remarks && (
        <div className="px-4 pt-3 pb-3" data-remarks>
          <AppRemarks metrics={metrics} rangeStart={rangeStart} rangeEnd={rangeEnd} visibleBlocks={visibleBlocks} urMonitors={urMonitors} />
        </div>
      )}

    </Card>
    </div>

    <RcaDialog
      open={rcaOpen}
      onOpenChange={setRcaOpen}
      title={resourceGroup || metrics.label}
      status={rcaStatus}
      markdown={rcaText}
      stages={rcaStages}
      error={rcaError}
      onExport={exportRca}
      onCopyTeams={copyRcaForTeams}
      onRetry={handleRunRca}
    />

    </>
  );
}
