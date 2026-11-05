import type { AppMetrics, CrashResult, ReleaseEvent, ReleaseResult, RestartResult } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { Hint } from '@/components/ui/hint';
import { RELEASE_COLORS, UI } from '@/lib/chart-colors';
import { HTTP_5XX_RATE, httpRateBuckets } from './appRemarks';
import { buildExtras, detectCorrelatedAnomalies, errorRateSeries, groupAnomalyEpisodes, inferSeriesStepMs, type AnomalySeverity } from './anomalyDetection';
import { causeColor, restartEvents } from './restartSection';
import { releaseTitle } from './releaseMarkers';
import { formatSgt } from './rcaHtml';

export interface TimelineItem {
  startMs: number;
  /** Absent for a point event (a release, a restart, a crash). */
  endMs?: number;
  title: string;
  color: string;
  /** Set on release marks, so a click can open the Release Verdict for that release. */
  release?: { site: 'fe' | 'api'; event: ReleaseEvent };
  /** Set on 5xx bursts: which site's requests to list when it is clicked. */
  burstSite?: 'fe' | 'api';
  /** Structured facts for the remark story, so it never parses `title`. */
  site?: 'fe' | 'api';
  /** 5xx bursts: the peak rate (0..1). Anomalies: 'Critical' | 'Warning'. */
  peak?: number;
  severity?: 'Critical' | 'Warning';
  /** Restarts: how many in this bucket, and why. Crashes: the exception type. */
  count?: number;
  cause?: string;
}

export interface TimelineLane {
  key: 'releases' | 'restarts' | 'crashes' | 'downtime' | 'anomalies' | 'http5xx' | 'http5xxApi';
  label: string;
  items: TimelineItem[];
}

export interface TimelineInput {
  startMs: number;
  endMs: number;
  metrics: AppMetrics;
  hasApi: boolean;
  releases?: ReleaseResult | null | undefined;
  apiReleases?: ReleaseResult | null | undefined;
  restarts?: RestartResult | null | undefined;
  apiRestarts?: RestartResult | null | undefined;
  crashes?: CrashResult | null | undefined;
  apiCrashes?: CrashResult | null | undefined;
  urMonitors?: UptimeRobotMonitor[] | undefined;
}

const SEVERITY_COLOR: Record<Exclude<AnomalySeverity, 'Info'>, string> = { Critical: UI.error, Warning: UI.warning };

const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60000))} min`;
const span = (a: number, b: number) => `${formatSgt(a)} → ${formatSgt(b)} (${mins(b - a)})`;

/** Contiguous bad buckets as one interval each, so a 20-minute burst is one bar, not 20. */
function mergeBuckets(starts: number[], stepMs: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const s of [...starts].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, s + stepMs);
    else out.push({ start: s, end: s + stepMs });
  }
  return out;
}

/** Every event source on the card as lanes over [startMs, endMs]. Pure; exported for tests. */
export function buildTimelineLanes(input: TimelineInput): TimelineLane[] {
  const { startMs, endMs, metrics, hasApi } = input;
  // A point is in range when it falls inside; an interval when it overlaps — clipped to the range.
  const inRange = (it: TimelineItem): TimelineItem | null => {
    if (!Number.isFinite(it.startMs)) return null;
    if (it.endMs == null) return it.startMs >= startMs && it.startMs <= endMs ? it : null;
    if (it.endMs < startMs || it.startMs > endMs) return null;
    return { ...it, startMs: Math.max(it.startMs, startMs), endMs: Math.min(it.endMs, endMs) };
  };
  const sites = (hasApi ? ['fe', 'api'] : ['fe']) as Array<'fe' | 'api'>;
  const siteTag = (site: 'fe' | 'api') => (hasApi ? `${site === 'fe' ? 'FE' : 'API'} · ` : '');

  const releases = sites.flatMap(site =>
    ((site === 'fe' ? input.releases : input.apiReleases)?.events ?? []).map((event): TimelineItem => ({
      startMs: Date.parse(event.at),
      site,
      title: `${siteTag(site)}${releaseTitle(event)}`,
      color: RELEASE_COLORS[site],
      release: { site, event },
    })));

  const restarts = sites.flatMap(site =>
    restartEvents(site === 'fe' ? input.restarts : input.apiRestarts)
      .filter(ev => !ev.undated && ev.t)
      .map((ev, i): TimelineItem => ({
        startMs: Date.parse(ev.t),
        title: `${siteTag(site)}${formatSgt(Date.parse(ev.t))} · ${ev.count}× ${ev.cause}${ev.instance ? ` on ${ev.instance}` : ''}`,
        color: causeColor(ev.cause, i),
        site, count: ev.count, cause: ev.cause,
      })));

  const crashes = sites.flatMap(site =>
    ((site === 'fe' ? input.crashes : input.apiCrashes)?.events ?? []).map((ev): TimelineItem => ({
      startMs: Date.parse(ev.t),
      title: `${siteTag(site)}${formatSgt(Date.parse(ev.t))} · ${ev.exceptionType ?? ev.category} (exit ${ev.exitCode})`,
      color: UI.error,
      site, cause: ev.exceptionType ?? ev.category,
    })));

  // UptimeRobot watches from outside Azure, so it is the reference; Azure's own
  // detected downtime only fills in when no monitor is configured — same rule as the RCA.
  const urDown = (input.urMonitors ?? []).flatMap(mon =>
    (mon.logs ?? []).filter(l => l.type === 1).map((l): TimelineItem => {
      const s = l.datetime * 1000, e = (l.datetime + l.duration) * 1000;
      return { startMs: s, endMs: e, color: UI.error, title: `${mon.friendly_name} down · ${span(s, e)}${l.reason?.detail ? `\n${l.reason.detail}` : ''}` };
    }));
  const downtime = urDown.length ? urDown : (metrics.availability?.downtimeIntervals ?? []).map((iv): TimelineItem => ({
    startMs: iv.start, endMs: iv.end, color: UI.error,
    title: `Azure availability down · ${span(iv.start, iv.end)}${iv.cause ? `\n${iv.cause}` : ''}`,
  }));

  const cpuSeries = metrics.cpu?.series ?? [];
  const anomalies = cpuSeries.length
    ? groupAnomalyEpisodes(detectCorrelatedAnomalies(metrics.cpu, buildExtras(metrics)), inferSeriesStepMs(cpuSeries))
      // Info is a CPU-only blip ("probably a batch job") — the Anomaly section doesn't list it either.
      .filter(ep => ep.peakSeverity !== 'Info')
      .map((ep): TimelineItem => {
        const s = Date.parse(ep.startT);
        const e = Math.max(Date.parse(ep.endT), s + inferSeriesStepMs(cpuSeries));
        const peaks = Object.entries(ep.peakValues).map(([k, v]) => `${k} ${Math.round(v)}%`).join(', ');
        return { startMs: s, endMs: e, severity: ep.peakSeverity as 'Critical' | 'Warning', cause: ep.metricsInvolved.join(' + '), color: SEVERITY_COLOR[ep.peakSeverity as 'Critical' | 'Warning'], title: `${ep.peakSeverity} · ${ep.metricsInvolved.join(' + ')} · ${span(s, e)}${peaks ? `\nPeak ${peaks}` : ''}` };
      })
    : [];

  // Per site, from each site's own App Insights request timeline (true 5xx per bucket).
  // The frontend falls back to the card's 5xx series when App Insights has no timeline.
  const siteRates = (site: 'fe' | 'api'): { rates: Array<{ t: string; rate: number }>; stepMs: number } => {
    const overall = (site === 'fe' ? metrics.requestInsights : metrics.apiRequestInsights)?.performance?.overallSeries;
    if (overall?.length) {
      return { rates: errorRateSeries(overall, 'c5').map(p => ({ t: p.t, rate: p.v / 100 })), stepMs: inferSeriesStepMs(overall) };
    }
    if (site === 'api') return { rates: [], stepMs: 0 };
    return { rates: httpRateBuckets(metrics.failedRequestsSeries, metrics.requestsSeries), stepMs: inferSeriesStepMs(metrics.requestsSeries ?? []) };
  };
  const bursts = (site: 'fe' | 'api'): TimelineItem[] => {
    const { rates, stepMs } = siteRates(site);
    const badStarts = rates.filter(r => r.rate > HTTP_5XX_RATE).map(r => Date.parse(r.t));
    const peakIn = (s: number, e: number) => Math.max(...rates.filter(r => { const t = Date.parse(r.t); return t >= s && t < e; }).map(r => r.rate));
    return mergeBuckets(badStarts, stepMs).map((iv): TimelineItem => ({
      startMs: iv.start, endMs: iv.end, color: UI.error, burstSite: site, site, peak: peakIn(iv.start, iv.end),
      title: `${siteTag(site)}5xx above ${HTTP_5XX_RATE * 100}% · ${span(iv.start, iv.end)}\nPeak ${(peakIn(iv.start, iv.end) * 100).toFixed(1)}%`,
    }));
  };

  const lanes: TimelineLane[] = [
    { key: 'releases', label: 'Releases', items: releases },
    { key: 'restarts', label: 'Restarts', items: restarts },
    { key: 'crashes', label: 'Crashes', items: crashes },
    { key: 'downtime', label: 'Downtime', items: downtime },
    { key: 'anomalies', label: 'Anomalies', items: anomalies },
    { key: 'http5xx', label: hasApi ? 'FE 5xx' : '5xx bursts', items: bursts('fe') },
    ...(hasApi ? [{ key: 'http5xxApi' as const, label: 'API 5xx', items: bursts('api') }] : []),
  ];
  return lanes.map(l => ({ ...l, items: l.items.map(inRange).filter((x): x is TimelineItem => x != null) }));
}

const LANE_H = 18;

export function IncidentTimeline({ lanes, startMs, endMs, onReleaseClick, onBurstClick }: {
  lanes: TimelineLane[];
  startMs: number;
  endMs: number;
  onReleaseClick?: ((site: 'fe' | 'api', event: ReleaseEvent) => void) | undefined;
  /** A 5xx burst was clicked: its (range-clipped) window. */
  onBurstClick?: ((startMs: number, endMs: number, site: 'fe' | 'api') => void) | undefined;
}) {
  const shown = lanes.filter(l => l.items.length);
  if (!shown.length) return <div className="text-xs text-muted-foreground">No events in this window.</div>;
  const total = Math.max(1, endMs - startMs);
  const pct = (ms: number) => ((ms - startMs) / total) * 100;

  return (
    <div className="flex flex-col gap-1">
      {shown.map(lane => (
        <div key={lane.key} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{lane.label} <span className="tabular-nums">({lane.items.length})</span></span>
          <div className="relative rounded-sm bg-muted/40" style={{ height: LANE_H }}>
            {lane.items.map((it, i) => {
              const left = pct(it.startMs);
              const isPoint = it.endMs == null;
              const isBurst = !!it.burstSite && it.endMs != null && !!onBurstClick;
              const clickable = !!(it.release && onReleaseClick) || isBurst;
              const onClick = () => (isBurst ? onBurstClick!(it.startMs, it.endMs!, it.burstSite!) : onReleaseClick!(it.release!.site, it.release!.event));
              const hint = isBurst ? 'Click to list the 5xx requests' : 'Click for the release verdict';
              const tip = <div className="whitespace-pre-line text-left">{it.title}{clickable ? `\n\n${hint}` : ''}</div>;
              return (
                <div
                  key={i}
                  className="absolute top-0 h-full"
                  style={isPoint
                    ? { left: `${left}%`, transform: 'translateX(-50%)' }
                    : { left: `${left}%`, width: `max(4px, ${pct(it.endMs!) - left}%)` }}
                >
                  <Hint label={tip} delayDuration={100} className="h-full w-full">
                    {clickable ? (
                      <button
                        type="button"
                        aria-label={`${hint}: ${it.title.split('\n')[0]}`}
                        onClick={onClick}
                        className={`block h-full cursor-pointer rounded-sm hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${isPoint ? 'w-2' : 'w-full opacity-80'}`}
                        style={{ background: it.color }}
                      />
                    ) : (
                      <span
                        className={`block h-full cursor-help rounded-sm ${isPoint ? 'w-1.5' : 'w-full opacity-80'}`}
                        style={{ background: it.color }}
                      />
                    )}
                  </Hint>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="grid grid-cols-[5.5rem_1fr] gap-2 text-[10px] tabular-nums text-muted-foreground">
        <span />
        <div className="flex justify-between"><span>{formatSgt(startMs)}</span><span>{formatSgt(endMs)}</span></div>
      </div>
    </div>
  );
}
