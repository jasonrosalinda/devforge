import { ChevronDown, ChevronRight } from 'lucide-react';
import type { PageViewInsights } from '@shared/types/azureMetrics.types';
import { SeriesChart } from './azureMetricChart';
import { CellSkeleton, PanelSkeleton } from './loadingSkeleton';
import { UI, PERF_COLORS } from '@/lib/chart-colors';

/** Page-load thresholds, in line with common RUM guidance: under 2 s good, over 4 s poor. */
export const PAGE_LOAD_GOOD_MS = 2000;
export const PAGE_LOAD_POOR_MS = 4000;

export const loadColor = (ms: number | null | undefined) =>
  ms == null ? UI.textMuted : ms < PAGE_LOAD_GOOD_MS ? UI.success : ms < PAGE_LOAD_POOR_MS ? UI.warning : UI.error;

/** 850 ms / 1.83 s / 12.4 s. */
export function fmtLoad(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/** Axis ticks: 0 / 500ms / 2.5s / 20s — short enough to fit the axis. */
export function fmtLoadAxis(ms: number): string {
  if (ms === 0) return '0';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

const LINE_COLOR = PERF_COLORS.line;

const TIMING_PARTS = [
  { key: 'networkMs',    label: 'Network',   color: '#58a6ff', hint: 'DNS, connect and redirects' },
  { key: 'sendMs',       label: 'Server',    color: '#d29922', hint: 'Request sent until the first byte came back — time spent on the server' },
  { key: 'receiveMs',    label: 'Download',  color: '#a371f7', hint: 'Receiving the response' },
  { key: 'processingMs', label: 'Browser',   color: '#3fb950', hint: 'Parsing, scripts and rendering in the browser after the response arrived' },
] as const;

function hasError(p: PageViewInsights | { error: string } | null | undefined): p is { error: string } {
  return !!p && 'error' in p && typeof p.error === 'string';
}

/** Where the load time goes: one stacked bar, so the dominant slice is obvious. */
function TimingBreakdown({ timings }: { timings: NonNullable<PageViewInsights['timings']> }) {
  const parts = TIMING_PARTS.map(p => ({ ...p, ms: timings[p.key] ?? 0 }));
  const sum = parts.reduce((s, p) => s + p.ms, 0);
  if (sum <= 0) return null;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ color: UI.textDim, marginBottom: 3 }}>
        Where the time goes (average of {timings.samples.toLocaleString()} browser timings)
      </div>
      <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'hsl(var(--muted))' }} role="img"
        aria-label={parts.map(p => `${p.label} ${fmtLoad(p.ms)}`).join(', ')}>
        {parts.map(p => p.ms > 0 && (
          <div key={p.key} title={`${p.label}: ${fmtLoad(p.ms)} — ${p.hint}`} style={{ width: `${(p.ms / sum) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 14px', marginTop: 4 }}>
        {parts.map(p => (
          <span key={p.key} title={p.hint} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} />
            <span style={{ color: UI.textMuted }}>{p.label}</span>
            <span className="tabular-nums">{fmtLoad(p.ms)}</span>
            <span className="tabular-nums" style={{ color: UI.textDim }}>({Math.round((p.ms / sum) * 100)}%)</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function PageLoadPanel({ pv, syncId }: { pv: PageViewInsights; syncId?: string | undefined }) {
  const series = pv.series
    .filter(p => p.avgMs != null)
    .map(p => ({ t: p.t, v: p.avgMs!, m: p.p95Ms ?? p.avgMs! }));

  return (
    <div style={{ fontSize: 10, padding: '2px 8px 4px' }}>
      {series.length > 1 && (
        <>
          <SeriesChart
            series={series}
            color={LINE_COLOR}
            name="Page load"
            height={130}
            syncId={syncId}
            valueFormatter={fmtLoad}
            axisFormatter={fmtLoadAxis}
            yAxisWidth={44}
            lineLabels={{ v: 'Average', m: 'P95' }}
          />
          <div style={{ color: UI.textDim, paddingLeft: 8, marginBottom: 6 }}>
            Page load time per {pv.bin} — dashed is the average, solid is the P95 (the slowest 1 in 20 loads).
            Measured in the browser from navigation start to the load event, so it includes network and rendering, not just the server.
          </div>
        </>
      )}

      {pv.timings && <TimingBreakdown timings={pv.timings} />}

      {pv.pages.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="flex justify-between" style={{ color: UI.textDim }}>
            <span>Busiest operations</span>
            <span>views · avg · p95</span>
          </div>
          {pv.pages.map(p => (
            <div key={p.name} className="flex items-center justify-between gap-2 border-b border-border/30 pb-0.5 last:border-0" title={p.name}>
              <span className="truncate min-w-0 flex-1" style={{ color: 'var(--muted-foreground)' }}>{p.name}</span>
              <span className="tabular-nums flex-shrink-0">
                <span style={{ color: UI.textMuted }}>{p.views.toLocaleString()}</span>
                <span style={{ color: UI.textDim }}> · </span>
                <span style={{ color: loadColor(p.avgMs) }}>{fmtLoad(p.avgMs)}</span>
                <span style={{ color: UI.textDim }}> · </span>
                <span style={{ color: loadColor(p.p95Ms) }}>{fmtLoad(p.p95Ms)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Page Load row for the card's summary table: browser page-load time from the frontend's
 * App Insights `pageViews`. Arrives with the lazy details fetch, like Users.
 */
export function PageLoadRows({
  pageViews, expanded, onToggle, syncId, loading = false, unavailableMessage,
}: {
  pageViews: PageViewInsights | { error: string } | null | undefined;
  expanded: boolean;
  onToggle: () => void;
  syncId?: string | undefined;
  loading?: boolean;
  unavailableMessage?: string | undefined;
}) {
  const error = hasError(pageViews) ? pageViews.error : null;
  const pv = pageViews && !hasError(pageViews) ? pageViews : null;
  const has = !!pv && pv.views > 0;

  const cell = (label: string, value: React.ReactNode, color: string | undefined, title: string | undefined, skeletonW: number) => (
    <td className="text-right tabular-nums" title={title}>
      {has
        ? <><span style={{ color: UI.textDim }}>{label} - </span><span style={{ color }}>{value}</span></>
        : loading ? <CellSkeleton w={skeletonW} /> : '—'}
    </td>
  );

  return (
    <>
      <tr
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td
          className="text-muted-foreground font-bold"
          title="Page Load: how long pages took to load in users' browsers, from App Insights page views (the JavaScript SDK). Expand for the timeline, where the time goes, and the busiest operations."
        >
          Page Load
          {expanded
            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
        </td>
        {cell('Avg', fmtLoad(pv?.avgMs), loadColor(pv?.avgMs), `Average page load. Under ${fmtLoad(PAGE_LOAD_GOOD_MS)} is good, over ${fmtLoad(PAGE_LOAD_POOR_MS)} is poor.`, 44)}
        {cell('P95', fmtLoad(pv?.p95Ms), loadColor(pv?.p95Ms), `95% of page loads were faster than this${pv?.maxMs != null ? `; the slowest took ${fmtLoad(pv.maxMs)}` : ''}.`, 44)}
        {cell('Views', pv?.views.toLocaleString(), 'hsl(var(--foreground))', 'Page views in this window (sampling undone via itemCount)', 40)}
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
            {loading && !pageViews
              ? <PanelSkeleton rows={4} chartHeight={130} />
              : error
                ? <span className="text-[10px] text-destructive">{error}</span>
                : unavailableMessage
                  ? <span className="text-[10px] text-muted-foreground italic">{unavailableMessage}</span>
                  : has && pv
                    ? <PageLoadPanel pv={pv} syncId={syncId} />
                    : <span className="text-[10px] text-muted-foreground italic">
                        No page views in this window. Page load time needs the App Insights JavaScript SDK on the site's pages.
                      </span>
            }
          </td>
        </tr>
      )}
    </>
  );
}
