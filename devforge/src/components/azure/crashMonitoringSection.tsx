import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { CrashEvent, CrashResult } from '@shared/types/azureMetrics.types';
import { EventBarChart } from './azureMetricChart';
import { CellSkeleton, PanelSkeleton } from './loadingSkeleton';

/**
 * Proactive crash-monitoring, from the portal's Application Crashes detector.
 *
 * Restarts already counts "App Crash" as a cause, but only as a count and a
 * timestamp — it does not say which exception faulted the process. This
 * section is the answer: the crash-count timeline (always present) plus,
 * once Azure has actually captured one (it triggers only after a site has
 * crashed more than 3 times in 24h), the exception and stack trace off each
 * crash — the same trace App Service emails out when it happens.
 *
 * Per site, so the frontend and the API each get their own row.
 */

const CRASH_COLOR = '#f85149';

/** Total crashes in the window, from the timeline. Pure.
 *
 * The timeline counts every crash; the event list below only covers the ones
 * Azure captured a stack trace for, so the two counts can legitimately differ —
 * a handful of crashes with detail, alongside a larger true total. */
export function crashTotals(crashes: CrashResult | null | undefined): { total: number } {
  const chart = crashes?.charts?.find(c => /crash/i.test(c.title)) ?? crashes?.charts?.[0];
  const total = (chart?.series ?? []).reduce((sum, s) => sum + s.series.reduce((a, p) => a + (p.count ?? 0), 0), 0);
  return { total };
}

/** Captured crash events, from the detector's per-event dropdown. Already
 *  newest-first. */
export function crashEvents(crashes: CrashResult | null | undefined): CrashEvent[] {
  return crashes?.events ?? [];
}

/** Captured events grouped by exception type. Pure. */
export function eventsByExceptionType(events: CrashEvent[]): Array<{ cause: string; count: number }> {
  const byType = new Map<string, number>();
  for (const e of events) {
    const type = e.exceptionType || e.category || 'Unknown exception';
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  return [...byType.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count);
}

/** One or more captured crashes that are the same fault — same exception type
 *  and the same stack trace — collapsed onto one row with every occurrence's
 *  time joined together. */
export interface CrashEventGroup {
  exceptionType: string | null;
  category: string;
  exitCode: string;
  stackTrace: string;
  /** ISO timestamps, newest first. */
  times: string[];
}

/** Captured events collapsed onto one row per distinct exception + stack trace.
 * Pure, newest-group-first.
 *
 * Proactive Crash Monitoring often captures the same fault repeatedly in one
 * window — five rows all naming the same exception at the same call site read
 * as one fact repeated, not five separate ones worth scanning individually.
 */
export function groupCrashEvents(events: CrashEvent[]): CrashEventGroup[] {
  const groups = new Map<string, CrashEventGroup>();
  for (const e of events) {
    const key = `${e.exceptionType ?? e.category}::${e.stackTrace}`;
    const existing = groups.get(key);
    if (existing) existing.times.push(e.t);
    else groups.set(key, { exceptionType: e.exceptionType, category: e.category, exitCode: e.exitCode, stackTrace: e.stackTrace, times: [e.t] });
  }
  return [...groups.values()]
    .map(g => ({ ...g, times: [...g.times].sort((a, b) => (a < b ? 1 : -1)) }))
    .sort((a, b) => ((a.times[0] ?? '') < (b.times[0] ?? '') ? 1 : -1));
}

const SGT = { timeZone: 'Asia/Singapore' } as const;
const fmtEventTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function CrashEventGroupRow({ group }: { group: CrashEventGroup }) {
  const [showStack, setShowStack] = useState(false);

  return (
    <div style={{ marginBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.04)', paddingBottom: 4 }}>
      <div
        style={{ display: 'flex', justifyContent: 'space-between', gap: 8, cursor: group.stackTrace ? 'pointer' : 'default' }}
        onClick={() => group.stackTrace && setShowStack(v => !v)}
      >
        <span style={{ color: CRASH_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {group.exceptionType || group.category || 'Unknown exception'}
          {group.times.length > 1 ? <span style={{ color: '#484f58' }}> ×{group.times.length}</span> : null}
        </span>
        <span style={{ color: '#6e7681', whiteSpace: 'nowrap' }}>
          {group.stackTrace && (showStack ? <ChevronDown size={11} style={{ display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={11} style={{ display: 'inline', verticalAlign: 'middle' }} />)}
          {' '}{group.exitCode || '—'}
        </span>
      </div>
      <div className="tabular-nums" style={{ color: '#6e7681', marginTop: 2 }}>
        {group.times.map(t => fmtEventTime(t)).join(', ')}
      </div>
      {showStack && group.stackTrace && (
        <pre style={{ margin: '3px 0 0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#8b949e', fontFamily: 'inherit' }}>{group.stackTrace}</pre>
      )}
    </div>
  );
}

export function CrashPanel({
  crashes, loading, syncId,
}: {
  crashes: CrashResult | null | undefined;
  loading: boolean;
  syncId?: string | undefined;
}) {
  if (loading && !crashes) {
    return <PanelSkeleton rows={4} chartHeight={90} />;
  }
  if (!crashes) {
    return <div style={{ fontSize: 10, color: 'var(--muted-foreground)', fontStyle: 'italic', padding: '6px 8px' }}>Crash monitoring unavailable for this site.</div>;
  }

  const { total } = crashTotals(crashes);
  const events = crashEvents(crashes);
  const byType = eventsByExceptionType(events);
  const groups = groupCrashEvents(events);
  const chart = crashes.charts?.find(c => /crash/i.test(c.title)) ?? crashes.charts?.[0];
  const plotted = (chart?.series ?? []).filter(s => s.series.some(p => p.count > 0));

  return (
    <div style={{ fontSize: 10, padding: '2px 8px 4px' }}>
      {total === 0 && (
        <div style={{ color: '#3fb950', padding: '4px 0' }}>No crashes in this window.</div>
      )}

      {plotted.length > 0 && (
        <EventBarChart
          series={plotted.map(s => ({ name: s.name, series: s.series }))}
          colors={plotted.map(() => CRASH_COLOR)}
          height={90}
          syncId={syncId}
          valueLabel="crashes"
        />
      )}

      {/* The timeline counts every crash; the list below only covers the ones Azure
          actually captured a stack trace for. The two numbers are both real and can
          legitimately differ — this line is here so that gap doesn't read as a bug. */}
      {total > 0 && (
        <div style={{ color: '#6e7681', margin: '4px 0 2px' }}>
          {total.toLocaleString()} crash{total === 1 ? '' : 'es'} total this window
          {events.length > 0
            ? <> — {events.length} with a captured stack trace below. Proactive Crash Monitoring only records a trace once a site has crashed more than 3 times in 24h, and only keeps the most recent handful.</>
            : null}
        </div>
      )}

      {/* From the captured events, not the timeline: the timeline has no
          per-exception breakdown, only a total count per bucket. */}
      {byType.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, paddingLeft: 8, marginTop: 4 }}>
          {byType.map(c => (
            <span key={c.cause} style={{ whiteSpace: 'nowrap' }}>
              <span style={{ color: CRASH_COLOR, fontWeight: 600 }}>{c.count.toLocaleString()}</span>
              <span style={{ color: '#6e7681' }}> {c.cause}</span>
            </span>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', color: '#6e7681', marginBottom: 2 }}>
            <span>Exception (times in SGT)</span><span>Exit code</span>
          </div>
          {groups.map((g, i) => (
            <CrashEventGroupRow key={`${g.exceptionType}-${g.stackTrace}-${i}`} group={g} />
          ))}
        </div>
      )}

      {total > 0 && events.length === 0 && (
        <div style={{ color: '#6e7681', marginTop: 6 }}>
          No stack traces captured yet — Proactive Crash Monitoring only records them once a site has crashed more than 3 times in 24h.
        </div>
      )}

      {crashes.detector && (
        <div style={{ color: '#484f58', marginTop: 6, paddingLeft: 8 }}>detector: {crashes.detector}</div>
      )}
    </div>
  );
}

/**
 * The Crash Monitoring row as it sits inside a FE / API section table.
 *
 * Sits below Restarts: a crash here is often the same event Restarts just
 * counted as "App Crash" — this is where a reader goes to read what actually
 * faulted, not just that something did.
 */
export function CrashMonitoringRows({
  crashes, loading, expanded, onToggle, syncId,
}: {
  crashes: CrashResult | null | undefined;
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
  syncId?: string | undefined;
}) {
  const { total } = crashTotals(crashes);

  return (
    <>
      <tr
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td className="text-muted-foreground font-bold" title="The Application Crashes detector: a crash-count timeline plus, once captured, the exception and stack trace off each crash. A restart's 'App Crash' cause is often the same event.">
          Crash Monitoring
          {expanded
            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
        </td>
        <td className="text-right tabular-nums" colSpan={2} style={{ whiteSpace: 'nowrap', color: '#8b9ab3', overflow: 'hidden', textOverflow: 'ellipsis' }} />
        <td className="text-right tabular-nums" style={{ whiteSpace: 'nowrap', color: total === 0 ? '#3fb950' : 'hsl(var(--destructive))' }}>
          {loading && !crashes ? <CellSkeleton w={58} /> : crashes ? `${total.toLocaleString()} crash${total === 1 ? '' : 'es'}` : '—'}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
            <CrashPanel crashes={crashes} loading={loading} syncId={syncId} />
          </td>
        </tr>
      )}
    </>
  );
}
