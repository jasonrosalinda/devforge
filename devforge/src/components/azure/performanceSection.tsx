import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { EndpointPerformance } from '@shared/types/azureMetrics.types';
import { EndpointPerfChart } from './azureMetricChart';
import { CellSkeleton, PanelSkeleton, SkeletonBlock } from './loadingSkeleton';
import type { EndpointDepsState } from '@/hooks/useAzureMetrics';
import {
  perfChartRows, perfTotals, hasPerfData, msColor, depTotals, depChartRows, depKey, chartTotals,
  PERF_OK_COLOR, PERF_4XX_COLOR, PERF_5XX_COLOR, PERF_LINE_COLOR,
} from './performance';

/** Row layout, shared by the header and the endpoint rows so the columns line up. */
const GRID = '1fr 58px 58px 46px 46px 58px 58px';
/**
 * Endpoint rows rendered before the "show more" cut.
 *
 * The merged set runs to 60+ during a wide outage, and every row is a 7-cell grid with a
 * tooltip. The rows past the cap are the quiet ones — the list is ordered failures-first —
 * so hiding them costs nothing to read and keeps the expanded panel cheap.
 */
const ROW_CAP = 20;

/** The dependency block's own layout — call and target both need room to be readable. */
const DEP_GRID = '1fr 150px 52px 48px 52px 52px 56px';

/**
 * The Performance section's body: one endpoint charted, every endpoint listed.
 *
 * The list doubles as the chart's selector rather than sitting beside a dropdown —
 * the row already carries the figures you would pick on, so the thing you read and
 * the thing you click are the same thing.
 */
export function PerformancePanel({
  perf, fmtMs, syncId, deps, onRequestDeps, captureTag,
}: {
  perf: EndpointPerformance;
  fmtMs: (ms: number | null) => string;
  /** Card-wide hover group, so the crosshair tracks the CPU/memory chart. */
  syncId?: string | undefined;
  /** The charted endpoint's downstream calls, fetched on selection by the card. */
  deps?: EndpointDepsState | undefined;
  onRequestDeps?: ((endpoint: string) => void) | undefined;
  /** Tags the chart + legend below (not the endpoint table) with [data-teams-perf-chart]
   *  so copyForTeams can screenshot it on its own, only when this panel is actually
   *  expanded and on screen. */
  captureTag?: string | undefined;
}) {
  const { endpoints } = perf;
  /**
   * The charted endpoint, or null for the set-wide total.
   *
   * Null is the default rather than the busiest endpoint: opening on one arbitrary row
   * answers a question nobody asked yet, and the figures printed on the collapsed row are
   * the set's totals — so the chart under them should be the same traffic. Picking a row
   * drills in; picking it again comes back out.
   */
  const [selected, setSelected] = useState<string | null>(null);

  // Reset when the fetch returns a different endpoint set — otherwise a URL held over
  // from the previous time range stays selected while having no row to deselect it from.
  const signature = endpoints.map(e => e.url).join('|');
  const lastSignature = useRef(signature);
  if (lastSignature.current !== signature) {
    lastSignature.current = signature;
    setSelected(null);
  }

  // Ask for the charted endpoint's calls — on first render for the default selection, and
  // again whenever the selection moves. The hook de-duplicates, so a re-select of an
  // endpoint already answered costs nothing.
  useEffect(() => {
    if (selected) onRequestDeps?.(selected);
  }, [selected, onRequestDeps]);

  const selectedDeps = deps?.deps ?? [];
  const dt = depTotals(selectedDeps);

  /** The one downstream call charted, or null. Cleared whenever the endpoint changes — a
   *  call held over from the previous endpoint has no row left to deselect it from. */
  const [selectedDep, setSelectedDep] = useState<string | null>(null);
  const lastEndpoint = useRef(selected);
  if (lastEndpoint.current !== selected) {
    lastEndpoint.current = selected;
    setSelectedDep(null);
  }
  const chartedDep = selectedDeps.find(d => depKey(d) === selectedDep);
  const depRows = depChartRows(chartedDep?.series);

  const [showAllRows, setShowAllRows] = useState(false);
  const visibleEndpoints = showAllRows ? endpoints : endpoints.slice(0, ROW_CAP);
  const hiddenRows = endpoints.length - visibleEndpoints.length;

  // With no row selected the chart draws the whole set, which ships with the details
  // payload — so the default view is on screen immediately and costs no round trip.
  const overallRows = perfChartRows(perf.overallSeries ?? undefined);
  const bin = selected ? deps?.bin : perf.overallBin;
  const chartRows = selected ? perfChartRows(deps?.series) : overallRows;
  // In flight only applies to a selection: the total is already here or it is not.
  const chartLoading = Boolean(selected && deps?.loading && chartRows.length === 0);

  /**
   * Which codes the charted endpoint's failures actually were.
   *
   * 5xx first, then 4xx, each by volume — the same ordering the endpoint table uses, and
   * for the same reason: one 500 is worth more attention than four hundred 404s.
   *
   * Per selection only. The default view is every endpoint at once, where a merged code
   * list would say the site returned 404s without saying by whom, which is not actionable.
   */
  const codes = selected
    ? [...(deps?.codes ?? [])].sort((a, b) =>
        (a.cls === b.cls ? 0 : a.cls === '5xx' ? -1 : 1) || b.count - a.count)
    : [];

  // What the bars on screen add up to. The legend is where a reader is already looking to
  // decode the colours, so the figure for each colour belongs there rather than in a
  // separate summary line — and in the default view these are the only totals on the card
  // that cover every endpoint.
  const ct = chartTotals(chartRows);
  /** Share of the charted traffic, never rounding a real value down to '0.0%'. */
  const share = (n: number) =>
    ct.count > 0 && n > 0 ? (n / ct.count < 0.001 ? '<0.1%' : `${(n / ct.count * 100).toFixed(1)}%`) : '0%';

  const chip = (color: string, label: string, value: number, tip: string) => (
    <span key={label} title={tip} style={{ color: '#6e7681', whiteSpace: 'nowrap' }}>
      <span style={{ color }}>■</span> {label}{' '}
      {/* Dimmed at zero for the same reason as the table cells: a clean class is worth
          seeing at a glance, and a blank reads as "not measured". */}
      <span className="tabular-nums" style={{ color: value > 0 ? color : '#30363d' }}>{value.toLocaleString()}</span>
      <span style={{ color: '#484f58' }}> ({share(value)})</span>
    </span>
  );

  const num = (v: number, color: string, tip: string) => (
    <span className="tabular-nums" style={{ color, textAlign: 'right' }} title={tip}>{v.toLocaleString()}</span>
  );

  return (
    <div style={{ fontSize: 10, padding: '2px 8px 4px' }}>
      {/* Names what the bars are. The set-wide total and one busy endpoint draw the same
          shape, so without this line the two states are indistinguishable. */}
      <div style={{ color: '#6e7681', paddingLeft: 8, marginBottom: 1 }}>
        {selected
          ? <>Charting <span style={{ color: '#cdd9e5' }}>{selected}</span>
              <span style={{ color: '#484f58' }}> — click its row again to go back to the total.</span></>
          : <>Charting <span style={{ color: '#cdd9e5' }}>every endpoint</span>
              {/* Stated, not implied: this is all traffic, while the figures on the row
                  above cover the merged set only — so the two totals will not agree, and
                  a reader who assumes they should will read the gap as a bug. */}
              <span style={{ color: '#484f58' }}> — all requests to this site, including the ones
              outside the {endpoints.length}-endpoint list below. Click a row to chart one.</span></>}
      </div>

      {/* paddingBottom (not the legend row's own margin) is what html2canvas actually
          measures: a trailing margin on the last child can collapse through a
          padding/border-less parent, leaving no real slack for canvas rounding to eat
          into — which is exactly what was slicing the bottom off the legend text. */}
      <div style={{ paddingBottom: 4 }} {...(captureTag ? { 'data-teams-perf-chart': captureTag } : {})}>
      {/* Draws whatever endpoint is selected, fetched on selection. A skeleton while that is
          in flight, not an empty axis — an empty chart reads as "this endpoint had no
          traffic", which is a different statement from "not loaded yet". */}
      {chartLoading
        ? <SkeletonBlock className="w-full rounded-md" style={{ height: 170 }} />
        : !selected && overallRows.length === 0
        // Said rather than drawn as a bare axis: the row list is populated, so an empty
        // plot here means the set-wide timeline query is what came back empty.
        ? <span style={{ color: '#484f58', fontStyle: 'italic', paddingLeft: 8 }}>
            No app-wide timeline for this window — click an endpoint to chart it on its own.
          </span>
        : <EndpointPerfChart
            rows={chartRows}
            binLabel={bin}
            syncId={syncId}
            msFormatter={(ms) => fmtMs(ms)}
            okColor={PERF_OK_COLOR}
            fourXxColor={PERF_4XX_COLOR}
            fiveXxColor={PERF_5XX_COLOR}
            lineColor={PERF_LINE_COLOR}
          />}

      {/* Centred under the plot: the row is now figures rather than a colour key, so it
          reads as the chart's caption, and a caption hanging off the left edge of a
          full-width chart reads as belonging to whatever is to its left. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 10, color: '#484f58', padding: '0 8px', margin: '2px 0 5px' }}>
        {/* The stack height totalled, first: it is what the three colours are shares of. */}
        <span
          style={{ whiteSpace: 'nowrap', color: '#6e7681' }}
          title={selected
            ? `Total requests to ${selected} in this window`
            : 'Total requests to every endpoint on this site in this window — larger than the figure on the Performance row, which counts the merged endpoint set only'}
        >
          {selected ? 'endpoint total' : 'total'}{' '}
          <span className="tabular-nums" style={{ color: '#cdd9e5' }}>{ct.count.toLocaleString()}</span>
        </span>
        {chip(PERF_OK_COLOR,  'successful', ct.ok, 'Requests that returned neither a 4xx nor a 5xx')}
        {chip(PERF_4XX_COLOR, '4xx',        ct.c4, selected ? 'Client errors from this endpoint' : 'Client errors across every endpoint')}
        {chip(PERF_5XX_COLOR, '5xx',        ct.c5, selected ? 'Server errors from this endpoint' : 'Server errors across every endpoint')}
        {/* Peak, not a total: percentiles cannot be summed or averaged across buckets, so
            the worst bucket is the only honest single figure the plotted line supports. */}
        <span style={{ whiteSpace: 'nowrap' }} title="95th percentile response time — right-hand axis. The figure is the worst bucket's P95: percentiles cannot be combined across buckets, so there is no window-wide P95 to quote here.">
          <span style={{ color: PERF_LINE_COLOR }}>──</span> P95 peak{' '}
          <span className="tabular-nums" style={{ color: msColor(ct.peakP95) }}>{fmtMs(ct.peakP95)}</span>
        </span>
        <span style={{ whiteSpace: 'nowrap' }} title="Average response time — right-hand axis. Weighted by each bucket's request count, so a near-empty bucket cannot drag it.">
          <span style={{ color: PERF_LINE_COLOR }}>╌╌</span> average{' '}
          <span className="tabular-nums" style={{ color: msColor(ct.avgMs) }}>{fmtMs(ct.avgMs)}</span>
        </span>
      </div>
      </div>

      {/* Out of the figure row and onto its own line, left-aligned with the paragraph below
          it: this is instruction rather than measurement, and mixing it in made the centred
          figures wrap around a sentence. */}
      <div style={{ color: '#484f58', paddingLeft: 8, marginBottom: 5 }}>
        bar height is requests per {bin ?? 'bucket'} — click a row to chart it, click it again for the total.
      </div>

      {/* Above the table, not below it: this describes how the list was built and how it is
          ordered, which is what a reader needs before reading it rather than after. */}
      <div style={{ color: '#484f58', paddingLeft: 8, marginBottom: 5 }}>
        The ten busiest endpoints, the ten worst 4xx, and every endpoint with a 5xx — merged, query strings stripped.
        Ordered by 5xx, then 4xx, then volume, so a broken endpoint outranks a busy one.
        {perf.fiveXxCapped && (
          <span style={{ color: '#d29922' }}> The 5xx list hit its {perf.fiveXxCap}-endpoint cap, so some may be missing.</span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 6, color: '#6e7681', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: 2, marginBottom: 2 }}>
        <span>endpoint</span>
        <span style={{ textAlign: 'right' }} title="Requests per minute across the window">rpm</span>
        <span style={{ textAlign: 'right' }} title="Total requests in the window">requests</span>
        <span style={{ textAlign: 'right' }} title="Client errors">4xx</span>
        <span style={{ textAlign: 'right' }} title="Server errors">5xx</span>
        <span style={{ textAlign: 'right' }} title="Average response time">avg</span>
        <span style={{ textAlign: 'right' }} title="95th percentile response time">P95</span>
      </div>

      {/* Every row is selectable now. Its timeline is fetched on click rather than shipped
          up front, so there is no such thing as a row without one. */}
      {visibleEndpoints.map(e => {
        const on = e.url === selected;
        return (
          <div
            key={e.url}
            onClick={() => setSelected(prev => (prev === e.url ? null : e.url))}
            title={`${e.url}\n\n${e.count.toLocaleString()} requests, ${e.fourXx.toLocaleString()} 4xx, ${e.fiveXx.toLocaleString()} 5xx\navg ${fmtMs(e.avgMs)} · P95 ${fmtMs(e.p95)} · P99 ${fmtMs(e.p99)} · max ${fmtMs(e.maxMs)}\n\n${on ? 'Click again to go back to the set-wide total' : 'Click to chart it and load its downstream calls'}`}
            style={{
              display: 'grid', gridTemplateColumns: GRID, gap: 6, marginBottom: 1,
              cursor: 'pointer',
              background: on ? 'rgba(88,166,255,0.10)' : 'transparent',
              // Marks the charted row without shifting the grid — a border on one side
              // only would move every column 2px whenever the selection changed.
              boxShadow: on ? `inset 2px 0 0 ${PERF_LINE_COLOR}` : 'none',
              borderRadius: 2,
            }}
          >
            <span style={{ color: on ? '#cdd9e5' : 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: on ? 4 : 0 }}>{e.url}</span>
            {num(e.rpm, PERF_LINE_COLOR, 'Requests per minute')}
            {num(e.count, '#484f58', 'Total requests')}
            {/* Dimmed at zero rather than blank: a dash reads as "not measured", and a
                clean endpoint is worth seeing at a glance. */}
            {num(e.fourXx, e.fourXx ? PERF_4XX_COLOR : '#30363d', '4xx responses')}
            {num(e.fiveXx, e.fiveXx ? PERF_5XX_COLOR : '#30363d', '5xx responses')}
            <span className="tabular-nums" style={{ color: msColor(e.avgMs), textAlign: 'right' }}>{fmtMs(e.avgMs)}</span>
            <span className="tabular-nums" style={{ color: msColor(e.p95), textAlign: 'right' }}>{fmtMs(e.p95)}</span>
          </div>
        );
      })}

      {hiddenRows > 0 && (
        <button
          onClick={() => setShowAllRows(true)}
          style={{
            background: 'none', border: 'none', color: PERF_LINE_COLOR,
            cursor: 'pointer', fontSize: 10, padding: '2px 0', textAlign: 'left',
          }}
          title="The hidden rows are the quiet ones — the list is ordered failures first."
        >
          show {hiddenRows} more {hiddenRows === 1 ? 'endpoint' : 'endpoints'}
        </button>
      )}

      {/* What the charted endpoint called downstream. Below the list rather than beside
          the chart because it is a drill-down of the selection, and because a slow
          endpoint's explanation is usually here — the Dependencies row can say the app's
          SQL is slow, only this can say which endpoint's SQL. */}
      {selected && (
        <div style={{ marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 4 }}>
          <div style={{ color: '#6e7681', fontWeight: 600, marginBottom: 2 }}>
            Downstream calls from <span style={{ color: '#cdd9e5' }}>{selected}</span>
            {selectedDeps.length > 0 && (
              <span style={{ fontWeight: 400, color: '#484f58' }}>
                {' — '}{dt.calls.toLocaleString()} call{dt.calls === 1 ? '' : 's'}
                {dt.targets > 1 && ` across ${dt.targets} targets`}
                {', '}{fmtMs(dt.totalMs)} total
                {dt.failed > 0 && <span style={{ color: PERF_5XX_COLOR }}>, {dt.failed.toLocaleString()} failed</span>}
              </span>
            )}
          </div>

          {/* Three states that must never be shown as one another: in flight, failed, and
              answered-with-nothing. Folding this into the details batch collapsed all
              three into an absent block — which is why a failure looked like silence. */}
          {deps?.loading ? (
            <div className="flex flex-col gap-1" style={{ paddingTop: 2 }}>
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-2">
                  <SkeletonBlock className="h-2.5" style={{ width: `${56 - i * 10}%` }} />
                  <SkeletonBlock className="h-2.5 ml-auto" style={{ width: 40 }} />
                  <SkeletonBlock className="h-2.5" style={{ width: 40 }} />
                </div>
              ))}
            </div>
          ) : deps?.error ? (
            <span style={{ color: '#f85149' }}>{deps.error}</span>
          ) : selectedDeps.length === 0 ? (
            <span style={{ color: '#484f58', fontStyle: 'italic' }}>
              No downstream calls recorded for this endpoint. A dependency raised outside a request carries no
              operation name, so it cannot be attributed to an endpoint.
            </span>
          ) : (
          <>
          <div style={{ display: 'grid', gridTemplateColumns: DEP_GRID, gap: 6, color: '#6e7681', fontWeight: 600, marginBottom: 1 }}>
            <span>call</span>
            <span>target</span>
            <span style={{ textAlign: 'right' }} title="Number of calls this endpoint made">calls</span>
            <span style={{ textAlign: 'right' }} title="Failed calls">failed</span>
            <span style={{ textAlign: 'right' }} title="Average duration per call">avg</span>
            <span style={{ textAlign: 'right' }} title="95th percentile duration">P95</span>
            <span style={{ textAlign: 'right' }} title="Calls multiplied by average duration — the endpoint's own time spent waiting on this call">total</span>
          </div>
          {selectedDeps.map((d, i) => {
            const k = depKey(d);
            const canPlot = (d.series?.length ?? 0) > 0;
            const on = selectedDep === k;
            return (
            <div
              key={`${k}|${i}`}
              onClick={() => canPlot && setSelectedDep(prev => (prev === k ? null : k))}
              style={{
                display: 'grid', gridTemplateColumns: DEP_GRID, gap: 6, marginBottom: 1,
                cursor: canPlot ? 'pointer' : 'default',
                opacity: canPlot ? 1 : 0.5,
                background: on ? 'rgba(88,166,255,0.10)' : 'transparent',
                boxShadow: on ? `inset 2px 0 0 ${PERF_LINE_COLOR}` : 'none',
                borderRadius: 2,
                paddingLeft: on ? 4 : 0,
              }}
              title={`${d.type}${d.target ? ` → ${d.target}` : ''}\n${d.name}\n\n${d.count.toLocaleString()} calls, ${d.failCount.toLocaleString()} failed\navg ${fmtMs(d.avgMs)} · P95 ${fmtMs(d.p95)} · ${fmtMs(d.totalMs)} of this endpoint's total wait${canPlot ? `\n\nClick to ${on ? 'hide' : 'show'} its timeline` : '\n\nNo timeline — only the costliest calls get one'}`}
            >
              <span style={{ color: '#cdd9e5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#6e7681' }}>{d.type || '?'}</span> {d.name}
              </span>
              <span style={{ color: '#6e7681', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.target || '—'}</span>
              <span className="tabular-nums" style={{ color: '#484f58', textAlign: 'right' }}>{d.count.toLocaleString()}</span>
              <span className="tabular-nums" style={{ color: d.failCount ? PERF_5XX_COLOR : '#30363d', textAlign: 'right' }}>{d.failCount.toLocaleString()}</span>
              <span className="tabular-nums" style={{ color: msColor(d.avgMs), textAlign: 'right' }}>{fmtMs(d.avgMs)}</span>
              <span className="tabular-nums" style={{ color: msColor(d.p95), textAlign: 'right' }}>{fmtMs(d.p95)}</span>
              <span className="tabular-nums" style={{ color: '#8b9ab3', textAlign: 'right' }}>{fmtMs(d.totalMs)}</span>
            </div>
            );
          })}

          {/* The charted call sits below its row rather than replacing the endpoint chart at
              the top: the question this answers is whether the two moved together, which
              needs both on screen at once. */}
          {chartedDep && depRows.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <EndpointPerfChart
                rows={depRows}
                binLabel={deps?.bin}
                height={140}
                syncId={syncId}
                msFormatter={(ms) => fmtMs(ms)}
                okColor={PERF_OK_COLOR}
                fiveXxColor={PERF_5XX_COLOR}
                lineColor={PERF_LINE_COLOR}
                showFourXx={false}
                segmentLabels={{ ok: 'succeeded', c5: 'failed' }}
                countNoun="Calls"
              />
              <div style={{ color: '#484f58', paddingLeft: 8 }}>
                <span style={{ color: '#cdd9e5' }}>{chartedDep.name}</span>
                {chartedDep.target ? ` → ${chartedDep.target}` : ''} — calls per {deps?.bin ?? 'bucket'}, coloured by
                outcome, with P95 solid and average dashed on the right axis. Click the row again to hide it.
              </div>
            </div>
          )}
          {/* Stays with the block it explains rather than in a footnote under the whole
              panel — and it is the caveat that matters, since an endpoint's calls summing
              to less than the app-wide Dependencies row is expected, not a discrepancy. */}
          <div style={{ color: '#484f58', marginTop: 2 }}>
            Attributed by the dependency&apos;s operation name and ranked by total time — calls raised outside a
            request carry no operation name, so they appear in the Dependencies row but not here.
          </div>
          </>
          )}
        </div>
      )}

      {/* Which codes the charted endpoint's failures actually were.
          At the foot of the panel rather than under the legend: the legend is the chart's
          caption and has to stay short enough to scan in one line, while this is a list
          that grows with however many codes the endpoint returned. It sits with the
          downstream calls because both are the same kind of thing — the drill-down that
          says WHY the bars above look like that. */}
      {selected && codes.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 4 }}>
          <div style={{ color: '#6e7681', fontWeight: 600, marginBottom: 2 }}>
            Failure codes from <span style={{ color: '#cdd9e5' }}>{selected}</span>
            <span style={{ fontWeight: 400, color: '#484f58' }}>
              {' — '}{(ct.c4 + ct.c5).toLocaleString()} failed request{ct.c4 + ct.c5 === 1 ? '' : 's'}
              {' across '}{codes.length} code{codes.length === 1 ? '' : 's'}
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}>
            {codes.map(c => {
              const color = c.cls === '5xx' ? PERF_5XX_COLOR : PERF_4XX_COLOR;
              const classTotal = c.cls === '5xx' ? ct.c5 : ct.c4;
              return (
                <span
                  key={`${c.cls}|${c.code}`}
                  style={{ whiteSpace: 'nowrap', color }}
                  title={`${c.count.toLocaleString()} × ${c.code} — ${
                    classTotal > 0 ? `${(c.count / classTotal * 100).toFixed(1)}% of this endpoint's ${c.cls}` : c.cls
                  }\navg ${fmtMs(c.avgMs)} · P95 ${fmtMs(c.p95)}${
                    // Says whether it is still happening. A code that stopped an hour ago and
                    // one still arriving are the same number on the bar.
                    c.lastSeen ? `\nlast seen ${new Date(c.lastSeen).toLocaleString()}` : ''
                  }`}
                >
                  <span className="tabular-nums" style={{ fontWeight: 600 }}>{c.code}</span>
                  <span style={{ color: '#484f58' }}> ×</span>{' '}
                  <span className="tabular-nums">{c.count.toLocaleString()}</span>
                  {/* The share is of its own class, not of all failures: 404s and 500s are
                      different questions, and one percentage over both answers neither. */}
                  {classTotal > 0 && (
                    <span style={{ color: '#484f58' }}> ({(c.count / classTotal * 100).toFixed(1)}% of {c.cls})</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The Performance row as it sits inside a FE / API section table, expanding to the
 * panel above.
 *
 * This is where the card answers "what is slow and what is failing". It replaced a pair
 * of rows that reported app-wide latency and app-wide error counts separately, neither of
 * which could name an endpoint — so a rising 4xx count and a rising P95 were two figures
 * you had to guess were the same problem.
 */
export function PerformanceRows({
  perf, expanded, onToggle, fmtMs, fmtPct, syncId, loading = false, error, unavailableMessage,
  deps, onRequestDeps, captureTag,
}: {
  /** The charted endpoint's downstream calls, and the request for them. */
  deps?: EndpointDepsState | undefined;
  onRequestDeps?: ((endpoint: string) => void) | undefined;
  perf: EndpointPerformance | null | undefined;
  expanded: boolean;
  onToggle: () => void;
  fmtMs: (ms: number | null) => string;
  /** Share of a total, rendering a real-but-tiny rate as '<0.1%' rather than '0.0%'.
   *  Passed in rather than imported: it lives in the card, and importing from there
   *  would close a cycle since the card imports this. */
  fmtPct: (n: number, total: number) => string;
  syncId?: string | undefined;
  /** The card's details fetch is in flight — this payload arrives with it. */
  loading?: boolean;
  error?: string | null | undefined;
  /** Shown expanded when the app has no App Insights resource configured. */
  unavailableMessage?: string | undefined;
  /** Forwarded to PerformancePanel — see its own doc for what this tags. */
  captureTag?: string | undefined;
}) {
  const has = hasPerfData(perf);
  // The merged endpoint set (10 busiest + 10 worst-4xx + every 5xx) is what the table
  // below charts, but it is a subset of the app's real traffic — `slowest` has no
  // app-wide equivalent (only endpoint rollups carry a single worst request), so it
  // still comes from here.
  const t = perfTotals(perf?.endpoints);
  // Everything else on the row uses the same app-wide series the chart defaults to
  // when nothing is selected, so the collapsed row and the "every endpoint" chart
  // it expands into never disagree. Falls back to the merged set only when the
  // app-wide timeline itself came back empty for the window.
  const overall = chartTotals(perfChartRows(perf?.overallSeries ?? undefined));
  const total = overall.count > 0 ? overall.count : t.requests;
  const fourXx = overall.count > 0 ? overall.c4 : t.fourXx;
  const fiveXx = overall.count > 0 ? overall.c5 : t.fiveXx;
  const peakP95 = overall.count > 0 ? overall.peakP95 : t.worstP95;
  const avgMs = overall.count > 0 ? overall.avgMs : t.avgMs;

  return (
    <>
      {/* Always clickable: the endpoint data arrives with the card's lazy details fetch,
          so a row that only opened once it had figures would never open at all —
          expanding it is what asks for them. */}
      <tr
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td
          className="text-muted-foreground font-bold"
          title="Performance: the ten busiest endpoints, the ten worst 4xx, and every endpoint with a 5xx, merged into one set. Each row carries rate, errors and duration together. Expand to chart one endpoint's traffic, errors and latency on a single plot."
        >
          Performance
          {expanded
            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
          {/* The endpoint count sits with the label rather than in its own cell: the two
              numeric cells now carry three figures each, and a fourth column of one
              number would be the widest thing in the row for the least information. */}
          {has && (
            <span
              style={{ marginLeft: 6, fontWeight: 400, fontSize: 10, color: '#484f58' }}
              title={`${t.endpoints} endpoints in the merged set${t.failing > 0 ? `, ${t.failing} of them returning 5xx` : ''}`}
            >
              {t.endpoints} endpoints
            </span>
          )}
        </td>
        {/* Request and Response share one flex row instead of a fixed 40/20 column
            split: app-wide counts run several digits longer than the merged-set
            figures this table's colgroup was sized for, and a rigid boundary cut
            through the middle of "Request" on a bad window. Flex sizes each side to
            its own content and pushes them apart, so the gap always falls between
            them rather than through either one. */}
        <td colSpan={3} className="text-right" style={{ whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {!has
            ? loading ? <CellSkeleton w={104} /> : <span className="text-muted-foreground">—</span>
            // flex-end anchors both halves to the right when they fit on one line;
            // wrap drops Response to its own line, still right-aligned, on a
            // narrow card or a window with enough digits that they no longer do —
            // the fixed-width table cell can't grow to fit them, so this is what
            // keeps a long Request from spilling out through the card's own border
            // instead of just being cut off cleanly by it.
            : <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 16 }}>
                {/* Labelled because the two halves hold different kinds of figure —
                    three counts and three durations — and unlabelled trios of numbers
                    give no clue which is which. */}
                <span
                  title={`${fiveXx.toLocaleString()} server errors (5xx) and ${fourXx.toLocaleString()} client errors (4xx) out of ${total.toLocaleString()} requests to the whole app — ${total > 0 ? ((fiveXx + fourXx) / total * 100).toFixed(2) : '0.00'}% failed.\n\nApp-wide, not just the merged endpoint set listed below (the ten busiest, the ten worst 4xx, and every endpoint with a 5xx).`}
                >
                  <span style={{ color: '#6e7681' }}>Request - </span>
                  <span style={{ color: fiveXx > 0 ? PERF_5XX_COLOR : '#484f58', fontSize: 10 }}>{fiveXx.toLocaleString()} ({fmtPct(fiveXx, total)})</span>
                  <span style={{ color: '#484f58' }}> / </span>
                  <span style={{ color: fourXx > 0 ? PERF_4XX_COLOR : '#484f58', fontSize: 10 }}>{fourXx.toLocaleString()} ({fmtPct(fourXx, total)})</span>
                  <span style={{ color: '#484f58' }}> / </span>
                  <span style={{ color: PERF_LINE_COLOR }}>{total.toLocaleString()}</span>
                </span>
                <span
                  title={`P95 ${fmtMs(peakP95)} / average ${fmtMs(avgMs)} / slowest ${fmtMs(t.slowest)}.\n\nP95 is the worst bucket's P95 across the whole app, not a true app-wide percentile — percentiles cannot be averaged across buckets, so naming the worst is the only honest figure without the raw durations.\n\nThe average is weighted by request count, so a near-empty bucket at 8s does not drag it up as hard as a busy one at 40ms.\n\nSlowest is the single slowest request to any endpoint in the merged set below — the one figure here without an app-wide equivalent, since only endpoint rollups carry a single worst request.`}
                >
                  <span style={{ color: '#6e7681' }}>Response - </span>
                  <span className="tabular-nums" style={{ color: msColor(peakP95), fontSize: 10 }}>{fmtMs(peakP95)}</span>
                  <span style={{ color: '#484f58' }}> / </span>
                  <span className="tabular-nums" style={{ color: msColor(avgMs), fontSize: 10 }}>{fmtMs(avgMs)}</span>
                  <span style={{ color: '#484f58' }}> / </span>
                  <span className="tabular-nums" style={{ color: msColor(t.slowest), fontSize: 10 }}>{fmtMs(t.slowest)}</span>
                </span>
              </div>
          }
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
            {loading && !has
              ? <PanelSkeleton rows={5} chartHeight={150} />
              : error
                ? <span className="text-[10px] text-destructive">{error}</span>
                : unavailableMessage
                  ? <span className="text-[10px] text-muted-foreground italic">{unavailableMessage}</span>
                  : has && perf
                    ? <PerformancePanel perf={perf} fmtMs={fmtMs} syncId={syncId} deps={deps} onRequestDeps={onRequestDeps} captureTag={captureTag} />
                    : <span className="text-[10px] text-muted-foreground italic">No request telemetry in this window</span>
            }
          </td>
        </tr>
      )}
    </>
  );
}
