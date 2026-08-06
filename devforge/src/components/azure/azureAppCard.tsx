import React, { useState, useEffect, useCallback } from 'react';
import { Share2, ChevronDown, ChevronRight, Sparkles, SlidersHorizontal, ScanSearch } from 'lucide-react';
import { marked } from 'marked';
import { toast } from 'sonner';
import { RcaDialog, type RcaStatus } from './rcaDialog';
import { RcaSection } from './rcaSection';
import {
  buildRcaPrintHtml, buildRcaWordHtml, formatSgt, formatSgtRange, splitQuickSummary,
  buildQuickSummaryTeamsHtml, buildQuickSummaryTeamsText,
} from './rcaHtml';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import type { AppMetrics, SocketInsights, TimeoutInsights, OomInsights, SocketCounters, RestartResult, ExceptionLocationSeries, ExceptionSiteRow } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CombinedChart, MetricLegend, InstanceHealthChart, CHART_COLORS, INSTANCE_PALETTE } from './azureMetricChart';
import { AppRemarks, buildRemarks } from './azureAppRemarks';
import { SnatPortsRows } from './snatPortSection';
import { RestartRows } from './restartSection';
import { PerformanceRows } from './performanceSection';
import { UserRows } from './userSection';
import { ExceptionLocationChart } from './exceptionLocationChart';
import { ExceptionSiteTable } from './exceptionSiteTable';
import { SkeletonBlock, ListSkeletonRow } from './loadingSkeleton';
import type { EndpointDepsState } from '@/hooks/useAzureMetrics';
import { useCopyElementAsImage, loadHtml2Canvas } from '@/hooks/useCopyElementAsImage';
import { useUptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { useIpReputation } from '@/hooks/useIpReputation';


// ─── Exception tabs: Unclassified / Timeout / Socket / OOM ───────────────────

// Three mutually exclusive buckets — see SOCKET_MATCH / TIMEOUT_ONLY_MATCH /
// GENERIC_MATCH in electron/ipc/azure-metrics.cjs. Counts sum to the row total.
const EXC_TABS = [
  // 'generic' is the internal key, matching GENERIC_MATCH / errorTypesGeneric in
  // the query layer; the label says what it means to a reader.
  { key: 'generic', label: 'Unclassified', color: '#f85149' },
  { key: 'timeout', label: 'Timeout', color: '#d29922' },
  { key: 'socket',  label: 'Socket',  color: '#06b6d4' },
  { key: 'oom',     label: 'OOM',     color: '#a371f7' },
] as const;
type ExcTab = typeof EXC_TABS[number]['key'];

const SOCKET_ACCENT  = '#06b6d4';
const TIMEOUT_ACCENT = '#d29922';

export const getMeaningfulFrame = (raw: string) => {
  try {
    const frames = JSON.parse(raw) as Array<{ assembly?: string; fileName?: string; line?: number; method?: string }>;
    return frames.find(f => {
      const asm = f.assembly ?? '';
      return asm && !asm.startsWith('System.') && !asm.startsWith('Microsoft.') && !asm.startsWith('mscorlib') && !asm.startsWith('netstandard');
    }) ?? frames[0] ?? null;
  } catch { return null; }
};

/** Exact per-bucket counts. `insight` carries them for the whole window, so the
 *  total is not truncated the way `errorCount` (top 10 types only) is, and the
 *  three tab counts always sum to the total shown on the row. */
function excBucketCounts(ri: {
  insight?: { socketLayerExceptions: number; timeoutExceptions: number; oomExceptions: number; genericExceptions: number; totalExceptions: number } | null
  errorTypesGeneric?: Array<{ count: number; trueCount?: number }> | null
  errorTypes?: Array<{ count: number; trueCount?: number }> | null
  errorCount?: number | null
} | null | undefined): Record<ExcTab, number | null> & { total: number; breakdown: string } {
  const ins = ri?.insight;
  if (ins && ins.totalExceptions > 0) {
    return {
      generic: ins.genericExceptions,
      timeout: ins.timeoutExceptions,
      socket:  ins.socketLayerExceptions,
      oom:     ins.oomExceptions,
      total:   ins.totalExceptions,
      breakdown: `${ins.totalExceptions.toLocaleString()} exceptions = ${ins.genericExceptions.toLocaleString()} unclassified + ${ins.timeoutExceptions.toLocaleString()} timeout + ${ins.socketLayerExceptions.toLocaleString()} socket + ${ins.oomExceptions.toLocaleString()} OOM`,
    };
  }
  // Pre-split cache: only the truncated type lists are available.
  const list = ri?.errorTypesGeneric ?? ri?.errorTypes ?? [];
  const generic = list.reduce((s, t) => s + (t.trueCount ?? t.count), 0);
  const total = ri?.errorCount ?? generic;
  return { generic, timeout: null, socket: null, oom: null, total, breakdown: 'Bucket breakdown unavailable — refresh to load it.' };
}

/** The throw-site chart as a table row, sitting between the tab strip and the
 *  tab's own content. Filtering by bucket happens here so one payload — every
 *  bucket's sites in one list — serves all four tabs without a refetch. */
function ExcLocationChartRow({ sites, bucket, bin, topN, error, syncId }: {
  sites: ExceptionLocationSeries[] | null | undefined;
  bucket: ExcTab;
  bin?: string | null | undefined;
  topN?: number | null | undefined;
  error?: string | null | undefined;
  syncId?: string | undefined;
}) {
  const forBucket = (sites ?? []).filter(s => s.bucket === bucket);
  // A failed query says so instead of rendering nothing — an absent chart would
  // otherwise read as "this bucket has no exceptions", which the tab count next
  // to it plainly contradicts.
  if (!forBucket.length) {
    if (!error) return null;
    return (
      <tr>
        <td colSpan={4} style={{ paddingLeft: 20, paddingTop: 2, paddingBottom: 2, fontSize: 9, color: '#d29922' }}>
          Throw-site chart unavailable: {error}
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td colSpan={4} style={{ paddingTop: 0, paddingBottom: 0 }}>
        <ExceptionLocationChart sites={forBucket} bin={bin} topN={topN} syncId={syncId} />
      </td>
    </tr>
  );
}

function ExcTabRow({ value, onChange, counts }: {
  value: ExcTab;
  onChange: (v: ExcTab) => void;
  counts: Record<ExcTab, number | null>;
}) {
  return (
    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
      <td colSpan={4} style={{ paddingLeft: 20, paddingTop: 4, paddingBottom: 4 }}>
        <div className="flex gap-0.5 flex-wrap">
          {EXC_TABS.map(t => {
            const cnt = counts[t.key];
            const active = value === t.key;
            return (
              <button
                key={t.key}
                onClick={e => { e.stopPropagation(); onChange(t.key); }}
                style={{
                  background: active ? `${t.color}22` : 'none',
                  border: `1px solid ${active ? `${t.color}66` : 'transparent'}`,
                  color: active ? t.color : 'var(--muted-foreground)',
                  borderRadius: 4, padding: '1px 6px', fontSize: 9,
                  cursor: 'pointer', fontWeight: active ? 600 : 400,
                }}
              >
                {t.label}{cnt != null ? <span style={{ opacity: 0.7 }}> ({cnt.toLocaleString()})</span> : null}
              </button>
            );
          })}
        </div>
      </td>
    </tr>
  );
}

/** TimeWait vs Established ratio is the definitive "sockets are not pooled" signal. */
function socketMetricVerdict(counters: SocketCounters | null | undefined) {
  const sm = counters?.metrics;
  if (!sm?.length) return null;
  const pick = (n: string) => sm.find(m => m.name === n) ?? null;
  const est = pick('SocketOutboundEstablished') ?? pick('TcpEstablished');
  const tw  = pick('SocketOutboundTimeWait')    ?? pick('TcpTimeWait');
  if (!est || !tw) return null;
  if (est.avg <= 0 && tw.avg <= 0) return null;
  const ratio = est.avg > 0 ? tw.avg / est.avg : Infinity;
  if (ratio >= 2)   return { ratio, color: '#f85149', text: 'TimeWait ≫ Established — outbound sockets are closed and re-opened per call, not pooled. Root cause is client lifetime (new HttpClient/connection per request), not load.' };
  if (ratio >= 0.5) return { ratio, color: '#d29922', text: 'Elevated TimeWait against Established — partial socket reuse. Connection churn is consuming SNAT ports faster than they are released.' };
  return { ratio, color: '#3fb950', text: 'TimeWait low against Established — outbound sockets are being reused. No pooling defect visible in the counters.' };
}

const SOCKET_METRIC_HELP: Record<string, string> = {
  SocketOutboundAll:         'All outbound sockets from this site. Sustained growth against a flat request rate means sockets are leaking.',
  SocketOutboundEstablished: 'Outbound sockets in ESTABLISHED state — connections actively in use.',
  SocketOutboundTimeWait:    'Outbound sockets in TIME_WAIT — closed but still holding their SNAT port (~4 min on Azure). High values here exhaust ports.',
  TcpEstablished:            'TCP connections in ESTABLISHED state.',
  TcpTimeWait:               'TCP connections in TIME_WAIT — port still reserved after close.',
  TcpCloseWait:             'TCP connections in CLOSE_WAIT — remote closed, local app never did. Indicates undisposed clients/streams.',
  TcpSynSent:                'TCP connections stuck in SYN_SENT — handshake never completed. Spikes here mean the port budget or the destination is refusing.',
};

function SocketSection({ label, title, children }: { label: string; title?: string | undefined; children: React.ReactNode }) {
  return (
    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.03)', fontSize: 9 }}>
      <td colSpan={4} style={{ paddingLeft: 24, paddingTop: 4, paddingBottom: 4 }}>
        {label !== '' && <div style={{ color: '#6e7681', fontWeight: 600, marginBottom: 3 }} title={title}>{label}</div>}
        {children}
      </td>
    </tr>
  );
}

function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <span style={{ display: 'inline-block', width: 46, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, flexShrink: 0 }}>
      <span style={{ display: 'block', width: `${Math.max(2, Math.min(100, pct))}%`, height: '100%', background: color, borderRadius: 2 }} />
    </span>
  );
}

/** Durations in the largest unit that keeps the number readable, so a 19,464ms P99
 *  reads as 19.5s and a 2,128,617ms Cloudflare timeout as 35.5m rather than a wall
 *  of digits. Input is always milliseconds. */
export const fmtDuration = (ms: number | null | undefined): string => {
  if (ms == null || !isFinite(ms)) return '—';
  if (ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  // Trim a trailing .0 so whole values read "5m", not "5.0m".
  const n = (v: number) => v.toFixed(1).replace(/\.0$/, '');
  const s = ms / 1000;
  if (s < 60) return `${n(s)}s`;
  const m = s / 60;
  if (m < 60) return `${n(m)}m`;
  const h = m / 60;
  if (h < 24) return `${n(h)}h`;
  return `${n(h / 24)}d`;
};

/** Share of a total. Avoids rendering a real-but-tiny rate as a flat "0.0%". */
const fmtPct = (n: number, total: number) => {
  if (total <= 0) return '—';
  const p = (n / total) * 100;
  if (p === 0) return '0%';
  return p < 0.1 ? '<0.1%' : `${p.toFixed(1)}%`;
};

/** Names the layer that timed out, from the exception type. Drives the fix hint and
 *  the section heading — when every record shares one layer the heading says which,
 *  so `heading` replaces a separate layer chip rather than repeating it. */
export function timeoutLayer(type: string): { layer: string; heading: string; hint: string } {
  const t = type.toLowerCase();
  if (t.includes('sqlexception') || t.includes('win32exception')) return { layer: 'SQL',    heading: 'SQL command timeouts',   hint: 'Command timeout — tune the query or add an index. Raising CommandTimeout only moves the wall.' };
  if (t.includes('redis'))                                        return { layer: 'Redis',  heading: 'Redis timeouts',          hint: 'Redis did not answer in time — check cache CPU, large payloads, and the sync-op vs backlog split.' };
  if (t.includes('taskcanceled') || t.includes('httprequest'))    return { layer: 'HTTP',   heading: 'HTTP client timeouts',    hint: 'HttpClient.Timeout elapsed — downstream is slow. Verify the deadline is realistic before raising it.' };
  if (t.includes('operationcanceled'))                            return { layer: 'Cancel', heading: 'Cancelled operations',    hint: 'Operation cancelled on a deadline — confirm whether the token came from a timeout or a client disconnect.' };
  if (t.includes('timeoutexception'))                             return { layer: 'App',    heading: 'Application timeouts',    hint: 'Explicit timeout in application code — check the configured deadline against real downstream latency.' };
  return { layer: '—', heading: 'Application timeouts', hint: '' };
}

function renderTimeoutTab(
  ti: TimeoutInsights | null | undefined,
  fmtTime: (iso: string) => string,
): React.ReactNode {
  const summary  = ti?.summary ?? null;
  const types    = ti?.types ?? [];
  const details  = ti?.details ?? [];
  const timeline = ti?.timeline ?? [];
  const byEndpoint = ti?.byEndpoint ?? [];

  if (!ti) {
    return <tr style={{ fontSize: 9 }}><td colSpan={4} style={{ paddingLeft: 24, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Timeout breakdown unavailable — expand the card to load details.</td></tr>;
  }
  if ((summary?.trueCount ?? 0) === 0 && types.length === 0) {
    return <tr style={{ fontSize: 9 }}><td colSpan={4} style={{ paddingLeft: 24, color: '#3fb950', paddingBottom: 4 }}>No application-level timeouts in this window.</td></tr>;
  }

  const samplingX = summary && summary.records > 0 ? summary.trueCount / summary.records : 1;

  // Burst vs sustained. No longer a visible line — the headline it lived on was
  // redundant with the table — so it rides on the section label's tooltip.
  const tlNonZero  = timeline.filter(p => p.count > 0).length;
  const tlMax      = Math.max(1, ...timeline.map(p => p.count));
  const tlPeak     = timeline.find(p => p.count === tlMax) ?? null;
  const burstLabel = timeline.length > 1
    ? (tlNonZero / timeline.length <= 0.25
        ? `Burst: ${tlNonZero} of ${timeline.length} time buckets active, peak ${tlMax.toLocaleString()}${tlPeak ? ` at ${fmtTime(tlPeak.t)}` : ''}.`
        : `Sustained across ${tlNonZero} of ${timeline.length} time buckets.`)
    : null;

  // Endpoint groups. Counts and windows come from byEndpoint (exact, whole
  // window); the message/type/stack frame come from the capped detail records and
  // are simply absent for endpoints outside the 50 newest.
  const endpointGroups = (() => {
    const firstDetail = new Map<string, { d: typeof details[number]; sampled: number }>();
    for (const d of details) {
      const key = d.operation_Name || '(unknown endpoint)';
      const ex = firstDetail.get(key);
      if (ex) ex.sampled++; else firstDetail.set(key, { d, sampled: 1 });
    }
    // Fall back to the sampled grouping when byEndpoint is missing (older cache).
    const base = byEndpoint.length > 0
      ? byEndpoint.map(e => ({ endpoint: e.endpoint, count: e.trueCount, firstSeen: e.firstSeen, lastSeen: e.lastSeen }))
      : Array.from(firstDetail.entries()).map(([endpoint, { sampled }]) => ({
          endpoint, count: Math.round(sampled * samplingX), firstSeen: '', lastSeen: '',
        }));
    return base
      .map(b => ({ ...b, detail: firstDetail.get(b.endpoint)?.d ?? null }))
      .sort((a, b) => b.count - a.count);
  })();
  const hiddenEndpoints = Math.max(0, (summary?.operations ?? 0) - endpointGroups.length);

  return (
    <>
      {/* By layer only when more than one — the exception column covers the single-layer case */}
      {types.length > 1 && (
        <SocketSection label="By layer">
          {types.map((t, i) => {
            const { layer } = timeoutLayer(t.type);
            const pct = types[0]!.trueCount > 0 ? (t.trueCount / types[0]!.trueCount) * 100 : 0;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
                <span style={{ color: TIMEOUT_ACCENT, width: 44, flexShrink: 0 }}>{layer}</span>
                <span style={{ color: '#cdd9e5', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.type}>{t.type}</span>
                <MiniBar pct={pct} color={TIMEOUT_ACCENT} />
                <span className="tabular-nums" style={{ color: '#f85149', width: 52, textAlign: 'right', flexShrink: 0 }}>{t.trueCount.toLocaleString()}</span>
              </div>
            );
          })}
        </SocketSection>
      )}

      {/* One table: time | exception | endpoint | total. No section heading — the
             column headers carry it, and the window / sampling / burst detail lives
             on their tooltip. */}
      {endpointGroups.length > 0 && (
        <SocketSection label="">
          <div
            style={{ display: 'flex', gap: 8, color: '#6e7681', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 2, marginBottom: 3 }}
            title={[
              summary ? `${summary.trueCount.toLocaleString()} timeouts across ${summary.operations.toLocaleString()} endpoint${summary.operations === 1 ? '' : 's'}${samplingX >= 1.5 ? `, reconstructed from ${summary.records.toLocaleString()} sampled records (App Insights kept 1 in ${samplingX.toFixed(1)})` : ''}.` : null,
              burstLabel,
            ].filter(Boolean).join(' ') || undefined}
          >
            <span style={{ width: 200, flexShrink: 0 }} title="The .NET exception type, with the layer it belongs to underneath. Hover a row's exception for what to do about it.">exception</span>
            <span style={{ flex: 1, minWidth: 0 }}>endpoint</span>
            <span style={{ width: 46, textAlign: 'right', flexShrink: 0 }}>total</span>
          </div>

          {endpointGroups.map((g, j) => {
            const d = g.detail;
            const frame = d?.parsedStack ? getMeaningfulFrame(d.parsedStack) : null;
            const layerInfo = d ? timeoutLayer(d.type) : null;
            return (
              <React.Fragment key={j}>
                <div
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start',
                           paddingTop: j > 0 ? 4 : 0, borderTop: j > 0 ? '1px solid rgba(255,255,255,0.04)' : undefined }}
                >
                  {/* exception — the .NET type, with the plain-language label on the
                      line beneath. The fix hint is on hover, not a visible line: it
                      wrapped to four rows and set the height of the whole row.
                      Wraps mid-token because type names contain no spaces. */}
                  <div
                    style={{ width: 200, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
                    title={layerInfo?.hint || undefined}
                  >
                    <span style={{ color: TIMEOUT_ACCENT, fontWeight: 600, overflowWrap: 'anywhere' }}>{d?.type ?? '—'}</span>
                    {layerInfo?.heading && <span style={{ color: '#8b949e' }}>({layerInfo.heading})</span>}
                  </div>

                  {/* endpoint */}
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      {/* Carries what used to be its own column (the first → last
                          window) and its own line (the exception message), so the
                          row stays two lines without losing either. */}
                      <span
                        style={{ color: '#cdd9e5' }}
                        title={[
                          g.endpoint,
                          d?.innermostMessage || d?.outerMessage || null,
                          g.firstSeen ? `First → last timeout from this endpoint: ${fmtTime(g.firstSeen)} → ${fmtTime(g.lastSeen)}` : null,
                          burstLabel,
                          d?.assembly || null,
                        ].filter(Boolean).join('\n\n')}
                      >{g.endpoint}</span>
                      {/* Hidden when the throwing method is already the stack frame
                          printed underneath; kept when they differ, which is the
                          useful case (thrown in a retry wrapper, frame in your code). */}
                      {d?.method && d.method !== frame?.method && (
                        <span style={{ color: '#a371f7' }} title="Method that threw">{d.method}</span>
                      )}
                      {d?.handledAt && <span style={{ color: d.handledAt.toLowerCase() === 'unhandled' ? '#f85149' : '#484f58' }} title="handledAt">{d.handledAt}</span>}
                    </div>
                    {frame && (
                      <div style={{ color: '#3fb950', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title="Most meaningful stack frame">
                        {frame.method}{frame.fileName ? ` @ ${frame.fileName}${frame.line ? `:${frame.line}` : ''}` : ''}
                      </div>
                    )}
                  </div>

                  {/* total */}
                  <span
                    className="tabular-nums"
                    style={{ width: 46, textAlign: 'right', flexShrink: 0, color: '#f85149', fontWeight: 600 }}
                    title={`${g.count.toLocaleString()} occurrences from this endpoint, counted over the whole window (not from the 50-record detail sample).`}
                  >{g.count.toLocaleString()}</span>
                </div>

              </React.Fragment>
            );
          })}

          {/* Only when the endpoint list is short of the true count */}
          {hiddenEndpoints > 0 && (
            <div style={{ color: '#484f58', marginTop: 2 }}>
              Showing the {endpointGroups.length} largest of {summary!.operations} endpoints — narrow the time range to see the rest.
            </div>
          )}
        </SocketSection>
      )}

    </>
  );
}

function renderOomTab(
  oi: OomInsights | null | undefined,
): React.ReactNode {
  const summary = oi?.summary ?? null;
  const details = oi?.details ?? [];

  if (!oi) {
    return <tr style={{ fontSize: 9 }}><td colSpan={4} style={{ paddingLeft: 24, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>OOM breakdown unavailable — expand the card to load details.</td></tr>;
  }
  if ((summary?.trueCount ?? 0) === 0) {
    return (
      <tr style={{ fontSize: 9 }}>
        <td colSpan={4} style={{ paddingLeft: 24, color: '#3fb950', paddingBottom: 4 }}>No out-of-memory exceptions in this window.</td>
      </tr>
    );
  }

  const samplingX  = summary && summary.records > 0 ? summary.trueCount / summary.records : 1;

  return (
    <>
      {details.length > 0 && (() => {
        // One row per endpoint, allocation sites nested beneath it. Keying on
        // operation_Name + method instead produced two rows with an identical
        // endpoint name, distinguishable only by the frame line — it read as a
        // duplicate. A single OOM incident typically hits app code AND
        // Thread.StartInternal, so multiple sites per endpoint is the norm.
        type Site = { frame: ReturnType<typeof getMeaningfulFrame>; method: string; count: number };
        const grouped = details.reduce<Map<string, { d: typeof details[number]; count: number; sites: Map<string, Site> }>>((map, d) => {
          const key = d.operation_Name || '(unknown path)';
          const g = map.get(key) ?? { d, count: 0, sites: new Map<string, Site>() };
          g.count++;
          const frame = d.parsedStack ? getMeaningfulFrame(d.parsedStack) : null;
          const siteKey = frame
            ? `${frame.method}${frame.fileName ? `@${frame.fileName}:${frame.line}` : ''}`
            : (d.method || '(unknown site)');
          const site = g.sites.get(siteKey);
          if (site) site.count++; else g.sites.set(siteKey, { frame, method: d.method, count: 1 });
          map.set(key, g);
          return map;
        }, new Map());
        return (
          <SocketSection label="">
            {/* No exception column: every row in this tab is the same type, so it
                carried no information. The Timeout tab keeps one because its rows
                span SQL, HTTP and Redis. */}
            <div style={{ display: 'flex', gap: 8, color: '#6e7681', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 2, marginBottom: 3 }}>
              <span style={{ flex: 1, minWidth: 0 }}>endpoint</span>
              <span style={{ width: 46, textAlign: 'right', flexShrink: 0 }}>total</span>
            </div>

            {Array.from(grouped.values())
              .sort((a, b) => b.count - a.count)
              .map(({ d, count, sites }, j) => {
                const weighted = Math.round(count * samplingX);
                const siteList = Array.from(sites.values()).sort((a, b) => b.count - a.count);
                return (
                  <div
                    key={j}
                    style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 3,
                             paddingTop: j > 0 ? 4 : 0, borderTop: j > 0 ? '1px solid rgba(255,255,255,0.04)' : undefined }}
                  >
                    {/* endpoint, with one line per allocation site beneath it */}
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {/* Message and assembly ride on this tooltip — the OOM message
                            is always the same framework boilerplate, so it earned no
                            line of its own. */}
                        <span
                          style={{ color: '#cdd9e5' }}
                          title={[d.operation_Name, d.innermostMessage || d.outerMessage, d.assembly].filter(Boolean).join('\n\n')}
                        >{d.operation_Name || '(unknown path)'}</span>
                        {d.handledAt && <span style={{ color: d.handledAt.toLowerCase() === 'unhandled' ? '#f85149' : '#484f58' }} title="handledAt">{d.handledAt}</span>}
                        {siteList.length > 1 && (
                          <span style={{ color: '#8b949e' }} title="Distinct stack frames that ran out of memory under this endpoint">
                            {siteList.length} sites
                          </span>
                        )}
                      </div>
                      {siteList.map((s, k) => (
                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{ color: '#3fb950', fontFamily: 'monospace', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={s.frame ? 'Most meaningful stack frame — the allocation site' : 'Method that threw'}
                          >
                            {s.frame
                              ? `${s.frame.method}${s.frame.fileName ? ` @ ${s.frame.fileName}${s.frame.line ? `:${s.frame.line}` : ''}` : ''}`
                              : (s.method || '(unknown site)')}
                          </span>
                          {siteList.length > 1 && (
                            <span className="tabular-nums" style={{ color: '#8b949e', width: 40, textAlign: 'right', flexShrink: 0 }}>
                              {Math.round(s.count * samplingX).toLocaleString()}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* total — always shown, including 1: a blank cell read as missing
                        data rather than "once" */}
                    <span
                      className="tabular-nums"
                      style={{ width: 46, textAlign: 'right', flexShrink: 0, color: '#f85149', fontWeight: 600 }}
                      title={samplingX >= 1.5
                        ? `${weighted.toLocaleString()} occurrences, from ${count} sampled record${count === 1 ? '' : 's'}`
                        : `${weighted.toLocaleString()} occurrence${weighted === 1 ? '' : 's'}`}
                    >{weighted.toLocaleString()}</span>
                  </div>
                );
              })}

            {/* summary.operations is an uncapped dcount; the list comes from the
                50-record detail cap. Only speak up when the two disagree. */}
            {(summary?.operations ?? 0) > grouped.size && (
              <div
                style={{ color: '#484f58', marginTop: 2 }}
                title="Narrow the time range to see the others."
              >
                Showing {grouped.size} of {summary!.operations} endpoints — the rest fall outside the 50 newest records.
              </div>
            )}
          </SocketSection>
        );
      })()}
    </>
  );
}

function renderSocketTab(
  si: SocketInsights | null | undefined,
  counters: SocketCounters | null | undefined,
  fmtTime: (iso: string) => string,
): React.ReactNode {
  const sm = counters?.metrics ?? null;
  const summary  = si?.summary ?? null;
  const byType   = si?.byType ?? [];
  const byInst   = si?.byInstance ?? [];
  const timeline = si?.timeline ?? [];
  const targets  = si?.targets ?? [];
  const details  = si?.details ?? [];
  const verdict  = socketMetricVerdict(counters);
  const hasAny   = (summary?.records ?? 0) > 0 || byType.length > 0 || (sm?.length ?? 0) > 0;

  if (!si && !sm?.length) {
    return <tr style={{ fontSize: 9 }}><td colSpan={4} style={{ paddingLeft: 24, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Socket breakdown unavailable — expand the card to load details.</td></tr>;
  }
  if (!hasAny) {
    return (
      <tr style={{ fontSize: 9 }}>
        <td colSpan={4} style={{ paddingLeft: 24, color: '#3fb950', paddingBottom: 4 }}>No socket-layer exceptions in this window.</td>
      </tr>
    );
  }

  const instTotal   = byInst.reduce((s, i) => s + i.trueCount, 0);
  const topInst     = byInst[0] ?? null;
  const topShare    = instTotal > 0 && topInst ? (topInst.trueCount / instTotal) * 100 : 0;
  const samplingX   = summary && summary.records > 0 ? summary.trueCount / summary.records : 1;
  const tlMax       = Math.max(1, ...timeline.map(p => p.count));
  const tlPeak      = timeline.find(p => p.count === tlMax) ?? null;
  const tlNonZero   = timeline.filter(p => p.count > 0).length;
  const burst       = timeline.length > 3 && tlNonZero > 0 && (tlNonZero / timeline.length) <= 0.25;

  return (
    <>
      {/* Headline */}
      {summary && summary.records > 0 && (
        <SocketSection label="Socket exceptions">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline' }}>
            <span style={{ color: SOCKET_ACCENT, fontWeight: 700, fontSize: 11 }}>{summary.trueCount.toLocaleString()}</span>
            <span style={{ color: '#8b949e' }} title="Sum of itemCount — corrected for App Insights ingestion sampling. The raw record count is what the KQL returned.">
              {summary.records.toLocaleString()} records{samplingX >= 1.5 ? ` · sampling ×${samplingX.toFixed(1)}` : ''}
            </span>
            <span style={{ color: '#8b949e' }}>{summary.instances.toLocaleString()} instance{summary.instances === 1 ? '' : 's'}</span>
            <span style={{ color: '#8b949e' }}>{summary.operations.toLocaleString()} operation{summary.operations === 1 ? '' : 's'}</span>
            {summary.firstSeen && <span style={{ color: '#484f58' }}>{fmtTime(summary.firstSeen)} → {fmtTime(summary.lastSeen)}</span>}
          </div>
        </SocketSection>
      )}

      {/* Zero state still reached when only the plan counters have data */}
      {(summary?.records ?? 0) === 0 && (
        <tr style={{ fontSize: 9 }}>
          <td colSpan={4} style={{ paddingLeft: 24, color: '#3fb950', paddingTop: 4, paddingBottom: 4 }}>No socket-layer exceptions in this window.</td>
        </tr>
      )}

      {/* Timeline */}
      {timeline.length > 1 && (
        <SocketSection label={`Timeline${burst ? ' — burst' : ' — sustained'}`}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 26 }}>
            {timeline.map((p, i) => (
              <span
                key={i}
                title={`${fmtTime(p.t)} — ${p.count.toLocaleString()}`}
                style={{
                  flex: 1, minWidth: 1,
                  height: `${Math.max(p.count > 0 ? 8 : 1, (p.count / tlMax) * 100)}%`,
                  background: p.count === 0 ? 'rgba(255,255,255,0.05)' : p.count >= tlMax * 0.6 ? '#f85149' : SOCKET_ACCENT,
                }}
              />
            ))}
          </div>
          <div style={{ color: '#484f58', marginTop: 2 }}>
            peak {tlMax.toLocaleString()}{tlPeak ? ` @ ${fmtTime(tlPeak.t)}` : ''} · {tlNonZero}/{timeline.length} buckets active
            {burst ? ' — concentrated spike, look for a traffic or deploy event' : ' — steady across the window, points at a connection leak rather than a spike'}
          </div>
        </SocketSection>
      )}

      {/* By exception type / client library */}
      {byType.length > 0 && (
        <SocketSection label="By type &amp; library">
          {byType.map((t, i) => {
            const pct = byType[0]!.trueCount > 0 ? (t.trueCount / byType[0]!.trueCount) * 100 : 0;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
                <span style={{ color: '#cdd9e5', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.exType}>{t.exType}</span>
                <span style={{ color: '#a371f7', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`Assembly: ${t.assembly}`}>{t.assembly || '—'}</span>
                <MiniBar pct={pct} color={SOCKET_ACCENT} />
                <span className="tabular-nums" style={{ color: '#f85149', width: 52, textAlign: 'right', flexShrink: 0 }}>{t.trueCount.toLocaleString()}</span>
              </div>
            );
          })}
        </SocketSection>
      )}

      {/* Per instance — SNAT ports are per worker */}
      {byInst.length > 0 && (
        <SocketSection label="By instance">
          {byInst.map((inst, i) => {
            const pct = instTotal > 0 ? (inst.trueCount / instTotal) * 100 : 0;
            return (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
                <span style={{ color: '#cdd9e5', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${inst.instance}${inst.roleName ? ` · ${inst.roleName}` : ''}`}>{inst.instance}</span>
                <MiniBar pct={pct} color={pct >= 60 ? '#f85149' : SOCKET_ACCENT} />
                <span className="tabular-nums" style={{ color: '#8b949e', width: 40, textAlign: 'right', flexShrink: 0 }}>{pct.toFixed(0)}%</span>
                <span className="tabular-nums" style={{ color: '#f85149', width: 52, textAlign: 'right', flexShrink: 0 }}>{inst.trueCount.toLocaleString()}</span>
              </div>
            );
          })}
          {byInst.length > 1 && (
            <div style={{ color: topShare >= 60 ? '#f0883e' : '#484f58', marginTop: 2 }}>
              {topShare >= 60
                ? `${topShare.toFixed(0)}% on ${topInst?.instance} — worker-local port exhaustion. Restarting or scaling out only moves the problem; the leak is per-instance.`
                : 'Spread across instances — plan-wide connection pressure rather than one bad worker.'}
            </div>
          )}
          {byInst.length === 1 && (
            <div style={{ color: '#484f58', marginTop: 2 }}>Single instance reporting — scale out will not dilute this.</div>
          )}
        </SocketSection>
      )}

      {/* Correlated failing dependency targets */}
      {targets.length > 0 && (
        <SocketSection label="Downstream targets (correlated by operation_Id)">
          {targets.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
              <span style={{ color: '#cdd9e5', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.target}>{t.target}</span>
              <span style={{ color: '#a371f7', width: 60, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`Dependency type: ${t.depType}`}>{t.depType || '—'}</span>
              <span style={{ color: '#d29922', width: 34, flexShrink: 0 }} title="resultCode">{t.resultCode || '—'}</span>
              <span className="tabular-nums" style={{ color: '#58a6ff', width: 62, textAlign: 'right', flexShrink: 0 }} title="p95 duration">{fmtDuration(t.p95)}</span>
              <span className="tabular-nums" style={{ color: '#f85149', width: 52, textAlign: 'right', flexShrink: 0 }}>{t.count.toLocaleString()}</span>
            </div>
          ))}
        </SocketSection>
      )}

      {/* Platform socket / TCP counters — published on the plan, not the site */}
      {(sm?.length ?? 0) > 0 && (
        <SocketSection label={`Outbound socket / TCP counters — plan ${counters?.planName || '(unknown)'}`}>
          {sm!.map((m, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1 }}>
              <span style={{ color: '#cdd9e5', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={SOCKET_METRIC_HELP[m.name] ?? m.name}>{m.name}</span>
              <span className="tabular-nums" style={{ color: '#8b949e', width: 70, textAlign: 'right', flexShrink: 0 }} title="Average">avg {Math.round(m.avg).toLocaleString()}</span>
              <span className="tabular-nums" style={{ color: '#58a6ff', width: 70, textAlign: 'right', flexShrink: 0 }} title="Maximum">max {Math.round(m.max).toLocaleString()}</span>
            </div>
          ))}
          {verdict && (
            <div style={{ color: verdict.color, marginTop: 3 }}>
              TimeWait / Established = {Number.isFinite(verdict.ratio) ? verdict.ratio.toFixed(2) : '∞'} — {verdict.text}
            </div>
          )}
          <div style={{ color: '#484f58', marginTop: 2 }}>
            Counters are published on the App Service Plan, so they cover every site sharing it — not this site alone. Azure allocates a fixed SNAT port budget per worker (128 ports per unique destination by default), and a TIME_WAIT socket holds its port for ~4 minutes, so churn — not concurrency — is what exhausts the budget.
          </div>
        </SocketSection>
      )}

      {/* Records */}
      {details.length > 0 && (() => {
        const grouped = details.reduce<Map<string, { d: typeof details[number]; count: number; weight: number }>>((map, d) => {
          const key = `${d.operation_Name || '(unknown path)'}|${d.innermostType || d.type}`;
          const ex = map.get(key);
          if (ex) { ex.count++; ex.weight += d.itemCount || 1; }
          else map.set(key, { d, count: 1, weight: d.itemCount || 1 });
          return map;
        }, new Map());
        return (
          <SocketSection label={`Records (${details.length}${details.length >= 50 ? ' shown, newest first' : ''})`}>
            {Array.from(grouped.values()).map(({ d, count, weight }, j) => {
              const frame = d.parsedStack ? getMeaningfulFrame(d.parsedStack) : null;
              return (
                <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 3 }}>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ color: '#cdd9e5' }} title={d.operation_Name}>{d.operation_Name || '(unknown path)'}</span>
                      {/* Hidden when it duplicates the stack frame printed below */}
                      {d.method && d.method !== frame?.method && (
                        <span style={{ color: '#a371f7' }} title="Method that threw">{d.method}</span>
                      )}
                      {d.cloud_RoleInstance && <span style={{ color: '#484f58' }} title="Instance">@{d.cloud_RoleInstance}</span>}
                      {d.handledAt && <span style={{ color: d.handledAt.toLowerCase() === 'unhandled' ? '#f85149' : '#484f58' }} title="handledAt">{d.handledAt}</span>}
                    </div>
                    <div style={{ color: '#f85149', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.innermostMessage || d.outerMessage}>
                      {d.innermostMessage || d.outerMessage || '—'}
                    </div>
                    {(d.innermostType || d.innermostMethod || d.assembly) && (
                      <div style={{ color: '#484f58', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {d.innermostType && <span title="Innermost type">{d.innermostType}</span>}
                        {d.assembly && <span style={{ color: '#a371f7', opacity: 0.7 }} title="Assembly">{d.assembly}</span>}
                        {d.innermostMethod && <span style={{ color: '#a371f7', opacity: 0.7 }} title="Innermost method">{d.innermostMethod}</span>}
                      </div>
                    )}
                    {frame && (
                      <div style={{ color: '#3fb950', fontFamily: 'monospace' }} title="Most meaningful stack frame">
                        {frame.method}{frame.fileName ? ` @ ${frame.fileName}${frame.line ? `:${frame.line}` : ''}` : ''}
                      </div>
                    )}
                  </div>
                  <span
                    className="tabular-nums"
                    style={{ width: 46, textAlign: 'right', flexShrink: 0, color: '#f85149', fontWeight: 600, marginTop: 1 }}
                    title={weight > count ? `${weight.toLocaleString()} occurrences, from ${count} sampled record${count === 1 ? '' : 's'}` : `${weight.toLocaleString()} occurrence${weight === 1 ? '' : 's'}`}
                  >{weight.toLocaleString()}</span>
                </div>
              );
            })}
          </SocketSection>
        );
      })()}
    </>
  );
}

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
  snatLoading?: boolean;
  /** The restart detector round trip is in flight. Fired with the initial load, so the
   *  row must distinguish 'not known yet' from 'no restarts'. */
  restartsLoading?: boolean;
  /** Restart detector results for this app. Passed in rather than read off `metrics`: the
   *  hook keeps them in their own map so a fast cached result cannot be dropped. */
  restarts?: RestartResult | null;
  apiRestarts?: RestartResult | null;
  /** Per-endpoint dependency lookups for this card, keyed by `${site}|${endpoint}`. */
  endpointDeps?: Record<string, EndpointDepsState>;
  onRequestEndpointDeps?: ((site: 'fe' | 'api', endpoint: string) => void) | undefined;
  onRequestSnat?: () => void;
  onRequestRestarts?: () => void;
  azureSettings: AzureSettings;
  uptimeRobotApiKey?: string | undefined;
  uptimeRobotMonitorIds?: string[] | undefined;
  rangeStart?: string | undefined;
  rangeEnd?: string | undefined;
}


const AI_STATUS_COLORS = { healthy: '#3fb950', warning: '#d29922', critical: '#f85149' } as const;

/**
 * Wrapped in memo because the page holds every card's async state in one place: a restart
 * summary or a dependency lookup landing for ONE app re-rendered all of them, and each
 * card is a ~200px multi-series chart plus several tables. The page passes stable
 * callbacks and a stable `endpointDeps` slice so this actually bites.
 */
export const AzureAppCard = React.memo(AzureAppCardInner);

function AzureAppCardInner({ appKey, metrics, loading, detailsLoading = false, detailsLoaded = false, onRequestDetails, snatLoading = false, onRequestSnat, restartsLoading = false, restarts, apiRestarts, onRequestRestarts, endpointDeps = {}, onRequestEndpointDeps, azureSettings, uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd }: AzureAppCardProps) {
  const { elementRef: cardRef, isCopying } = useCopyElementAsImage<HTMLDivElement>({
    // No timestamp here: the hook appends its own, and Date.now() in a prop gave the
    // copy callback a new identity on every single render.
    fileNamePrefix: `azure-${appKey}`,
    backgroundColor: '#09090b',
  });

  const { monitors: urMonitors, loading: urLoading, error: urError } = useUptimeRobotMonitor(uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd);
  // High-frequency bursts plus the Users section's top clients. The Users rows show the
  // same reputation badges, and the hook only resolves addresses it is given — seeding it
  // from bursts alone left every top-client row permanently unbadged.
  const lookupIps = [
    ...(metrics.requestInsights?.highFreq ?? []),
    ...(metrics.apiRequestInsights?.highFreq ?? []),
  ].map(u => u.ip).concat(
    (metrics.requestInsights?.userInsights?.topIps ?? []).map(c => c.ip),
    (metrics.apiRequestInsights?.userInsights?.topIps ?? []).map(c => c.ip),
  );
  const ipReputations = useIpReputation(lookupIps);
  const [urExpanded, setUrExpanded] = useState(false);
  const [usersExpanded, setUsersExpanded] = useState(false);
  const [usersAPIExpanded, setUsersAPIExpanded] = useState(false);
  // Every chart on this card shares one hover group, so a spike found in the
  // Response or Instances chart lines up against CPU/memory without eyeballing
  // the x-axis. Keyed per card — two cards on screen must not move together.
  const hoverSyncId = `card-${appKey}`;
  const [hiddenMetrics, setHiddenMetrics] = useState<Set<string>>(new Set());
  const [snatPortsExpanded, setSnatPortsExpanded] = useState(false);
  const [snatApiPortsExpanded, setSnatApiPortsExpanded] = useState(false);
  const [restartsExpanded, setRestartsExpanded] = useState(false);
  const [restartsAPIExpanded, setRestartsAPIExpanded] = useState(false);
  // Mirrors the panel's own selection so the card knows which endpoint's dependency
  // lookup to hand back down. Held here rather than lifted out of the panel entirely:
  // the panel owns the selection, this is only the echo needed to address the cache.
  const [perfFeSelected, setPerfFeSelected] = useState('');
  const [perfApiSelected, setPerfApiSelected] = useState('');
  const [perfExpanded, setPerfExpanded] = useState(false);
  // Stable identities: the panel asks for its selection from an effect keyed on the
  // callback, so an inline arrow would re-fire it on every render of the card.
  const requestFeDeps = useCallback((ep: string) => {
    setPerfFeSelected(ep);
    onRequestEndpointDeps?.('fe', ep);
  }, [onRequestEndpointDeps]);
  const requestApiDeps = useCallback((ep: string) => {
    setPerfApiSelected(ep);
    onRequestEndpointDeps?.('api', ep);
  }, [onRequestEndpointDeps]);
  const [perfAPIExpanded, setPerfAPIExpanded] = useState(false);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [errTab, setErrTab] = useState<ExcTab>('generic');
  const [errAPITab, setErrAPITab] = useState<ExcTab>('generic');
  const [availExpanded, setAvailExpanded] = useState(false);
  // Section-level collapse for the FE / API / Remarks blocks. FE and API open by
  // default — side by side they fit without crowding the card, and they carry the
  // figures a card is opened to read; Remarks stays closed.
  const [feSectionOpen, setFeSectionOpen] = useState(true);
  const [apiSectionOpen, setApiSectionOpen] = useState(true);
  const [remarksOpen, setRemarksOpen] = useState(false);
  // Whole-card collapse. Open by default — a single app should still land fully
  // expanded; this exists so a multi-app fetch can be folded down to one line each.
  const [cardCollapsed, setCardCollapsed] = useState(false);
  const [rcaSectionOpen, setRcaSectionOpen] = useState(false);
  const [rcaDraft, setRcaDraft] = useState('');
  const [visibleBlocks, setVisibleBlocks] = useState({
    remarks: true, cpu: true, memory: true, database: true, users: true,
    exceptions: true, instances: true, uptimerobot: true, snat: true,
    restarts: true, performance: true,
    frontend: true, api: true,
  });
  const toggleBlock = (key: keyof typeof visibleBlocks) =>
    setVisibleBlocks(prev => ({ ...prev, [key]: !prev[key] }));
  const [selectedErrType, setSelectedErrType] = useState<string | null>(null);
  const [errAPIExpanded, setErrAPIExpanded] = useState(false);
  const [selectedErrAPIType, setSelectedErrAPIType] = useState<string | null>(null);
  const [incidentReportLoading, setIncidentReportLoading] = useState(false);
  const [incidentReportError, setIncidentReportError] = useState<string | null>(null);
  const [rcaOpen, setRcaOpen] = useState(false);
  const [rcaStatus, setRcaStatus] = useState<RcaStatus>('idle');
  const [rcaText, setRcaText] = useState('');
  const [rcaError, setRcaError] = useState<string | null>(null);
  const [rcaStages, setRcaStages] = useState<string[]>([]);

  useEffect(() => {
    setUrExpanded(false);
    setErrorsExpanded(false);
    setAvailExpanded(false);
    setErrAPIExpanded(false);
    setPerfExpanded(false);
    setPerfAPIExpanded(false);
    setUsersExpanded(false);
    setUsersAPIExpanded(false);
    setSnatPortsExpanded(false);
    setSnatApiPortsExpanded(false);
    setSelectedErrType(null);
    setSelectedErrAPIType(null);
    setAiRemark(null);
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
      // Needed for the report's server-side database metrics (Category 15).
      dbName: appCfg?.dbName,
      dbServerName: appCfg?.dbServerName,
      logAnalyticsWorkspaceId: appCfg?.logAnalyticsWorkspaceId,
      appGatewayResourceId: appCfg?.appGatewayResourceId,
      frontDoorResourceId: appCfg?.frontDoorResourceId,
      loadBalancerResourceId: appCfg?.loadBalancerResourceId,
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

  // Opens the dialog on its input step — the analysis only starts when the user
  // presses Generate, so they can supply their own findings first.
  const openRcaDialog = useCallback(() => {
    setRcaOpen(true);
    // A run keeps going when the dialog is dismissed — reopening shows its progress
    // rather than resetting state out from under the in-flight analysis.
    if (rcaStatus === 'running') return;
    setRcaStatus('idle');
    setRcaText('');
    setRcaError(null);
    setRcaStages([]);
  }, [rcaStatus]);

  const handleRunRca = useCallback(async (
    investigationNotes: string,
    // The dialog keeps the engineering report it has always produced; the card's
    // RCA section asks for the seven-section business layout it renders as a form.
    format: 'engineering' | 'business' = 'engineering',
    // Facts the card already measured or has configured, so the model reproduces
    // them instead of deriving its own (a wider window, a guessed platform name).
    given: {
      incidentName?: string;
      incidentPeriod?: string;
      servicesAffected?: string;
      reportTitle?: string;
    } = {},
  ) => {
    setRcaStatus('running');
    setRcaText('');
    setRcaError(null);
    setRcaStages([]);
    const offChunk = window.electronAPI.incidentReport.onRcaChunk(({ appKey: k, chunk }) => {
      if (k === appKey) setRcaText(prev => prev + chunk);
    });
    const offProgress = window.electronAPI.incidentReport.onRcaProgress(({ appKey: k, stage, reset }) => {
      if (k !== appKey) return;
      setRcaStages(prev => [...prev, stage]);
      // Model fallback restarts the stream — drop the aborted partial so the two
      // attempts don't render as one stitched-together analysis.
      if (reset) setRcaText('');
    });
    try {
      const result = await window.electronAPI.incidentReport.rca({
        ...buildIncidentPayload(), investigationNotes, format, ...given,
      });
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

  // The card's RCA section is an editable form; its composed markdown is what the
  // exports and the Teams copy must carry, so edits are never silently dropped.
  const rcaOutput = rcaDraft.trim() ? rcaDraft : rcaText;

  const exportRca = useCallback(async () => {
    try {
      const { startMs, endMs } = buildIncidentPayload();
      const result = await window.electronAPI.incidentReport.saveRca({ appName: appKey, startMs, endMs, markdown: rcaOutput });
      if (!result.success) throw new Error(result.error ?? 'Save failed');
      await navigator.clipboard.writeText(rcaOutput);
      toast.success('RCA saved & markdown copied');
    } catch (e: any) {
      toast.error('Export failed', { description: e?.message });
    }
  }, [appKey, buildIncidentPayload, rcaOutput]);

  const exportRcaPdf = useCallback(async () => {
    try {
      const { startMs, endMs } = buildIncidentPayload();
      // HTML is built here rather than in main: `marked` and the print stylesheet
      // both live on the renderer side, and this keeps the printed report in step
      // with what the dialog shows.
      const html = buildRcaPrintHtml(rcaOutput, {
        appName: appKey,
        window: formatSgtRange(startMs, endMs),
        generated: formatSgt(Date.now()),
      });
      const result = await window.electronAPI.incidentReport.exportRcaPdf({ appName: appKey, startMs, endMs, html });
      if (!result.success) throw new Error(result.error ?? 'PDF export failed');
      toast.success('RCA PDF saved');
    } catch (e: any) {
      toast.error('PDF export failed', { description: e?.message });
    }
  }, [appKey, buildIncidentPayload, rcaOutput]);

  const exportRcaWord = useCallback(async () => {
    try {
      const { startMs, endMs } = buildIncidentPayload();
      const html = buildRcaWordHtml(rcaOutput, {
        appName: appKey,
        window: formatSgtRange(startMs, endMs),
        generated: formatSgt(Date.now()),
      });
      const result = await window.electronAPI.incidentReport.exportRcaDoc({ appName: appKey, startMs, endMs, html });
      if (!result.success) throw new Error(result.error ?? 'Word export failed');
      toast.success('RCA Word document saved');
    } catch (e: any) {
      toast.error('Word export failed', { description: e?.message });
    }
  }, [appKey, buildIncidentPayload, rcaOutput]);

  // Just the plain-English summary, formatted for a Teams chat — the part that
  // gets shared with non-engineers, without the full report attached.
  const copySummaryForTeams = useCallback(async () => {
    try {
      const { summary } = splitQuickSummary(rcaOutput);
      if (!summary) throw new Error('This report has no Quick Summary section.');
      const { startMs, endMs } = buildIncidentPayload();
      const meta = { appName: appKey, window: formatSgtRange(startMs, endMs) };
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([buildQuickSummaryTeamsHtml(summary, meta)], { type: 'text/html' }),
          'text/plain': new Blob([buildQuickSummaryTeamsText(summary, meta)], { type: 'text/plain' }),
        }),
      ]);
      toast.success('Quick Summary copied for Teams');
    } catch (e: any) {
      toast.error('Copy failed', { description: e?.message });
    }
  }, [appKey, buildIncidentPayload, rcaOutput]);

  const copyRcaForTeams = useCallback(async () => {
    try {
      const htmlBody = marked.parse(rcaOutput, { async: false }) as string;
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html':  new Blob([htmlBody], { type: 'text/html' }),
          'text/plain': new Blob([rcaOutput], { type: 'text/plain' }),
        }),
      ]);
      toast.success('Copied for Teams');
    } catch (e: any) {
      toast.error('Copy failed', { description: e?.message });
    }
  }, [rcaOutput]);

  // Eagerly fetch details when the request insights are available (top dependency % needs them)
  useEffect(() => {
    if (!metrics.appInsightsConfigured || !metrics.requestInsights || metrics.requestInsights.error) return;
    if (detailsLoaded || detailsLoading) return;
    onRequestDetails?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics.appInsightsConfigured, !!metrics.requestInsights]);

  // SNAT charts are fetched as soon as the card has metrics rather than on expand:
  // the collapsed row carries the pending and failed totals, and those have to be
  // there when the card is generated — including in an exported image, which never
  // gets a click. The hook de-duplicates, so a later expand costs nothing.
  useEffect(() => {
    if (metrics.type !== 'appservice') return;
    if (loading || metrics.snat !== undefined) return;
    onRequestSnat?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appKey, metrics.type, loading, metrics.snat === undefined]);

  // PT1M data fetched separately for the incidents panel — avoids dashboard-interval gaps
  const [incidentDetailMetrics, setIncidentDetailMetrics] = useState<AppMetrics | null>(null);
  const [incidentDetailLoading, setIncidentDetailLoading] = useState(false);

  const [isTeamsCopying, setIsTeamsCopying] = useState(false);

  // AI health remarks — Claude verdict over a compact metrics summary
  const [aiRemark, setAiRemark] = useState<{ status: 'healthy' | 'warning' | 'critical'; remarks: string } | null>(null);
  const [aiRemarkLoading, setAiRemarkLoading] = useState(false);

  const generateAiRemarks = async () => {
    if (aiRemarkLoading) return;
    setAiRemarkLoading(true);
    try {
      const downLogs = urMonitors.flatMap(m => (m.logs ?? []).filter(l => l.type === 1));
      const heuristic = buildRemarks(metrics, rangeStart, rangeEnd, visibleBlocks, urMonitors);
      const summary = {
        app: metrics.label || appKey,
        rangeStart: rangeStart ?? metrics.cpu.series[0]?.t ?? null,
        rangeEnd: rangeEnd ?? metrics.cpu.series.at(-1)?.t ?? null,
        cpu: { avg: metrics.cpu.avg, p99: metrics.cpu.p99, max: metrics.cpu.max, unit: '%' },
        memory: { avg: metrics.memory.avg, p99: metrics.memory.p99, max: metrics.memory.max, unit: metrics.memUnit },
        dbCpu: (metrics.dbCpu?.series?.length ?? 0) > 0 ? { avg: metrics.dbCpu!.avg, p99: metrics.dbCpu!.p99, max: metrics.dbCpu!.max, unit: '%' } : null,
        dbMemory: (metrics.dbMemory?.series?.length ?? 0) > 0 ? { avg: metrics.dbMemory!.avg, p99: metrics.dbMemory!.p99, max: metrics.dbMemory!.max, unit: '%' } : null,
        responseTimeSec: (() => {
          // Same figures the Response row shows, converted to seconds for the prompt.
          const sp = metrics.requestInsights?.responseInsights?.spread;
          return sp ? { avg: sp.avgMs / 1000, p99: sp.p99 / 1000, max: sp.maxMs / 1000 } : null;
        })(),
        availabilityPct: metrics.availability?.pct ?? null,
        requestsTotal: metrics.requests?.total ?? null,
        failedRequestsTotal: metrics.failedRequests?.total ?? null,
        uptimeRobot: urMonitors.length > 0 ? {
          incidents: downLogs.length,
          downtimeMins: Math.round(downLogs.reduce((s, l) => s + l.duration, 0) / 60),
        } : null,
        planSku: metrics.plan?.sku ?? null,
        heuristic: heuristic.text || null,
      };
      const result = await window.electronAPI.incidentReport.aiRemarks({ summary });
      if (!result.success || !result.remarks) throw new Error(result.error ?? 'AI remarks failed');
      setAiRemark({ status: result.status ?? 'warning', remarks: result.remarks });
      toast.success('AI remarks generated');
    } catch (e: any) {
      toast.error('AI remarks failed', { description: e?.message });
    } finally {
      setAiRemarkLoading(false);
    }
  };

  const copyForTeams = async () => {
    const card = cardRef.current;
    if (!card || isCopying || isTeamsCopying) return;
    setIsTeamsCopying(true);

    // A collapsed card has no chart in the DOM to screenshot. Expand and let two
    // frames pass — one to commit the re-render, one for Recharts to size and paint
    // into its new container — before querying for it. Left expanded afterwards, so
    // what was copied is what's on screen.
    if (cardCollapsed) {
      setCardCollapsed(false);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }

    const chartEl = (card.querySelector('[data-teams-chart]') as HTMLElement | null) ?? card;

    const fmtFullSgt = (d: Date) => d.toLocaleString('en-GB', {
      timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }) + ' SGT';
    const endRaw = rangeEnd ?? metrics.cpu.series.at(-1)?.t;
    const endLabel = endRaw ? fmtFullSgt(new Date(endRaw)) : '—';
    const appName = metrics.label || appKey;

    const heuristicRemarks = buildRemarks(metrics, rangeStart, rangeEnd, visibleBlocks, urMonitors);
    const severityColor: Record<string, string> = { ok: '#3fb950', warning: '#d29922', critical: '#f85149' };
    const remarksText = aiRemark ? aiRemark.remarks : heuristicRemarks.text;
    const remarksColor = aiRemark
      ? AI_STATUS_COLORS[aiRemark.status]
      : (severityColor[heuristicRemarks.severity] ?? '#333');

    const rows: Array<{ name: string; avg: string; p99: string; max: string }> = [];
    if (visibleBlocks.cpu) rows.push({
      name: 'CPU',
      avg: `${(+metrics.cpu.avg).toFixed(2)}%`, p99: `${(+metrics.cpu.p99).toFixed(2)}%`, max: `${(+metrics.cpu.max).toFixed(2)}%`,
    });
    if (visibleBlocks.memory) rows.push({
      name: 'Memory',
      avg: `${(+metrics.memory.avg).toFixed(2)}${metrics.memUnit}`, p99: `${(+metrics.memory.p99).toFixed(2)}${metrics.memUnit}`, max: `${(+metrics.memory.max).toFixed(2)}${metrics.memUnit}`,
    });
    if (visibleBlocks.database && (metrics.dbCpu?.series?.length ?? 0) > 0) rows.push({
      name: 'DB CPU',
      avg: `${(+metrics.dbCpu!.avg).toFixed(2)}%`, p99: `${(+metrics.dbCpu!.p99).toFixed(2)}%`, max: `${(+metrics.dbCpu!.max).toFixed(2)}%`,
    });
    if (visibleBlocks.database && (metrics.dbMemory?.series?.length ?? 0) > 0) rows.push({
      name: 'DB Memory',
      avg: `${(+metrics.dbMemory!.avg).toFixed(2)}%`, p99: `${(+metrics.dbMemory!.p99).toFixed(2)}%`, max: `${(+metrics.dbMemory!.max).toFixed(2)}%`,
    });
    if (visibleBlocks.uptimerobot && urMonitors.length > 0) {
      const downLogs = urMonitors.flatMap(m => (m.logs ?? []).filter(l => l.type === 1));
      const totalIncidents = downLogs.length;
      const totalDownSec = downLogs.reduce((s, l) => s + l.duration, 0);
      const firstT = metrics.cpu.series[0]?.t;
      const lastT = metrics.cpu.series.at(-1)?.t;
      const spanSec = firstT && lastT ? (new Date(lastT).getTime() - new Date(firstT).getTime()) / 1000 : 0;
      const uptimePct = spanSec > 0 ? Math.round((1 - totalDownSec / spanSec) * 10000) / 100 : null;
      rows.push({
        name: 'UptimeRobot',
        avg: '—',
        p99: `${totalIncidents} incident${totalIncidents !== 1 ? 's' : ''}`,
        max: uptimePct != null ? `${uptimePct.toFixed(2)}% uptime` : '—',
      });
    }

    try {
      const html2canvas = await loadHtml2Canvas();
      const canvas: HTMLCanvasElement = await html2canvas(chartEl, {
        backgroundColor: '#09090b', scale: 2, logging: false, useForeignObject: false,
      });
      const imageBlob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png'),
      );
      const dataUrl = canvas.toDataURL('image/png');

      const tableRows = rows.map(r =>
        `<tr><td style="padding:4px 10px;"><b>${r.name}</b></td><td align="right" style="padding:4px 10px;">${r.avg}</td><td align="right" style="padding:4px 10px;">${r.p99}</td><td align="right" style="padding:4px 10px;">${r.max}</td></tr>`,
      ).join('');
      const htmlBody =
        `<div style="display:block;font-family:sans-serif;font-size:13px;">` +
        `<p style="font-weight:700;font-size:14px;margin:0;">Health Check Status - ${endLabel}</p>` +
        `<p style="margin:0;">App Service Plan: <b>${appName}</b></p>` +
        `<p style="margin:0;">&nbsp;</p>` +
        `<p style="margin:0;"><img src="${dataUrl}" style="width:100%;display:block;"/></p>` +
        `<p style="margin:0;">&nbsp;</p>` +
        `<table border="1" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">` +
        `<tr><td style="padding:4px 10px;"><b>Metrics</b></td><td align="right" style="padding:4px 10px;"><b>Average</b></td><td align="right" style="padding:4px 10px;"><b>P99</b></td><td align="right" style="padding:4px 10px;"><b>Max</b></td></tr>` +
        tableRows +
        `</table>` +
        `<p style="margin:0;">&nbsp;</p>` +
        `<p style="margin:0;"><b style="color:#555;">Remarks: </b><b style="color:${remarksColor};">${remarksText || '—'}</b></p>` +
        `</div>`;
      const plainText = [
        `Health Check Status - ${endLabel}`,
        `App Service Plan: ${appName}`,
        '',
        'Metrics | Average | P99 | Max',
        ...rows.map(r => `${r.name} | ${r.avg} | ${r.p99} | ${r.max}`),
        '',
        `Remarks: ${remarksText || '—'}`,
      ].join('\n');

      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': imageBlob,
          'text/html': new Blob([htmlBody], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        }),
      ]);
      toast.success('Copied for Teams');
    } catch (err: any) {
      console.error('Copy for Teams failed:', err);
      toast.error('Copy for Teams failed', { description: err?.message });
    } finally {
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

  // The RCA's Incident Period is the outage itself, not the chart window: first
  // downtime start → last downtime end. UptimeRobot is the reference — it watches
  // from outside Azure — with Azure's own detected downtime as the fallback when no
  // monitor is configured for this app.
  const incidentIntervals = urDowntimeIntervals.length > 0 ? urDowntimeIntervals : downtimeIntervals;
  const incidentPeriod = incidentIntervals.length > 0
    ? formatSgtRange(
        Math.min(...incidentIntervals.map(i => i.start)),
        Math.max(...incidentIntervals.map(i => i.end)),
      )
    : '';

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
  // Platform name is optional in settings — older configs have only the resource
  // group, so that stays the fallback everywhere the platform is named.
  const platformName = appConfig?.platformName || resourceGroup || metrics.label;
  const platformUrls: string[] = appConfig?.platformUrls ?? [];
  const hasApi = !!(appConfig?.apiName);
  const hasDb = !!(appConfig?.dbName);
  const feHasInsights = !!(appConfig?.appInsightsAppId);
  const apiHasInsights = !!(appConfig?.apiInsightsAppId);
  // FE and API render as a two-column pair, but only when both are actually
  // there — a lone block still gets the full card width.
  const showFeBlock  = feHasInsights && visibleBlocks.frontend;
  const showApiBlock = hasApi && visibleBlocks.api;

  const SGT = { timeZone: 'Asia/Singapore' } as const;
  const fmtShort = (d: Date) => d.toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' SGT';
  const fmtExcTime = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleTimeString('en-GB', { ...SGT, hour: '2-digit', minute: '2-digit', hour12: false });
  };
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

  type ErrDetail ={ timestamp: string; type: string; outerMessage: string; method: string; assembly: string; operation_Name: string; innermostMessage: string; severityLevel: number | null; handledAt: string; cloud_RoleName: string; client_Browser: string; client_OS: string; innermostType: string; innermostMethod: string; parsedStack: string };
  const renderErrTypes = (
    // `trueCount` (sampling-corrected) is displayed when present so this list is in
    // the same unit as the tab badge and the row total; `count` is the raw fallback.
    types: Array<{ type: string; count: number; trueCount?: number }>,
    details: ErrDetail[] | null | undefined,
    selType: string | null,
    setSelType: (t: string | null) => void,
    // Server-side throw sites for the whole window. Preferred over `details`,
    // which is capped at 50 sampled records and so cannot state a real total.
    sites?: ExceptionSiteRow[] | null | undefined,
    siteTopN?: number | null | undefined,
  ): React.ReactNode => (
    types.length === 0
      ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No exception type data</td></tr>
      : <>{types.map((e, i) => {
        const isSelected = selType === e.type;
        const filtered = (details ?? []).filter(d => d.type === e.type);
        const typeSites = (sites ?? []).filter(s => s.type === e.type);
        const shown = e.trueCount ?? e.count;
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
              <td
                className="text-right tabular-nums"
                style={{ color: shown > 10 ? '#f85149' : shown > 3 ? '#d29922' : '#484f58' }}
                title={e.trueCount != null && e.trueCount !== e.count ? `${e.trueCount.toLocaleString()} occurrences, from ${e.count.toLocaleString()} sampled records` : undefined}
              >{shown.toLocaleString()}</td>
            </tr>
            {isSelected && filtered.length === 0 && typeSites.length === 0 && (
              <tr style={{ fontSize: 9 }}><td colSpan={4} style={{ paddingLeft: 32, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No detail records available</td></tr>
            )}
            {/* The site table when the query behind it ran; the old per-endpoint
                list only as the fallback for payloads cached before it existed. */}
            {isSelected && typeSites.length > 0 && (
              <tr style={{ borderTop: '1px solid rgba(255,255,255,0.03)', background: 'rgba(248,81,73,0.03)' }}>
                <td colSpan={4} style={{ paddingLeft: 32, paddingRight: 8, paddingTop: 4, paddingBottom: 6 }}>
                  <ExceptionSiteTable rows={typeSites} topN={siteTopN} />
                </td>
              </tr>
            )}
            {isSelected && typeSites.length === 0 && (() => {
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
                            {/* Same rule as the Timeout and OOM tabs: hidden when it
                                duplicates the stack frame printed underneath, shown
                                when they differ (thrown inside a library, frame in
                                your own code). */}
                            {d.method && d.method !== frame?.method && (
                              <span style={{ color: '#a371f7' }} title="Method that threw">{d.method}</span>
                            )}
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
                        <span
                          className="tabular-nums"
                          style={{ width: 46, textAlign: 'right', flexShrink: 0, color: '#f85149', fontWeight: 600, marginTop: 1 }}
                          title={`${count.toLocaleString()} sampled record${count === 1 ? '' : 's'}`}
                        >{count.toLocaleString()}</span>
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

  return (
    <>
    <div ref={cardRef} className="p-3">
    <Card
      className="overflow-hidden p-0 flex flex-col border-2"
      style={borderColor ? { borderColor } : undefined}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2 gap-2">
        <div
          className="flex items-center gap-2 flex-wrap cursor-pointer"
          onClick={() => setCardCollapsed(v => !v)}
          title={cardCollapsed ? `Expand ${platformName}` : `Collapse ${platformName}`}
        >
          <span className="relative inline-flex items-center justify-center w-3 h-3 flex-shrink-0">
            {status === 'healthy' && !isCopying && (
              <span className="absolute inline-flex w-full h-full rounded-full animate-ping opacity-60" style={{ backgroundColor: statusColor }} />
            )}
            <span className="relative inline-flex w-2.5 h-2.5 rounded-full" style={{ backgroundColor: statusColor }} />
          </span>
          <h2 className="font-bold text-base m-0">{platformName}</h2>
          {cardCollapsed
            ? <ChevronRight size={13} className="text-muted-foreground flex-shrink-0" />
            : <ChevronDown size={13} className="text-muted-foreground flex-shrink-0" />}
          <span className="text-xs text-muted-foreground">
            {typeLabel}{planMeta ? ` · ${planMeta}` : ''}
          </span>
          {/* Collapsed, the header is the only thing left, so it has to carry the two
              figures that decide whether the card is worth opening. */}
          {cardCollapsed && (
            <span className="text-xs">
              <span style={{ color: CHART_COLORS.cpuMax }}>CPU {(+metrics.cpu.max).toFixed(2)}%</span>
              <span className="text-muted-foreground"> · </span>
              <span style={{ color: CHART_COLORS.memMax }}>Mem {(+metrics.memory.max).toFixed(2)}{metrics.memUnit}</span>
            </span>
          )}
          {([
            { tag: 'Frontend',  show: true,   ai: feHasInsights },
            { tag: 'API', show: hasApi,  ai: apiHasInsights },
            { tag: 'DB',  show: hasDb,   ai: (metrics.dbCpu?.series?.length ?? 0) > 0 || (metrics.dbMemory?.series?.length ?? 0) > 0 },
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
                { key: 'database',     label: 'Database' },
                { key: 'users',        label: 'Users' },
                { key: 'performance',  label: 'Performance' },
                { key: 'exceptions',   label: 'Exceptions' },
                { key: 'instances',    label: 'Instances' },
                { key: 'uptimerobot',  label: 'UptimeRobot' },
                { key: 'snat',         label: 'SNAT Ports' },
                { key: 'restarts',     label: 'Restarts' },
                { key: 'frontend',     label: 'Frontend' },
                { key: 'api',          label: 'API' },
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
            onClick={openRcaDialog}
            title={rcaStatus === 'running' ? 'Downtime RCA analysis running…' : 'Downtime RCA Report (AI) — add investigation notes, then generate'}
            data-html2canvas-ignore="true"
          >
            <ScanSearch
              className="w-3.5 h-3.5"
              style={rcaStatus === 'running' ? {
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
            onClick={copyForTeams}
            style={{ visibility: (isCopying || isTeamsCopying) ? 'hidden' : 'visible' }}
            title="Copy for Teams (status header + chart image + metrics table)"
            data-html2canvas-ignore="true"
          >
            <Share2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Everything below the header. Unmounted rather than hidden when collapsed —
          hiding would keep every Recharts container alive, which is most of the cost
          of a card and the whole reason to collapse several of them. copyForTeams
          re-expands before capturing, since it reads [data-teams-chart] out of the DOM. */}
      {!cardCollapsed && (
      <>
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
      <div data-teams-chart>
        {/* dbCpu/dbMemory follow the Database block toggle, so hiding those rows
            hides their lines from the chart too. */}
        <CombinedChart
          cpu={metrics.cpu}
          memory={metrics.memory}
          dbCpu={visibleBlocks.database ? metrics.dbCpu : null}
          dbMemory={visibleBlocks.database ? metrics.dbMemory : null}
          downtimeIntervals={downtimeIntervals}
          urDowntimeIntervals={urDowntimeIntervals}
          availabilitySeries={undefined}
          instanceHealthSeries={null}
          apiInstanceHealthSeries={null}
          hiddenMetrics={hiddenMetrics}
          syncId={hoverSyncId}
          loading={false}
        />
        {/* The CPU / Memory / DB figures live here rather than in the table below:
            they belong to the lines directly above them, and clicking one drops
            that metric out of the plot. */}
        <MetricLegend
          hidden={hiddenMetrics}
          onToggle={key => setHiddenMetrics(prev => {
            const next = new Set(prev);
            if (!next.delete(key)) next.add(key);
            return next;
          })}
          items={[
            ...(visibleBlocks.cpu ? [{
              key: 'cpu', label: 'CPU',
              values: [
                { text: `${(+metrics.cpu.avg).toFixed(2)}%`, color: CHART_COLORS.cpuAvg },
                { text: `${(+metrics.cpu.p99).toFixed(2)}%`, color: CHART_COLORS.cpuMax },
                { text: `${(+metrics.cpu.max).toFixed(2)}%`, color: CHART_COLORS.cpuMax },
              ],
            }] : []),
            ...(visibleBlocks.memory ? [{
              key: 'memory', label: 'Memory',
              values: [
                { text: `${(+metrics.memory.avg).toFixed(2)}${metrics.memUnit}`, color: CHART_COLORS.memAvg },
                { text: `${(+metrics.memory.p99).toFixed(2)}${metrics.memUnit}`, color: CHART_COLORS.memMax },
                { text: `${(+metrics.memory.max).toFixed(2)}${metrics.memUnit}`, color: CHART_COLORS.memMax },
              ],
            }] : []),
            ...(visibleBlocks.database && (metrics.dbCpu?.series?.length ?? 0) > 0 ? [{
              key: 'dbCpu', label: 'DB CPU',
              values: [
                { text: `${(+metrics.dbCpu!.avg).toFixed(2)}%`, color: CHART_COLORS.dbCpuAvg },
                { text: `${(+metrics.dbCpu!.p99).toFixed(2)}%`, color: CHART_COLORS.dbCpuMax },
                { text: `${(+metrics.dbCpu!.max).toFixed(2)}%`, color: CHART_COLORS.dbCpuMax },
              ],
            }] : []),
            ...(visibleBlocks.database && (metrics.dbMemory?.series?.length ?? 0) > 0 ? [{
              key: 'dbMemory', label: 'DB Memory',
              values: [
                { text: `${(+metrics.dbMemory!.avg).toFixed(2)}%`, color: CHART_COLORS.dbMemAvg },
                { text: `${(+metrics.dbMemory!.p99).toFixed(2)}%`, color: CHART_COLORS.dbMemMax },
                { text: `${(+metrics.dbMemory!.max).toFixed(2)}%`, color: CHART_COLORS.dbMemMax },
              ],
            }] : []),
          ]}
        />
      </div>

      {/* Metrics + Downtime incidents */}
      <div className="px-4 pt-3 pb-3 text-xs font-medium flex flex-col gap-3">

        <div className="flex flex-col gap-2">
          <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1" style={{ tableLayout: 'fixed' }}><colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /></colgroup>
            {/* No column header: the rows left here no longer share one set of three
                figures — Instances lists per-instance health, UptimeRobot reports
                incidents and uptime — so Average / P99 / Max labelled none of them. The
                colgroup widths still line up with the FE / API blocks below. */}
            <tbody>
            {/* The app-level Users row lived here. It came from a frontend-only query, so
                an app's API had no user figures anywhere on the card — it is now a Users
                row inside each of the FE and API sections below, per App Insights
                resource, carrying the busiest addresses and agents alongside the line. */}
            {visibleBlocks.instances && (metrics.availability != null || (metrics.instances?.length ?? 0) > 0 || (metrics.apiInstances?.length ?? 0) > 0) && (() => {
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
              const hc = (v: number | null) => v == null ? '#8b9ab3' : v >= 99 ? '#3fb950' : v >= 90 ? '#d29922' : 'hsl(var(--destructive))';

              // Derived once and used by both the collapsed header summary and the
              // expanded chart, so the latest-health figures in the two can never
              // disagree.
              const rows = allInstances.map((inst, i) => {
                      const shortInstName = inst.name.split('_').slice(-1)[0] || inst.name;
                      const apiOnly = inst.role === 'api';
                      const activeSeries = apiOnly
                        ? (metrics.apiInstanceHealthSeries ?? [])
                        : (metrics.instanceHealthSeries ?? []);
                      const seriesIdx = activeSeries.findIndex(
                        s => s.name === inst.name ||
                             s.name.toLowerCase() === inst.name.toLowerCase() ||
                             s.name.toLowerCase().includes(shortInstName.toLowerCase()) ||
                             inst.name.toLowerCase().includes(s.name.toLowerCase())
                      );
                      const series = seriesIdx >= 0 ? activeSeries[seriesIdx] : undefined;
                      const points = series?.series ?? [];
                      const vals = points.map(p => p.v);
                      const apiOnlyIdx = apiOnly
                        ? apiInstances.filter(a => !feNames.has(a.name.toLowerCase())).findIndex(a => a.name === inst.name)
                        : -1;
                      const colorIdx = apiOnly
                        ? (feInstances.length + (apiOnlyIdx >= 0 ? apiOnlyIdx : i)) % INSTANCE_PALETTE.length
                        : seriesIdx >= 0 ? seriesIdx % INSTANCE_PALETTE.length : i % INSTANCE_PALETTE.length;
                      // API instances with no metric data still have an ARM health status.
                      const statusFallback = (apiOnly && inst.healthPct === null && !vals.length)
                        ? (inst.healthStatus === 'Healthy' ? 100 : inst.healthStatus === 'Degraded' ? 70 : inst.healthStatus === 'Stopped' ? 0 : null)
                        : null;
                      const fallbackPct = inst.healthPct ?? statusFallback;
                      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : fallbackPct;
                      const minVal = vals.length ? Math.min(...vals) : fallbackPct;
                      // Latest = the most recent bucket in which the instance actually
                      // served traffic. No-data buckets are excluded upstream, so this
                      // is a real reading rather than an assumed 100%.
                      const latest = vals.length ? (vals[vals.length - 1] ?? null) : fallbackPct;
                      const shortName = inst.name.split('_').slice(-2).join('_') || inst.name;
                      const seriesRoleName = series?.roleName ?? null;

                      // Lifecycle. A point exists in the series only for buckets where
                      // the instance produced traffic, so the first point ≈ when it came
                      // online and the last ≈ its final activity. An instance still
                      // reporting at the end of the range is shown as running to the
                      // range end rather than to its last bucket, which would otherwise
                      // read as though it had disappeared.
                      const firstSeenIso = points.length ? (points[0]?.t ?? null) : null;
                      const lastSeenIso = points.length ? (points[points.length - 1]?.t ?? null) : null;
                      const fmtDt = (iso: string) => new Date(iso).toLocaleString(undefined, {
                        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
                      });
                      const rangeEndMs = rangeEnd ? new Date(rangeEnd).getTime() : Date.now();
                      const stillActive = lastSeenIso
                        ? (rangeEndMs - new Date(lastSeenIso).getTime()) <= 15 * 60 * 1000
                        : false;
                      const lifecycle = firstSeenIso && lastSeenIso
                        ? `${fmtDt(firstSeenIso)} → ${stillActive ? fmtDt(new Date(rangeEndMs).toISOString()) : fmtDt(lastSeenIso)}`
                        : null;

                return {
                  name: inst.name,
                  label: seriesRoleName ? `${seriesRoleName}: ${shortName}` : shortName,
                  shortName, seriesRoleName, avg, minVal, latest, points,
                  lifecycle, stillActive,
                  color: INSTANCE_PALETTE[colorIdx] ?? '#8b9ab3',
                };
              }).filter(r => r.avg !== null || r.points.length > 0);

              return (
                <>
                  <tr
                    style={{ cursor: hasInstances ? 'pointer' : 'default' }}
                    onClick={() => hasInstances && setAvailExpanded(v => !v)}
                    onMouseEnter={e => hasInstances && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* The instances are dealt into the three figure columns rather than
                        wrapped as one long line: on a plan with eight workers that line
                        ran past the table and lined up with nothing. Filled row-major, so
                        they still read left to right. */}
                    <td className="text-muted-foreground font-bold">
                      <span title="Instances: individual App Service instances (scale-out units). Each instance has its own SNAT port allocation — more instances means more total SNAT ports available. Health % is request-derived per instance: (requests − 5xx) / requests.">Instances</span>
                      {hasInstances && (availExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />)}
                    </td>
                    {[0, 1, 2].map(col => (
                      <td key={col} style={{ verticalAlign: 'top' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                          {rows.filter((_, i) => i % 3 === col).map(r => (
                            <span key={r.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, maxWidth: '100%' }} title={`${r.name} — latest health`}>
                              <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                              <span style={{ color: r.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.shortName}</span>
                              <span className="tabular-nums" style={{ color: hc(r.latest), flexShrink: 0 }}>
                                {r.latest != null ? `${r.latest.toFixed(2)}%` : '—'}
                              </span>
                              {!r.stillActive && r.lifecycle && (
                                <span style={{ color: '#d29922', fontSize: 9, flexShrink: 0 }} title="Stopped reporting before the window ended.">stopped</span>
                              )}
                            </span>
                          ))}
                        </div>
                      </td>
                    ))}
                  </tr>
                  {availExpanded && rows.length > 0 && (
                    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                        {/* No left indent: the chart spans the full row width, and the
                            YAxis width already supplies the gutter its labels need.
                            Indenting here (as the removed per-instance rows did) just
                            left an empty strip beside the axis. */}
                        <td colSpan={4} style={{ padding: '8px 12px 10px 0' }}>
                          <InstanceHealthChart
                            instances={rows.map(r => ({ name: r.name, label: r.label, series: r.points }))}
                            colors={rows.map(r => r.color)}
                            height={150}
                            syncId={hoverSyncId}
                          />
                          {/* Legend doubles as the readout the removed rows carried:
                              colour, name, role, avg, min, and lifecycle range. */}
                          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '8px 18px', marginTop: 8 }}>
                            {rows.map(r => (
                              <div key={r.name} style={{ fontSize: 10, lineHeight: 1.4 }} title={r.name}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                  <span style={{ width: 8, height: 2, background: r.color, borderRadius: 1, flexShrink: 0 }} />
                                  <span style={{ color: r.color }}>{r.shortName}</span>
                                  {r.seriesRoleName && (
                                    <span style={{ fontSize: 9, color: '#484f58', fontWeight: 600, letterSpacing: '0.04em' }}>{r.seriesRoleName}</span>
                                  )}
                                  <span className="tabular-nums" style={{ color: hc(r.avg) }}>
                                    {r.avg != null ? `${r.avg.toFixed(2)}%` : '—'}
                                  </span>
                                  <span className="tabular-nums" style={{ color: '#6e7681' }}>
                                    min {r.minVal != null ? `${r.minVal.toFixed(2)}%` : '—'}
                                  </span>
                                </div>
                                {r.lifecycle && (
                                  <div style={{ fontSize: 9, color: '#6e7681', fontWeight: 400, marginTop: 1, paddingLeft: 13 }}>
                                    {r.lifecycle}
                                    {!r.stillActive && (
                                      <span
                                        style={{ marginLeft: 4, color: '#d29922' }}
                                        title="No traffic in the final buckets of the range — this instance stopped reporting before the window ended."
                                      >
                                        stopped
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                    </td>
                  </tr>
                  )}
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
              const fmtDur = (sec: number) => fmtDuration(sec * 1000);
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
                                      const failDuring = sumDuringUr(failSeries, ivStart, ivEnd);
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
            {/* SNAT ports are allocated per worker instance on the App Service plan.
                When FE and API share that plan both sites report the same numbers, so
                the section belongs to the app as a whole and sits here; on separate
                plans each site gets its own row inside its own block instead. */}
            {visibleBlocks.snat && metrics.type === 'appservice' && metrics.apiSharesPlan === true && (
              <SnatPortsRows
                syncId={hoverSyncId}
                snat={metrics.snat}
                loading={snatLoading}
                expanded={snatPortsExpanded}
                onToggle={() => setSnatPortsExpanded(v => { if (!v) onRequestSnat?.(); return !v; })}
              />
            )}
            </tbody>
          </table>
          </div>

          {(showFeBlock || showApiBlock) && (
          <div className={`grid gap-2 items-start ${showFeBlock && showApiBlock ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {showFeBlock && (
          <div className="rounded-md border border-border overflow-hidden min-w-0">
          <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1" style={{ tableLayout: 'fixed' }}><colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead>
              <tr
                className="text-muted-foreground font-bold"
                style={{ cursor: 'pointer' }}
                onClick={() => setFeSectionOpen(v => !v)}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title={feSectionOpen ? 'Collapse FE' : 'Expand FE'}
              >
                {/* One merged cell: the header carries only the label, so splitting it
                    across the four metric columns would just draw empty dividers. */}
                <td colSpan={4}>
                  FE{feSectionOpen
                    ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                    : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
                </td>
              </tr>
            </thead>
            {feSectionOpen && (
            <tbody>
            {/* Latency and errors per endpoint. Gated only on the toggle, matching Users:
                both are App Insights payloads that arrive with the lazy details fetch, and
                the ARM Requests metric this used to be gated on is a different source. */}
            {visibleBlocks.performance && (
              <PerformanceRows
                perf={metrics.requestInsights?.performance}
                expanded={perfExpanded}
                onToggle={() => setPerfExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                fmtMs={fmtDuration}
                fmtPct={fmtPct}
                syncId={hoverSyncId}
                deps={endpointDeps[`fe|${perfFeSelected}`]}
                onRequestDeps={requestFeDeps}
                loading={detailsLoading && !detailsLoaded}
                error={metrics.requestInsights?.error}
                unavailableMessage={detailsLoaded && !metrics.requestInsights ? 'Requires App Insights Application ID in settings' : undefined}
              />
            )}
            {visibleBlocks.users && (
              <UserRows
                users={metrics.requestInsights?.userInsights}
                userAgents={metrics.requestInsights?.userAgents}
                ipReputations={ipReputations}
                expanded={usersExpanded}
                onToggle={() => setUsersExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                syncId={hoverSyncId}
                loading={detailsLoading && !detailsLoaded}
                error={metrics.requestInsights?.error}
                unavailableMessage={detailsLoaded && !metrics.requestInsights ? 'Requires App Insights Application ID in settings' : undefined}
              />
            )}
            {visibleBlocks.exceptions && metrics.appInsightsConfigured && metrics.requestInsights && !metrics.requestInsights.error && (() => {
              const errorTypes = metrics.requestInsights.errorTypes ?? [];
              const hasDetail  = errorTypes.length > 0;
              const excCounts  = excBucketCounts(metrics.requestInsights);
              const errorCount = excCounts.total;
              if (errorCount === 0 && !hasDetail) return null;
              const errColor = errorCount === 0 ? '#3fb950' : errorCount <= 10 ? '#d29922' : '#f85149';
              // Generic tab = neither socket-layer nor timeout, split server-side. Falls back
              // to the unsplit list when the split queries did not run (older cache).
              const genericTypes   = metrics.requestInsights.errorTypesGeneric ?? errorTypes;
              const genericDetails = metrics.requestInsights.errorDetailsGeneric ?? metrics.requestInsights.errorDetails ?? [];
              const socketIns      = metrics.requestInsights.socketInsights ?? null;
              const timeoutIns     = metrics.requestInsights.timeoutInsights ?? null;
              const oomIns         = metrics.requestInsights.oomInsights ?? null;
              // The Unclassified tab lists generic types, so only generic-bucket
              // sites belong under them.
              const genericSites   = (metrics.requestInsights.excSites ?? []).filter(s => s.bucket === 'generic');
              return (
                <>
                  <tr
                    style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                    onClick={() => { if (hasDetail) { setErrorsExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setSelectedErrType(null); } }}
                    onMouseEnter={e => hasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* One cell across the whole row, label and total held apart by flex.
                        Exceptions reports a single figure, and any second cell — even an
                        empty one — draws its own bordered box. */}
                    <td colSpan={4}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground font-bold">
                          <span title="Exceptions: unhandled application exceptions captured by App Insights, grouped by type. Split into four mutually exclusive tabs: Socket (transport failed, no connection), Timeout (connected, caller gave up waiting), OOM (out of memory), Unclassified (everything else). Counts sum to this total.">Exceptions</span>
                          {hasDetail && (errorsExpanded
                            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                          )}
                        </span>
                        <span className="tabular-nums" style={{ color: errColor }} title={excCounts.breakdown}>{errorCount.toLocaleString()}</span>
                      </div>
                    </td>
                  </tr>
                  {errorsExpanded && hasDetail && detailsLoading && !detailsLoaded && (
                    <ListSkeletonRow />
                  )}
                  {errorsExpanded && hasDetail && (!detailsLoading || detailsLoaded) && (
                    <>
                      <ExcTabRow value={errTab} onChange={setErrTab} counts={excCounts} />
                      <ExcLocationChartRow
                        sites={metrics.requestInsights.excLocationSeries}
                        bucket={errTab}
                        bin={metrics.requestInsights.excLocationBin}
                        topN={metrics.requestInsights.excLocationTopN}
                        error={metrics.requestInsights.excLocationError}
                        syncId={hoverSyncId}
                      />
                      {errTab === 'generic'
                        ? renderErrTypes(genericTypes, genericDetails, selectedErrType, setSelectedErrType, genericSites, metrics.requestInsights.excSiteTopN)
                        : errTab === 'timeout'
                        ? renderTimeoutTab(timeoutIns, fmtExcTime)
                        : errTab === 'oom'
                        ? renderOomTab(oomIns)
                        : renderSocketTab(socketIns, metrics.socketMetrics, fmtExcTime)}
                    </>
                  )}
                </>
              );
            })()}
            {/* Restarts sit below Exceptions: a restart explains a gap the rows above
                already showed you, and an App Crash here is often the same event the
                exception list just named — so it reads as the answer to them rather than
                as a fact on its own. The summary loads with the card; only the event
                table and the detector's written findings wait for the expand. */}
            {visibleBlocks.restarts && metrics.type === 'appservice' && (
              <RestartRows
                restarts={restarts}
                loading={restartsLoading}
                expanded={restartsExpanded}
                // Expanding re-asks only when the eager fetch left us with nothing. A
                // successful empty result is remembered by the hook's guard, so this
                // retries a failed detector call without re-fetching a site that
                // genuinely has no restart detector.
                onToggle={() => setRestartsExpanded(v => { if (!v && !restarts) onRequestRestarts?.(); return !v; })}
                syncId={hoverSyncId}
              />
            )}
            {/* Only when the API is on its own plan (or there is no API) — a shared
                plan puts one section in the main table instead. */}
            {visibleBlocks.snat && metrics.type === 'appservice' && metrics.apiSharesPlan !== true && (
              <SnatPortsRows
                syncId={hoverSyncId}
                snat={metrics.snat}
                loading={snatLoading}
                expanded={snatPortsExpanded}
                onToggle={() => setSnatPortsExpanded(v => { if (!v) onRequestSnat?.(); return !v; })}
              />
            )}
            </tbody>
            )}
          </table>
          </div>
          )}

          {showApiBlock && (
          <div className="rounded-md border border-border overflow-hidden min-w-0">
          <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1" style={{ tableLayout: 'fixed' }}><colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead>
              <tr
                className="text-muted-foreground font-bold"
                style={{ cursor: 'pointer' }}
                onClick={() => setApiSectionOpen(v => !v)}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title={apiSectionOpen ? 'Collapse API' : 'Expand API'}
              >
                <td colSpan={4}>
                  API{apiSectionOpen
                    ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                    : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
                </td>
              </tr>
            </thead>
            {apiSectionOpen && (
            <tbody>
              {/* Same drill-down as the FE section — see the comment there. Per App
                  Insights resource, so the API's endpoints are its own. */}
              {visibleBlocks.performance && apiHasInsights && (
                <PerformanceRows
                  perf={metrics.apiRequestInsights?.performance}
                  expanded={perfAPIExpanded}
                  onToggle={() => setPerfAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                  fmtMs={fmtDuration}
                  fmtPct={fmtPct}
                  syncId={hoverSyncId}
                  deps={endpointDeps[`api|${perfApiSelected}`]}
                  onRequestDeps={requestApiDeps}
                  loading={detailsLoading && !detailsLoaded}
                  error={metrics.apiRequestInsights?.error}
                />
              )}
              {visibleBlocks.users && apiHasInsights && (
                <UserRows
                  users={metrics.apiRequestInsights?.userInsights}
                  userAgents={metrics.apiRequestInsights?.userAgents}
                  ipReputations={ipReputations}
                  expanded={usersAPIExpanded}
                  onToggle={() => setUsersAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; })}
                  syncId={hoverSyncId}
                  loading={detailsLoading && !detailsLoaded}
                  error={metrics.apiRequestInsights?.error}
                />
              )}
              {visibleBlocks.exceptions && apiHasInsights && metrics.apiRequestInsights && !metrics.apiRequestInsights.error && (() => {
                const apiErrorTypes = metrics.apiRequestInsights.errorTypes ?? [];
                const apiHasDetail  = apiErrorTypes.length > 0;
                const apiExcCounts  = excBucketCounts(metrics.apiRequestInsights);
                const apiErrorCount = apiExcCounts.total;
                const apiErrColor = apiErrorCount === 0 ? '#3fb950' : apiErrorCount <= 10 ? '#d29922' : '#f85149';
                const apiGenericTypes   = metrics.apiRequestInsights.errorTypesGeneric ?? apiErrorTypes;
                const apiGenericDetails = metrics.apiRequestInsights.errorDetailsGeneric ?? metrics.apiRequestInsights.errorDetails ?? [];
                const apiSocketIns      = metrics.apiRequestInsights.socketInsights ?? null;
                const apiTimeoutIns     = metrics.apiRequestInsights.timeoutInsights ?? null;
                const apiOomIns         = metrics.apiRequestInsights.oomInsights ?? null;
                const apiGenericSites   = (metrics.apiRequestInsights.excSites ?? []).filter(s => s.bucket === 'generic');
                return (
                  <>
                    <tr
                      style={{ cursor: apiHasDetail ? 'pointer' : 'default' }}
                      onClick={() => { if (apiHasDetail) { setErrAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setSelectedErrAPIType(null); } }}
                      onMouseEnter={e => apiHasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* One cell, as in the FE block above. */}
                      <td colSpan={4}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-muted-foreground font-bold">
                            <span title="Exceptions: unhandled application exceptions captured by App Insights, grouped by type. Split into four mutually exclusive tabs: Socket (transport failed, no connection), Timeout (connected, caller gave up waiting), OOM (out of memory), Unclassified (everything else). Counts sum to this total.">Exceptions</span>
                            {apiHasDetail && (errAPIExpanded
                              ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                              : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                            )}
                          </span>
                          <span className="tabular-nums" style={{ color: apiErrColor }} title={apiExcCounts.breakdown}>{apiErrorCount.toLocaleString()}</span>
                        </div>
                      </td>
                    </tr>
                    {errAPIExpanded && apiHasDetail && detailsLoading && !detailsLoaded && (
                      <ListSkeletonRow />
                    )}
                    {errAPIExpanded && apiHasDetail && (!detailsLoading || detailsLoaded) && (
                      <>
                        <ExcTabRow value={errAPITab} onChange={setErrAPITab} counts={apiExcCounts} />
                        <ExcLocationChartRow
                          sites={metrics.apiRequestInsights.excLocationSeries}
                          bucket={errAPITab}
                          bin={metrics.apiRequestInsights.excLocationBin}
                          topN={metrics.apiRequestInsights.excLocationTopN}
                          error={metrics.apiRequestInsights.excLocationError}
                          syncId={hoverSyncId}
                        />
                        {errAPITab === 'generic'
                          ? renderErrTypes(apiGenericTypes, apiGenericDetails, selectedErrAPIType, setSelectedErrAPIType, apiGenericSites, metrics.apiRequestInsights.excSiteTopN)
                          : errAPITab === 'timeout'
                          ? renderTimeoutTab(apiTimeoutIns, fmtExcTime)
                          : errAPITab === 'oom'
                          ? renderOomTab(apiOomIns)
                          : renderSocketTab(apiSocketIns, metrics.apiSocketMetrics, fmtExcTime)}
                      </>
                    )}
                  </>
                );
              })()}
              {/* Below Exceptions, as in the FE block above. */}
              {visibleBlocks.restarts && (appConfig?.apiType || 'appservice') === 'appservice' && (
                <RestartRows
                  restarts={apiRestarts}
                  loading={restartsLoading}
                  expanded={restartsAPIExpanded}
                  onToggle={() => setRestartsAPIExpanded(v => { if (!v && !apiRestarts) onRequestRestarts?.(); return !v; })}
                  syncId={hoverSyncId}
                />
              )}
              {/* Own plan only: on a shared plan these figures would repeat the
                  frontend's, and the main table carries them once instead. */}
              {visibleBlocks.snat && (appConfig?.apiType || 'appservice') === 'appservice' && metrics.apiSharesPlan === false && (
                <SnatPortsRows
                  syncId={hoverSyncId}
                  snat={metrics.apiSnat}
                  loading={snatLoading}
                  expanded={snatApiPortsExpanded}
                  onToggle={() => setSnatApiPortsExpanded(v => { if (!v) onRequestSnat?.(); return !v; })}
                />
              )}
            </tbody>
            )}
          </table>
          </div>
          )}
          </div>
          )}
        </div>


      </div>

      {visibleBlocks.remarks && (
        <div className="px-4 pb-3" data-remarks>
          {/* Same bordered card as the DB / FE / API / RCA blocks: the header carries
              the "Remarks" label, so the body renders the text without its own prefix. */}
          <div className="rounded-md border border-border overflow-hidden">
            <div
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-muted-foreground cursor-pointer"
              onClick={() => setRemarksOpen(v => !v)}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              title={remarksOpen ? 'Collapse Remarks' : 'Expand Remarks'}
            >
              <span>Remarks{aiRemark ? ' (AI)' : ''}</span>
              {remarksOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <button
                onClick={e => { e.stopPropagation(); generateAiRemarks(); }}
                disabled={aiRemarkLoading}
                className="ml-auto p-0.5 rounded hover:bg-muted flex-shrink-0 disabled:opacity-50"
                title={aiRemarkLoading ? 'Generating AI remarks…' : 'Generate AI remarks (Claude health verdict)'}
                data-html2canvas-ignore="true"
              >
                <Sparkles className={`w-3.5 h-3.5 ${aiRemarkLoading ? 'animate-pulse text-blue-400' : 'text-muted-foreground'}`} />
              </button>
            </div>
            {remarksOpen && (
              <div className="border-t border-border px-3 py-2">
                {aiRemark ? (
                  <div className="text-xs" style={{ color: AI_STATUS_COLORS[aiRemark.status], fontWeight: 600 }}>
                    {aiRemark.remarks}
                  </div>
                ) : (
                  <AppRemarks metrics={metrics} rangeStart={rangeStart} rangeEnd={rangeEnd} visibleBlocks={visibleBlocks} urMonitors={urMonitors} hideLabel />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <RcaSection
        open={rcaSectionOpen}
        onToggle={() => setRcaSectionOpen(v => !v)}
        status={rcaStatus}
        markdown={rcaText}
        stages={rcaStages}
        error={rcaError}
        onGenerate={(notes, given) => void handleRunRca(notes, 'business', given)}
        onDraftChange={setRcaDraft}
        defaultTitle={`${platformName} Downtime`}
        defaultServices={(platformUrls.length ? platformUrls : [platformName, appConfig?.apiName].filter(Boolean)).join(', ')}
        period={incidentPeriod}
        periodSource={urDowntimeIntervals.length > 0 ? 'uptimerobot' : downtimeIntervals.length > 0 ? 'azure' : 'none'}
        onExportPdf={exportRcaPdf}
        onExportWord={exportRcaWord}
        onCopyTeams={copyRcaForTeams}
        onCopySummary={copySummaryForTeams}
      />
      </>
      )}

    </Card>
    </div>

    <RcaDialog
      open={rcaOpen}
      onOpenChange={setRcaOpen}
      title={platformName}
      status={rcaStatus}
      markdown={rcaText}
      stages={rcaStages}
      error={rcaError}
      onExport={exportRca}
      onExportPdf={exportRcaPdf}
      onCopyTeams={copyRcaForTeams}
      onCopySummary={copySummaryForTeams}
      onGenerate={handleRunRca}
    />

    </>
  );
}
