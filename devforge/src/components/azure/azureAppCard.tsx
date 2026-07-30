import React, { useState, useEffect, useCallback } from 'react';
import { Share2, ChevronDown, ChevronRight, Sparkles, SlidersHorizontal, ScanSearch } from 'lucide-react';
import { marked } from 'marked';
import { toast } from 'sonner';
import { RcaDialog, type RcaStatus } from './rcaDialog';
import {
  buildRcaPrintHtml, formatSgt, formatSgtRange, splitQuickSummary,
  buildQuickSummaryTeamsHtml, buildQuickSummaryTeamsText,
} from './rcaHtml';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import type { AppMetrics, SocketInsights, TimeoutInsights, OomInsights, SocketCounters } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { CombinedChart, SeriesChart, InstanceHealthChart, CHART_COLORS, INSTANCE_PALETTE } from './azureMetricChart';
import { AppRemarks, buildRemarks } from './azureAppRemarks';
import { useCopyElementAsImage, loadHtml2Canvas } from '@/hooks/useCopyElementAsImage';
import { useUptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { useIpReputation } from '@/hooks/useIpReputation';
import type { IpReputation } from '@/lib/ipapiIs';

const IP_REP_FLAGS: Array<{ key: keyof IpReputation; label: string; color: string }> = [
  { key: 'isCrawler',    label: 'crawler',    color: '#f85149' },
  { key: 'isAbuser',     label: 'abuser',     color: '#f85149' },
  { key: 'isTor',        label: 'tor',        color: '#f85149' },
  { key: 'isProxy',      label: 'proxy',      color: '#f97316' },
  { key: 'isVpn',        label: 'vpn',        color: '#f97316' },
  { key: 'isDatacenter', label: 'datacenter', color: '#f97316' },
  { key: 'isBogon',      label: 'bogon',      color: '#8b949e' },
  { key: 'isMobile',     label: 'mobile',     color: '#58a6ff' },
  { key: 'isSatellite',  label: 'satellite',  color: '#58a6ff' },
];

function IpRepBadges({ rep }: { rep: IpReputation | undefined }) {
  if (!rep) return null;
  if (rep.error) return <span title={`ipapi.is error: ${rep.error}`} style={{ marginLeft: 5, color: '#d29922', fontWeight: 600 }}>⚠ ipapi</span>;
  const active = IP_REP_FLAGS.filter(f => rep[f.key]);
  if (!active.length) return <span style={{ marginLeft: 5, color: '#3fb950', fontWeight: 600 }}>● clean</span>;
  return (
    <>
      {active.map(f => (
        <span
          key={f.label}
          title={f.key === 'isCrawler' && rep.crawlerName ? `crawler: ${rep.crawlerName}` : rep.companyName ?? undefined}
          style={{
            marginLeft: 4, fontSize: 9, fontWeight: 600, color: f.color,
            border: `1px solid ${f.color}66`, background: `${f.color}22`,
            borderRadius: 3, padding: '0 4px',
          }}
        >
          {f.label}
        </span>
      ))}
    </>
  );
}

// No "All": the top-dependency query ranks the top 10 per classification, so a
// combined view is the union of two independent rankings rather than a real global
// top-N. Internal and third-party are the two meaningful lists.
const DEPS_FILTERS = [
  { key: 'internal',   label: 'Internal',    color: '#3fb950' },
  { key: 'thirdParty', label: 'Third-Party', color: '#d29922' },
  { key: 'assets',     label: 'Assets',      color: '#8b9ab3' },
] as const;
type DepsFilter = typeof DEPS_FILTERS[number]['key'];

function DepsFilterPills({ value, onChange }: { value: DepsFilter; onChange: (v: DepsFilter) => void }) {
  return (
    <div className="flex gap-0.5" style={{ marginTop: 3 }}>
      {DEPS_FILTERS.map(f => (
        <button
          key={f.key}
          onClick={e => { e.stopPropagation(); onChange(f.key); }}
          style={{
            background: value === f.key ? `${f.color}22` : 'none',
            border: `1px solid ${value === f.key ? `${f.color}66` : 'transparent'}`,
            color: value === f.key ? f.color : 'var(--muted-foreground)',
            borderRadius: 4, padding: '1px 6px', fontSize: 9,
            cursor: 'pointer', fontWeight: value === f.key ? 600 : 400,
          }}
        >{f.label}</button>
      ))}
    </div>
  );
}

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
const OOM_ACCENT     = '#a371f7';

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

/** What each timeout-class result code means, so a row is self-explanatory. */
const RESULT_CODE_HELP: Record<string, string> = {
  '408':      '408 Request Timeout — the server gave up waiting for the request.',
  '504':      '504 Gateway Timeout — an upstream proxy timed out waiting for the origin.',
  '524':      '524 — Cloudflare timed out waiting for the origin to respond.',
  'Canceled': 'The .NET HttpClient deadline elapsed and cancelled the call. The duration is the configured timeout.',
  '-2':       'SQL Server timeout error code — the command exceeded CommandTimeout.',
};

const RESULT_CODE_COLOR = (code: string) => (code === '-2' || code === '524' ? '#f85149' : '#d29922');


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

/** Sub-tab pill colours for the Requests breakdown, reused by the summary row so
 *  the 5xx / 4xx figures match the tab you click to drill into them. */
const HTTP_4XX_COLOR = '#f97316';
const HTTP_5XX_COLOR = '#f85149';

/** Same idea for the Dependencies breakdown pills (Top / Failed / Timeout Deps). */
const DEP_TOTAL_COLOR   = '#58a6ff';
const DEP_FAILED_COLOR  = '#f85149';
const DEP_TIMEOUT_COLOR = '#f97316';

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
  // Divisor 400, not the original 25: the timeout-class result-code filter now catches
  // Cloudflare 524s, HttpClient cancellations and SQL -2, and the count is corrected for
  // ingestion sampling, so real apps land in the hundreds. At 25 every one of them
  // clamped to 1.0 and the contributor could not discriminate at all.
  const depTimeoutScore = Math.min(dependencyTimeouts / 400, 1.0);
  const depP99Score     = Math.min(dependencyP99Ms / 5000, 1.0);
  const connGrowth      = Math.max(connectionCurrent - connectionBaseline, 0);
  const connGrowthScore = Math.min(connGrowth / 64, 1.0);
  const http5xxScore    = Math.min(http5xxRate / 5, 1.0);

  // Weights sum to 1.00. socketScore now counts socket-layer exceptions only
  // (SOCKET_MATCH); it previously used a filter that also matched any "timeout"
  // message, double-counting evidence already scored by depTimeoutScore. Weight
  // moved from socket (0.30 → 0.20) to dependency timeouts (0.20 → 0.30) so
  // timeout evidence keeps its proportional influence on the score.
  const baseConfidence = 100 * (
    0.20 * socketScore +
    0.25 * depFailScore +
    0.30 * depTimeoutScore +
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


const AI_STATUS_COLORS = { healthy: '#3fb950', warning: '#d29922', critical: '#f85149' } as const;

/** The CPI verdict, shown on the collapsed row so the diagnosis is visible without
 *  expanding. Score bands mirror snatScore's label thresholds. */
function snatVerdict(score: number, socketExc: number): { text: string; color: string; bold: boolean } | null {
  if (score >= 81 && socketExc > 0)  return { text: '🔴 Probable SNAT Port Exhaustion — socket-layer exceptions detected with critical score', color: '#f85149', bold: true };
  if (score >= 61 && socketExc > 0)  return { text: '⚠ SNAT port pressure detected — monitor socket exception trend', color: '#e6773d', bold: false };
  if (score >= 81 && socketExc === 0) return { text: '🔴 Critical SNAT risk — check network connectivity and dependency health', color: '#f85149', bold: false };
  return null;
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
  socket:  'Socket Exceptions: transport-layer failures only — SocketException, ENOBUFS, "No buffer space available", connection refused, ETIMEDOUT, SNAT. No connection was established. Application timeouts are excluded (they are scored by Dependencies Timeouts). Weight 0.20. Source: requestInsights.insight.socketLayerExceptions',
  depFail: 'Dependencies Failure Rate: percentage of failed dependency calls. Source: App Insights dependencies where success == false / totalDependencies × 100',
  depTO:   'Dependencies Timeouts: dependency calls returning a genuine timeout result code — 408 Request Timeout, 504 Gateway Timeout, 524 (Cloudflare origin timeout), Canceled (HttpClient deadline elapsed), and SQL -2 (command timeout). 500/502/503 are server errors, not timeouts, and are excluded. Carries the timeout evidence that used to be double-counted inside the socket signal — weight 0.30. Source: requestInsights.dependencyTimeouts',
  depP99:  'Dependencies P99: 99th-percentile dependency call duration in ms. Source: App Insights percentile(duration, 99) on dependencies',
  conn:    'Connection Growth: increase in active TCP connections (second-half avg − first-half avg). Source: Azure Monitor AppConnections metric',
  http5xx: 'HTTP 5xx Rate: percentage of requests returning 5xx status. Source: App Insights requests where resultCode startswith "5" / totalRequests × 100',
} as const;

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className ?? ''}`} />;
}

export function AzureAppCard({ appKey, metrics, loading, detailsLoading = false, detailsLoaded = false, onRequestDetails, azureSettings, uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd }: AzureAppCardProps) {
  const { elementRef: cardRef, isCopying } = useCopyElementAsImage<HTMLDivElement>({
    fileNamePrefix: `azure-${appKey}-${Date.now()}`,
    backgroundColor: '#09090b',
  });

  const { monitors: urMonitors, loading: urLoading, error: urError } = useUptimeRobotMonitor(uptimeRobotApiKey, uptimeRobotMonitorIds, rangeStart, rangeEnd);
  const highFreqIps = [
    ...(metrics.requestInsights?.highFreq ?? []),
    ...(metrics.apiRequestInsights?.highFreq ?? []),
  ].map(u => u.ip);
  const ipReputations = useIpReputation(highFreqIps);
  const [urExpanded, setUrExpanded] = useState(false);
  const [requestsExpanded, setRequestsExpanded] = useState(false);
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [usersExpanded, setUsersExpanded] = useState(false);
  const [connExpanded, setConnExpanded] = useState(false);
  const [connAPIExpanded, setConnAPIExpanded] = useState(false);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [errTab, setErrTab] = useState<ExcTab>('generic');
  const [errAPITab, setErrAPITab] = useState<ExcTab>('generic');
  const [availExpanded, setAvailExpanded] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [visibleBlocks, setVisibleBlocks] = useState({
    remarks: true, cpu: true, memory: true, database: true, response: true, users: true, requests: true,
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
  const [depsFilter, setDepsFilter] = useState<DepsFilter>('internal');
  const [depsAPITab, setDepsAPITab] = useState<'topDeps' | 'failedDeps' | 'timeoutDeps'>('topDeps');
  const [depsAPIFilter, setDepsAPIFilter] = useState<DepsFilter>('internal');
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

  const handleRunRca = useCallback(async () => {
    setRcaOpen(true);
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

  const exportRcaPdf = useCallback(async () => {
    try {
      const { startMs, endMs } = buildIncidentPayload();
      // HTML is built here rather than in main: `marked` and the print stylesheet
      // both live on the renderer side, and this keeps the printed report in step
      // with what the dialog shows.
      const html = buildRcaPrintHtml(rcaText, {
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
  }, [appKey, buildIncidentPayload, rcaText]);

  // Just the plain-English summary, formatted for a Teams chat — the part that
  // gets shared with non-engineers, without the full report attached.
  const copySummaryForTeams = useCallback(async () => {
    try {
      const { summary } = splitQuickSummary(rcaText);
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
        responseTimeSec: metrics.responseTime ? { avg: metrics.responseTime.avg, p99: metrics.responseTime.p99 ?? null, max: metrics.responseTime.max } : null,
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
  ): React.ReactNode => (
    types.length === 0
      ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No exception type data</td></tr>
      : <>{types.map((e, i) => {
        const isSelected = selType === e.type;
        const filtered = (details ?? []).filter(d => d.type === e.type);
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
                { key: 'response',     label: 'Response' },
                { key: 'users',        label: 'Users' },
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
            title="Generate RCA Report from captured metrics"
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
            onClick={copyForTeams}
            style={{ visibility: (isCopying || isTeamsCopying) ? 'hidden' : 'visible' }}
            title="Copy for Teams (status header + chart image + metrics table)"
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
          loading={false}
        />
      </div>

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
                <td className="text-right" style={{ color: '#58a6ff' }}>{fmtDuration(metrics.responseTime.avg * 1000)}</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{fmtDuration(metrics.responseTime.p99 != null ? metrics.responseTime.p99 * 1000 : null)}</td>
                <td className="text-right" style={{ color: '#58a6ff' }}>{fmtDuration(metrics.responseTime.max * 1000)}</td>
              </tr>
            )}
            {visibleBlocks.users && metrics.users != null && (() => {
              const fmtSgt = (t: string) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
              const series = metrics.users.series ?? [];
              const firstPoint = series[0];
              const lastPoint = series[series.length - 1];
              const maxPoint = series.reduce<typeof series[number] | null>((best, p) => (best == null || p.m > best.m ? p : best), null);
              const p99Val = metrics.users.p99;
              const p99Point = series.reduce<typeof series[number] | null>((best, p) => (best == null || Math.abs(p.v - p99Val) < Math.abs(best.v - p99Val) ? p : best), null);
              const hasSeries = series.length > 1;
              return (
                <>
                  <tr
                    style={{ cursor: hasSeries ? 'pointer' : 'default' }}
                    onClick={() => hasSeries && setUsersExpanded(v => !v)}
                    onMouseEnter={e => hasSeries && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold" title="Users: distinct client IPs seen in requests per time bucket, sourced from App Insights (Frontend only). Average/P99/Max are computed across buckets, not across individual requests.">
                      Users
                      {hasSeries && (usersExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      )}
                    </td>
                    <td className="text-right" style={{ color: '#a371f7' }} title={firstPoint && lastPoint ? `Across ${series.length} time buckets from ${fmtSgt(firstPoint.t)} to ${fmtSgt(lastPoint.t)} SGT` : undefined}>{metrics.users.avg}</td>
                    <td className="text-right" style={{ color: '#a371f7' }} title={p99Point ? `Closest bucket at ${fmtSgt(p99Point.t)} SGT (${p99Point.v} users)` : undefined}>{metrics.users.p99}</td>
                    <td className="text-right" style={{ color: '#a371f7' }} title={maxPoint ? `Peak at ${fmtSgt(maxPoint.t)} SGT` : undefined}>{metrics.users.max}</td>
                  </tr>
                  {usersExpanded && hasSeries && (
                    <tr>
                      <td colSpan={4} style={{ paddingTop: 4, paddingBottom: 6 }}>
                        <SeriesChart series={series} color="#a371f7" name="Users" height={130} />
                        <div style={{ fontSize: 9, color: '#484f58', paddingLeft: 8 }}>
                          Distinct client IPs per time bucket — one value per bucket, so the Average / P99 / Max above are computed across buckets, not within them.
                          {maxPoint ? ` Peak ${maxPoint.m.toLocaleString()} at ${fmtSgt(maxPoint.t)} SGT.` : ''}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              );
            })()}
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
                    {/* Merged: the old empty cells only drew column dividers across an
                        otherwise blank row. One cell carries the label plus each
                        instance's latest health, so the collapsed row still says which
                        instances exist and how they are doing right now. */}
                    <td colSpan={4}>
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 10px' }}>
                        <span className="text-muted-foreground font-bold">
                          <span title="Instances: individual App Service instances (scale-out units). Each instance has its own SNAT port allocation — more instances means more total SNAT ports available. Health % is request-derived per instance: (requests − 5xx) / requests.">Instances</span>
                          {hasInstances && (availExpanded
                            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />)}
                        </span>
                        {rows.length > 0 && (
                          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 12px' }}>
                            {rows.map(r => (
                              <span key={r.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10 }} title={`${r.name} — latest health`}>
                                <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                                <span style={{ color: r.color }}>{r.shortName}</span>
                                <span className="tabular-nums" style={{ color: hc(r.latest) }}>
                                  {r.latest != null ? `${r.latest.toFixed(2)}%` : '—'}
                                </span>
                                {!r.stillActive && r.lifecycle && (
                                  <span style={{ color: '#d29922', fontSize: 9 }} title="Stopped reporting before the window ended.">stopped</span>
                                )}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                    </td>
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

          {visibleBlocks.database && ((metrics.dbCpu?.series?.length ?? 0) > 0 || (metrics.dbMemory?.series?.length ?? 0) > 0) && (
          <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full border-collapse [&_td]:px-3 [&_td]:py-1" style={{ tableLayout: 'fixed' }}><colgroup><col style={{ width: '40%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead>
              <tr className="text-muted-foreground font-bold">
                <td>Database</td>
                <td className="text-right">Average</td>
                <td className="text-right">P99</td>
                <td className="text-right">Max</td>
              </tr>
            </thead>
            <tbody>
            {(metrics.dbCpu?.series?.length ?? 0) > 0 && (
              <tr>
                <td className="text-muted-foreground font-bold" title="DB CPU: average and max CPU utilization of the Azure SQL database (vCore/serverless), sourced from Azure Monitor cpu_percent metric.">CPU</td>
                <td className="text-right" style={{ color: CHART_COLORS.dbCpuAvg }}>{(+metrics.dbCpu!.avg).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.dbCpuMax }}>{(+metrics.dbCpu!.p99).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.dbCpuMax }}>{(+metrics.dbCpu!.max).toFixed(2)}%</td>
              </tr>
            )}
            {(metrics.dbMemory?.series?.length ?? 0) > 0 && (
              <tr>
                <td className="text-muted-foreground font-bold" title="DB Memory: average and max memory utilization of the Azure SQL instance, sourced from Azure Monitor sql_instance_memory_percent metric.">Memory</td>
                <td className="text-right" style={{ color: CHART_COLORS.dbMemAvg }}>{(+metrics.dbMemory!.avg).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.dbMemMax }}>{(+metrics.dbMemory!.p99).toFixed(2)}%</td>
                <td className="text-right" style={{ color: CHART_COLORS.dbMemMax }}>{(+metrics.dbMemory!.max).toFixed(2)}%</td>
              </tr>
            )}
            </tbody>
          </table>
          </div>
          )}

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
                    const feSeries = metrics.failedRequestsSeries ?? [];
                    const feMid = Math.floor(feSeries.length / 2);
                    const feAvg = (arr: typeof feSeries) => arr.length ? arr.reduce((s, p) => s + (p.count ?? 0), 0) / arr.length : 0;
                    const fe1 = feAvg(feSeries.slice(0, feMid)); const fe2 = feAvg(feSeries.slice(feMid));
                    const isSpiking5xx = feSeries.length >= 2 && fe2 >= 1 && fe2 > fe1 * 1.05;
                    return (
                      <>
                        <td className="text-right tabular-nums text-muted-foreground">—</td>
                        <td className="text-right" style={{ color: '#58a6ff' }}>
                          {fmtDuration(ai?.insight?.requestP99)}
                        </td>
                        {/* 5xx (% of total) / 4xx (% of total) / total — the 5xx count
                            moved here from its own cell so all three read together. */}
                        <td
                          className="text-right"
                          style={{ whiteSpace: 'nowrap' }}
                          title={`${total5xx.toLocaleString()} server errors (5xx) and ${total4xx.toLocaleString()} client errors (4xx) out of ${reqTotal.toLocaleString()} requests — ${pct.toFixed(2)}% failed overall.${isSpiking5xx ? ' 5xx rate is rising across the window.' : ''}`}
                        >
                          {errTotal > 0
                            ? <>
                                <span style={{ color: total5xx > 0 ? HTTP_5XX_COLOR : '#484f58', fontSize: 10, fontWeight: isSpiking5xx ? 700 : 400 }}>{total5xx.toLocaleString()} ({fmtPct(total5xx, reqTotal)})</span>
                                <span style={{ color: '#484f58' }}> / </span>
                                <span style={{ color: total4xx > 0 ? HTTP_4XX_COLOR : '#484f58', fontSize: 10 }}>{total4xx.toLocaleString()} ({fmtPct(total4xx, reqTotal)})</span>
                                <span style={{ color: '#484f58' }}> / </span>
                                <span style={{ color: '#58a6ff' }}>{reqTotal.toLocaleString()}</span>
                              </>
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
                                    {(['requests', 'highfreq', 'http4xx', 'http5xx', 'bots'] as const).map(t => {
                                      const labels: Record<string, string> = { highfreq: 'High Freq', http4xx: 'HTTP 4xx', http5xx: 'HTTP 5xx', requests: 'Top', bots: 'User Agents' };
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
                                          const rep = ipReputations[u.ip];
                                          return (
                                            <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                              <div className="flex flex-col min-w-0 flex-1">
                                                <span className="truncate" style={{ color: textColor ?? 'var(--muted-foreground)' }}>
                                                  {u.ip || '(unknown)'}{u.country ? ` - ${u.country}` : ''} · {fmtSgt(start)} → {fmtSgt(end)} SGT
                                                  <IpRepBadges rep={rep} />
                                                </span>
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
              const hasSeries = feConPts.length > 1;
              return (
                <>
                  <tr
                    style={{ cursor: hasSeries ? 'pointer' : 'default' }}
                    onClick={() => hasSeries && setConnExpanded(v => !v)}
                    onMouseEnter={e => hasSeries && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold" title="Connections: active outbound TCP connections from the App Service instance(s), sourced from Azure Monitor AppConnections metric. Growing connection counts can indicate SNAT port accumulation or connection pool leaks.">
                      Connections
                      {hasSeries && (connExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      )}
                    </td>
                    <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                      {trend
                        ? <span style={{ fontSize: 10, color: trendColor }}>Trend - {Math.round(a1)} {trend} {Math.round(a2)}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.connections.p99)}</td>
                    <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.connections.max)}</td>
                  </tr>
                  {connExpanded && hasSeries && (
                    <tr>
                      <td colSpan={4} style={{ paddingTop: 4, paddingBottom: 6 }}>
                        <SeriesChart series={feConPts} color="#22d3ee" name="Connections" height={130} />
                        <div style={{ fontSize: 9, color: '#484f58', paddingLeft: 8 }}>
                          Active outbound TCP connections — solid is the bucket peak, dashed the bucket average.
                          {' '}Sustained growth with flat traffic is the SNAT / pooling signal the CPI watches for.
                        </div>
                      </td>
                    </tr>
                  )}
                </>
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
              const filteredTopDeps    = topDeps.filter(d => d.classification === depsFilter);
              const filteredFailedDeps = failedDeps.filter(d => d.classification === depsFilter);
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
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums" style={{ color: depP99 > 5000 ? '#f85149' : depP99 > 1000 ? '#d29922' : '#58a6ff' }}>
                      {depP99 > 0 ? fmtDuration(depP99) : '—'}
                    </td>
                    {/* failed (% of total) / timeout (% of total) / total — timeouts sit
                        in the middle because they are a subset of the failures, so the
                        row reads broadest to most-specific, then the denominator. */}
                    <td className="text-right tabular-nums" style={{ whiteSpace: 'nowrap' }}>
                      {depTotal > 0 ? (() => {
                        const depTO = (metrics.requestInsights?.dependencyTimeouts ?? []).reduce((s, d) => s + d.count, 0);
                        return insight.failedDependencies > 0 || depTO > 0
                          ? <span title={`${insight.failedDependencies.toLocaleString()} failed, of which ${depTO.toLocaleString()} timed out, out of ${depTotal.toLocaleString()} dependency calls — ${depFailRate.toFixed(2)}% failure rate.`}>
                              <span style={{ color: insight.failedDependencies > 0 ? DEP_FAILED_COLOR : '#484f58', fontSize: 10 }}>{insight.failedDependencies.toLocaleString()} ({fmtPct(insight.failedDependencies, depTotal)})</span>
                              <span style={{ color: '#484f58' }}> / </span>
                              <span style={{ color: depTO > 0 ? DEP_TIMEOUT_COLOR : '#484f58', fontSize: 10 }}>{depTO.toLocaleString()} ({fmtPct(depTO, depTotal)})</span>
                              <span style={{ color: '#484f58' }}> / </span>
                              <span style={{ color: DEP_TOTAL_COLOR }}>{depTotal.toLocaleString()}</span>
                            </span>
                          : <span style={{ color: '#3fb950' }}>{depTotal.toLocaleString()}</span>;
                      })() : '—'}
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
                              { key: 'topDeps',     label: 'Top',     color: '#58a6ff' },
                              { key: 'failedDeps',  label: 'Failed',  color: '#f85149' },
                              { key: 'timeoutDeps', label: 'Timeout', color: '#f97316' },
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
                          {depsTab !== 'timeoutDeps' && <DepsFilterPills value={depsFilter} onChange={setDepsFilter} />}
                        </td>
                      </tr>}
                      {detailsLoaded && depsTab === 'topDeps' && (
                        filteredTopDeps.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No {depsFilter === 'internal' ? 'internal' : 'third-party'} dependencies{(depsFilter === 'internal' ? topDeps.some(d => d.classification === 'thirdParty') : topDeps.some(d => d.classification === 'internal')) ? ` — try ${depsFilter === 'internal' ? 'Third-Party' : 'Internal'}` : ''}</td></tr>
                          : filteredTopDeps.map((d, i) => (
                            <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                              <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.type ? `[${d.type}] ` : ''}${d.name}${d.target ? ` → ${d.target}` : ''}`}>
                                {d.name || '—'}{d.target ? <span style={{ color: '#6e7681' }}> → {d.target}</span> : null}
                              </td>
                              <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                              <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{fmtDuration(d.p99)}</td>
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
                              <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.type ? `[${d.type}] ` : ''}${d.name}`}>{d.name}</td>
                              <td className="text-right tabular-nums" style={{ color: RESULT_CODE_COLOR(d.resultCode), fontSize: 10 }} title={RESULT_CODE_HELP[d.resultCode] ?? `resultCode ${d.resultCode}`}>{d.resultCode || '—'}</td>
                              <td className="text-right tabular-nums" style={{ color: '#58a6ff' }} title="p95 duration">{d.p95 > 0 ? fmtDuration(d.p95) : '—'}</td>
                              <td className="text-right tabular-nums" style={{ color: '#f97316' }}>{d.count.toLocaleString()}</td>
                            </tr>
                          ))}</>;
                      })()}
                      {detailsLoaded && depsTab === 'failedDeps' && (
                        filteredFailedDeps.length === 0
                          ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No failed {depsFilter === 'internal' ? 'internal' : 'third-party'} dependencies{(depsFilter === 'internal' ? failedDeps.some(d => d.classification === 'thirdParty') : failedDeps.some(d => d.classification === 'internal')) ? ` — try ${depsFilter === 'internal' ? 'Third-Party' : 'Internal'}` : ''}</td></tr>
                          : filteredFailedDeps.slice(0, 10).map((d, i) => (
                            <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                              <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.type ? `[${d.type}] ` : ''}${d.name}${d.target ? ` → ${d.target}` : ''}`}>
                                {d.name || '—'}{d.target ? <span style={{ color: '#6e7681' }}> → {d.target}</span> : null}
                              </td>
                              <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                              <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{fmtDuration(d.p99)}</td>
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
              return (
                <>
                  <tr
                    style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                    onClick={() => { if (hasDetail) { setErrorsExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setSelectedErrType(null); } }}
                    onMouseEnter={e => hasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td className="text-muted-foreground font-bold">
                      <span title="Exceptions: unhandled application exceptions captured by App Insights, grouped by type. Split into four mutually exclusive tabs: Socket (transport failed, no connection), Timeout (connected, caller gave up waiting), OOM (out of memory), Unclassified (everything else). Counts sum to this total.">Exceptions</span>
                      {hasDetail && (errorsExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      )}
                    </td>
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums text-muted-foreground">—</td>
                    <td className="text-right tabular-nums" style={{ color: errColor }} title={excCounts.breakdown}>{errorCount.toLocaleString()}</td>
                  </tr>
                  {errorsExpanded && hasDetail && detailsLoading && !detailsLoaded && (
                    <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Loading details…</td></tr>
                  )}
                  {errorsExpanded && hasDetail && (!detailsLoading || detailsLoaded) && (
                    <>
                      <ExcTabRow value={errTab} onChange={setErrTab} counts={excCounts} />
                      {errTab === 'generic'
                        ? renderErrTypes(genericTypes, genericDetails, selectedErrType, setSelectedErrType)
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
            {visibleBlocks.snatRisk && metrics.type !== 'containerapp' && metrics.appInsightsConfigured && metrics.requestInsights && !metrics.requestInsights.error && (() => {
              const snatDetails  = metrics.requestInsights.snatDetails ?? [];
              const count        = snatDetails.length;
              const feInsight    = metrics.requestInsights.insight;
              // Socket-layer only — application timeouts are scored by depTimeouts.
              const socketExc    = feInsight?.socketLayerExceptions ?? 0;
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
                { key: 'socket'  as const, label: 'Socket Exceptions',     raw: `${socketExc}`,                    norm: risk.socketScore,     wt: 20, pts: 20 * risk.socketScore,     normFormulaRaw: `${socketExc}`,                    normFormulaThreshold: '50 exceptions' },
                { key: 'depFail' as const, label: 'Dependencies Failure',  raw: `${depFailRate.toFixed(1)}%`,      norm: risk.depFailScore,    wt: 25, pts: 25 * risk.depFailScore,    normFormulaRaw: `${depFailRate.toFixed(1)}%`,       normFormulaThreshold: '20% fail rate' },
                { key: 'depTO'   as const, label: 'Dependencies Timeouts', raw: `${depTimeouts}`,                  norm: risk.depTimeoutScore, wt: 30, pts: 30 * risk.depTimeoutScore, normFormulaRaw: `${depTimeouts}`,                   normFormulaThreshold: '400 timeouts' },
                { key: 'depP99'  as const, label: 'Dependencies P99',      raw: fmtDuration(depP99Ms),       norm: risk.depP99Score,     wt: 15, pts: 15 * risk.depP99Score,     normFormulaRaw: `${Math.round(depP99Ms)}ms`,        normFormulaThreshold: '5000ms P99' },
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
                      <span title="Connection Pressure Index (CPI): measures the probability that SNAT port exhaustion or dependency connection pressure is contributing to failures. Combines socket-layer exceptions (0.20), dependency failure rate (0.25), dependency timeouts (0.30), P99 latency (0.15), connection growth (0.05), and HTTP 5xx rate (0.05) into a normalized 0–100 confidence score.">Connection Pressure Index</span>
                      {snatExpanded
                        ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                      }
                    </td>
                    {/* The two spare cells merge into one and carry the verdict that
                        used to sit inside the expanded panel. */}
                    {(() => {
                      const v = snatVerdict(risk.score, socketExc);
                      return (
                        <td
                          colSpan={2}
                          className={v ? '' : 'text-right tabular-nums text-muted-foreground'}
                          style={v ? { color: v.color, fontWeight: v.bold ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : undefined}
                          title={v?.text}
                        >{v ? v.text : '—'}</td>
                      );
                    })()}
                    {/* Score and band read as one value, in the same cell every other
                        row puts its headline figure. */}
                    <td className="text-right tabular-nums" style={{ color: risk.color }}>{risk.score.toFixed(1)} - {risk.label}</td>
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
                      return (
                        <>
                          <td className="text-right tabular-nums text-muted-foreground">—</td>
                          <td className="text-right" style={{ color: '#58a6ff' }}>
                            {fmtDuration(ai?.insight?.requestP99)}
                          </td>
                          {/* 5xx (% of total) / 4xx (% of total) / total */}
                          <td
                            className="text-right"
                            style={{ whiteSpace: 'nowrap' }}
                            title={`${total5xx.toLocaleString()} server errors (5xx) and ${total4xx.toLocaleString()} client errors (4xx) out of ${reqTotal.toLocaleString()} requests — ${pct.toFixed(2)}% failed overall.`}
                          >
                            {errTotal > 0
                              ? <>
                                  <span style={{ color: total5xx > 0 ? HTTP_5XX_COLOR : '#484f58', fontSize: 10 }}>{total5xx.toLocaleString()} ({fmtPct(total5xx, reqTotal)})</span>
                                  <span style={{ color: '#484f58' }}> / </span>
                                  <span style={{ color: total4xx > 0 ? HTTP_4XX_COLOR : '#484f58', fontSize: 10 }}>{total4xx.toLocaleString()} ({fmtPct(total4xx, reqTotal)})</span>
                                  <span style={{ color: '#484f58' }}> / </span>
                                  <span style={{ color: '#58a6ff' }}>{reqTotal.toLocaleString()}</span>
                                </>
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
                                      {(['requests', 'highfreq', 'http4xx', 'http5xx', 'bots'] as const).map(t => {
                                        const labels: Record<string, string> = { highfreq: 'High Freq', http4xx: 'HTTP 4xx', http5xx: 'HTTP 5xx', requests: 'Top', bots: 'User Agents' };
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
                                            const rep = ipReputations[u.ip];
                                            return (
                                              <div key={i} className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0">
                                                <div className="flex flex-col min-w-0 flex-1">
                                                  <span className="truncate" style={{ color: textColor ?? 'var(--muted-foreground)' }}>
                                                    {u.ip || '(unknown)'}{u.country ? ` - ${u.country}` : ''} · {fmtSgt(start)} → {fmtSgt(end)} SGT
                                                    <IpRepBadges rep={rep} />
                                                  </span>
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
                const hasSeries = apiConPts.length > 1;
                return (
                  <>
                    <tr
                      style={{ cursor: hasSeries ? 'pointer' : 'default' }}
                      onClick={() => hasSeries && setConnAPIExpanded(v => !v)}
                      onMouseEnter={e => hasSeries && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="text-muted-foreground font-bold" title="Connections: active outbound TCP connections from the App Service instance(s), sourced from Azure Monitor AppConnections metric. Growing connection counts can indicate SNAT port accumulation or connection pool leaks.">
                        Connections
                        {hasSeries && (connAPIExpanded
                          ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                          : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        )}
                      </td>
                      <td className="text-right" style={{ whiteSpace: 'nowrap' }}>
                        {trend
                          ? <span style={{ fontSize: 10, color: trendColor }}>Trend - {Math.round(a1)} {trend} {Math.round(a2)}</span>
                          : <span className="text-muted-foreground">—</span>}
                      </td>
                      <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.apiConnections.p99)}</td>
                      <td className="text-right" style={{ color: '#22d3ee' }}>{Math.round(+metrics.apiConnections.max)}</td>
                    </tr>
                    {connAPIExpanded && hasSeries && (
                      <tr>
                        <td colSpan={4} style={{ paddingTop: 4, paddingBottom: 6 }}>
                          <SeriesChart series={apiConPts} color="#22d3ee" name="Connections" height={130} />
                          <div style={{ fontSize: 9, color: '#484f58', paddingLeft: 8 }}>
                            Active outbound TCP connections — solid is the bucket peak, dashed the bucket average.
                            {' '}Sustained growth with flat traffic is the SNAT / pooling signal the CPI watches for.
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
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
                const filteredTopDeps    = topDeps.filter(d => d.classification === depsAPIFilter);
                const filteredFailedDeps = failedDeps.filter(d => d.classification === depsAPIFilter);
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
                      <td className="text-right tabular-nums text-muted-foreground">—</td>
                      <td className="text-right tabular-nums" style={{ color: depP99 > 5000 ? '#f85149' : depP99 > 1000 ? '#d29922' : '#58a6ff' }}>
                        {depP99 > 0 ? fmtDuration(depP99) : '—'}
                      </td>
                      {/* failed (% of total) / timeout (% of total) / total */}
                      <td className="text-right tabular-nums" style={{ whiteSpace: 'nowrap' }}>
                        {depTotal > 0 ? (() => {
                          const depTO = (metrics.apiRequestInsights?.dependencyTimeouts ?? []).reduce((s, d) => s + d.count, 0);
                          return apiInsight.failedDependencies > 0 || depTO > 0
                            ? <span title={`${apiInsight.failedDependencies.toLocaleString()} failed, of which ${depTO.toLocaleString()} timed out, out of ${depTotal.toLocaleString()} dependency calls — ${depFailRate.toFixed(2)}% failure rate.`}>
                                <span style={{ color: apiInsight.failedDependencies > 0 ? DEP_FAILED_COLOR : '#484f58', fontSize: 10 }}>{apiInsight.failedDependencies.toLocaleString()} ({fmtPct(apiInsight.failedDependencies, depTotal)})</span>
                                <span style={{ color: '#484f58' }}> / </span>
                                <span style={{ color: depTO > 0 ? DEP_TIMEOUT_COLOR : '#484f58', fontSize: 10 }}>{depTO.toLocaleString()} ({fmtPct(depTO, depTotal)})</span>
                                <span style={{ color: '#484f58' }}> / </span>
                                <span style={{ color: DEP_TOTAL_COLOR }}>{depTotal.toLocaleString()}</span>
                              </span>
                            : <span style={{ color: '#3fb950' }}>{depTotal.toLocaleString()}</span>;
                        })() : '—'}
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
                                { key: 'topDeps',     label: 'Top',     color: '#58a6ff' },
                                { key: 'failedDeps',  label: 'Failed',  color: '#f85149' },
                                { key: 'timeoutDeps', label: 'Timeout', color: '#f97316' },
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
                            {depsAPITab !== 'timeoutDeps' && <DepsFilterPills value={depsAPIFilter} onChange={setDepsAPIFilter} />}
                          </td>
                        </tr>}
                        {detailsLoaded && depsAPITab === 'topDeps' && (
                          filteredTopDeps.length === 0
                            ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No {depsAPIFilter === 'internal' ? 'internal' : 'third-party'} dependencies{(depsAPIFilter === 'internal' ? topDeps.some(d => d.classification === 'thirdParty') : topDeps.some(d => d.classification === 'internal')) ? ` — try ${depsAPIFilter === 'internal' ? 'Third-Party' : 'Internal'}` : ''}</td></tr>
                            : filteredTopDeps.map((d, i) => (
                              <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                                <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.type ? `[${d.type}] ` : ''}${d.name}${d.target ? ` → ${d.target}` : ''}`}>
                                  {d.name || '—'}{d.target ? <span style={{ color: '#6e7681' }}> → {d.target}</span> : null}
                                </td>
                                <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                                <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{fmtDuration(d.p99)}</td>
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
                          filteredFailedDeps.length === 0
                            ? <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>No failed {depsAPIFilter === 'internal' ? 'internal' : 'third-party'} dependencies{(depsAPIFilter === 'internal' ? failedDeps.some(d => d.classification === 'thirdParty') : failedDeps.some(d => d.classification === 'internal')) ? ` — try ${depsAPIFilter === 'internal' ? 'Third-Party' : 'Internal'}` : ''}</td></tr>
                            : filteredFailedDeps.slice(0, 10).map((d, i) => (
                              <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 10 }}>
                                <td className="truncate" style={{ color: 'var(--muted-foreground)', paddingLeft: 20, maxWidth: 0 }} title={`${d.type ? `[${d.type}] ` : ''}${d.name}${d.target ? ` → ${d.target}` : ''}`}>
                                  {d.name || '—'}{d.target ? <span style={{ color: '#6e7681' }}> → {d.target}</span> : null}
                                </td>
                                <td className="text-right tabular-nums text-muted-foreground">{spanMinutes > 0 ? (d.totalCount / spanMinutes).toFixed(1) + ' rpm' : '—'}</td>
                                <td className="text-right tabular-nums" style={{ color: d.p99 >= 5000 ? '#f85149' : d.p99 > 1000 ? '#d29922' : '#58a6ff' }}>{fmtDuration(d.p99)}</td>
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
                return (
                  <>
                    <tr
                      style={{ cursor: apiHasDetail ? 'pointer' : 'default' }}
                      onClick={() => { if (apiHasDetail) { setErrAPIExpanded(v => { if (!v && !detailsLoaded && !detailsLoading) onRequestDetails?.(); return !v; }); setSelectedErrAPIType(null); } }}
                      onMouseEnter={e => apiHasDetail && (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td className="text-muted-foreground font-bold">
                        <span title="Exceptions: unhandled application exceptions captured by App Insights, grouped by type. Split into four mutually exclusive tabs: Socket (transport failed, no connection), Timeout (connected, caller gave up waiting), OOM (out of memory), Unclassified (everything else). Counts sum to this total.">Exceptions</span>
                        {apiHasDetail && (errAPIExpanded
                          ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                          : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        )}
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">—</td>
                      <td className="text-right tabular-nums text-muted-foreground">—</td>
                      <td className="text-right tabular-nums" style={{ color: apiErrColor }} title={apiExcCounts.breakdown}>{apiErrorCount.toLocaleString()}</td>
                    </tr>
                    {errAPIExpanded && apiHasDetail && detailsLoading && !detailsLoaded && (
                      <tr><td colSpan={4} style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--muted-foreground)', paddingBottom: 4 }}>Loading details…</td></tr>
                    )}
                    {errAPIExpanded && apiHasDetail && (!detailsLoading || detailsLoaded) && (
                      <>
                        <ExcTabRow value={errAPITab} onChange={setErrAPITab} counts={apiExcCounts} />
                        {errAPITab === 'generic'
                          ? renderErrTypes(apiGenericTypes, apiGenericDetails, selectedErrAPIType, setSelectedErrAPIType)
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
              {visibleBlocks.snatRisk && metrics.type !== 'containerapp' && apiHasInsights && metrics.apiRequestInsights && !metrics.apiRequestInsights.error && (() => {
                const snatDetails     = metrics.apiRequestInsights.snatDetails ?? [];
                const count           = snatDetails.length;
                const apiInsight      = metrics.apiRequestInsights.insight;
                // Socket-layer only — application timeouts are scored by depTimeouts.
                const apiSocketExc    = apiInsight?.socketLayerExceptions ?? 0;
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
                  { key: 'socket'  as const, label: 'Socket Exceptions',     raw: `${apiSocketExc}`,                 norm: risk.socketScore,     wt: 20, pts: 20 * risk.socketScore,     normFormulaRaw: `${apiSocketExc}`,                 normFormulaThreshold: '50 exceptions' },
                  { key: 'depFail' as const, label: 'Dependencies Failure',  raw: `${apiDepFailRate.toFixed(1)}%`,   norm: risk.depFailScore,    wt: 25, pts: 25 * risk.depFailScore,    normFormulaRaw: `${apiDepFailRate.toFixed(1)}%`,    normFormulaThreshold: '20% fail rate' },
                  { key: 'depTO'   as const, label: 'Dependencies Timeouts', raw: `${apiDepTimeouts}`,               norm: risk.depTimeoutScore, wt: 30, pts: 30 * risk.depTimeoutScore, normFormulaRaw: `${apiDepTimeouts}`,                normFormulaThreshold: '400 timeouts' },
                  { key: 'depP99'  as const, label: 'Dependencies P99',      raw: fmtDuration(apiDepP99Ms),    norm: risk.depP99Score,     wt: 15, pts: 15 * risk.depP99Score,     normFormulaRaw: `${Math.round(apiDepP99Ms)}ms`,     normFormulaThreshold: '5000ms P99' },
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
                        <span title="Connection Pressure Index (CPI): measures the probability that SNAT port exhaustion or dependency connection pressure is contributing to failures. Combines socket-layer exceptions (0.20), dependency failure rate (0.25), dependency timeouts (0.30), P99 latency (0.15), connection growth (0.05), and HTTP 5xx rate (0.05) into a normalized 0–100 confidence score.">Connection Pressure Index</span>
                        {snatAPIExpanded
                          ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                          : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
                        }
                      </td>
                      {(() => {
                        const v = snatVerdict(risk.score, apiSocketExc);
                        return (
                          <td
                            colSpan={2}
                            className={v ? '' : 'text-right tabular-nums text-muted-foreground'}
                            style={v ? { color: v.color, fontWeight: v.bold ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : undefined}
                            title={v?.text}
                          >{v ? v.text : '—'}</td>
                        );
                      })()}
                      <td className="text-right tabular-nums" style={{ color: risk.color }}>{risk.score.toFixed(1)} - {risk.label}</td>
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
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              {aiRemark ? (
                <div className="text-xs">
                  <span className="text-muted-foreground font-bold">Remarks (AI): </span>
                  <span style={{ color: AI_STATUS_COLORS[aiRemark.status], fontWeight: 600 }}>{aiRemark.remarks}</span>
                </div>
              ) : (
                <AppRemarks metrics={metrics} rangeStart={rangeStart} rangeEnd={rangeEnd} visibleBlocks={visibleBlocks} urMonitors={urMonitors} />
              )}
            </div>
            <button
              onClick={generateAiRemarks}
              disabled={aiRemarkLoading}
              className="p-1 rounded hover:bg-muted flex-shrink-0 disabled:opacity-50"
              title={aiRemarkLoading ? 'Generating AI remarks…' : 'Generate AI remarks (Claude health verdict)'}
              data-html2canvas-ignore="true"
            >
              <Sparkles className={`w-3.5 h-3.5 ${aiRemarkLoading ? 'animate-pulse text-blue-400' : 'text-muted-foreground'}`} />
            </button>
          </div>
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
      onExportPdf={exportRcaPdf}
      onCopyTeams={copyRcaForTeams}
      onCopySummary={copySummaryForTeams}
      onRetry={handleRunRca}
    />

    </>
  );
}
