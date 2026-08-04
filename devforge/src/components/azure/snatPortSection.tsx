import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SnatResult } from '@shared/types/azureMetrics.types';
import { EndpointSeriesChart, INSTANCE_PALETTE } from './azureMetricChart';
import { CellSkeleton, PanelSkeleton } from './loadingSkeleton';

/**
 * The four SNAT charts App Service Diagnostics publishes, drawn from the detector
 * payload parsed in electron/ipc/azure-snat.cjs.
 *
 * These are the only DIRECT evidence of port pressure on the card — the socket
 * exception tabs infer it from exception text.
 *
 * Colours are assigned per series name across the whole section rather than per
 * chart, so the same worker keeps one colour as you read down the four panels.
 */
export function SnatPortPanel({
  snat, loading, syncId,
}: {
  snat: SnatResult | null | undefined;
  loading: boolean;
  /** Card-wide hover group — see SeriesChart in azureMetricChart. */
  syncId?: string | undefined;
}) {
  // Hidden workers, keyed by instance and applied across all four charts: one
  // instance's spike flattens everything else, and the reason to hide it — reading
  // what the other workers did — holds for every panel at once.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setHidden(prev => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const note = (text: string, color = 'var(--muted-foreground)') => (
    <div style={{ fontSize: 10, color, fontStyle: 'italic', padding: '6px 8px' }}>{text}</div>
  );

  if (loading && !snat) return <PanelSkeleton rows={3} chartHeight={100} />;
  if (snat?.error) return note(`SNAT diagnostics failed: ${snat.error}`, '#f85149');
  if (!snat?.charts?.length) {
    return note('SNAT diagnostics unavailable for this site — App Service Diagnostics publishes them for Windows plans only.');
  }

  const colorOf = new Map<string, string>();
  for (const chart of snat.charts) {
    for (const s of chart.series) {
      if (!colorOf.has(s.name)) {
        colorOf.set(s.name, INSTANCE_PALETTE[colorOf.size % INSTANCE_PALETTE.length] ?? '#8b9ab3');
      }
    }
  }

  return (
    <div style={{ fontSize: 10, padding: '4px 8px 2px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
        {snat.charts.map(chart => {
          const groups = groupByInstance(chart.series);
          const shown = chart.series.filter(s => !hidden.has(splitSeriesName(s.name).instance));
          // Tooltip labels drop the counter wrapper the detector puts on every series.
          // "Pending(wn0K9R)" in the Pending chart says nothing the title has not
          // already said; only the usage chart plots two counters per worker, so only
          // it keeps them — as "Allocated" / "Used", without the TCP_ prefix.
          const counters = new Set(chart.series.map(s => prettyCounter(splitSeriesName(s.name).counter)).filter(Boolean));
          const labelOf = (name: string) => {
            const { instance, counter } = splitSeriesName(name);
            const short = prettyCounter(counter);
            return counters.size > 1 && short ? `${instance} ${short}` : instance;
          };
          const series = shown.map(s => ({ url: labelOf(s.name), series: s.series }));
          const colors = shown.map(s => colorOf.get(s.name) ?? '#8b9ab3');
          return (
            <div key={chart.title} style={{ minWidth: 0 }}>
              <div style={{ color: '#8b949e', fontWeight: 600, marginBottom: 2 }}>{chart.title}</div>
              {/* An empty chart is a result, not a gap: no failed connections and no
                  pending ones is what a healthy window looks like, and dropping the
                  panel would leave the reader unsure whether it was even checked. */}
              {chart.series.length === 0
                ? <div style={{ height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3fb950' }}>None in this window</div>
                : series.length === 0
                  ? <div style={{ height: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7681' }}>All workers hidden — click a legend entry to show one</div>
                  : <EndpointSeriesChart series={series} colors={colors} height={130} syncId={syncId} />}
              {/* EndpointSeriesChart draws no legend of its own — its usual caller is a
                  list of endpoint toggles, and so is this: one entry per worker, click
                  to drop it out of the plot. The peaks carry their line's colour, so
                  the counter names would only repeat what the colour already says. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, paddingLeft: 8, marginTop: 2 }}>
                {groups.map(group => {
                  const off = hidden.has(group.instance);
                  return (
                    <span
                      key={group.instance}
                      onClick={() => toggle(group.instance)}
                      style={{
                        color: '#6e7681', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
                        opacity: off ? 0.4 : 1, textDecoration: off ? 'line-through' : 'none',
                      }}
                      title={`${group.instance}: ${group.counters.map(c => `${prettyCounter(c.counter)} ${c.peak.toLocaleString()}`).join(' | ')}`}
                    >
                      <span style={{ fontWeight: 700 }}>{group.instance}</span>
                      <span style={{ color: '#484f58' }}> - </span>
                      {group.counters.map((c, i) => (
                        <span key={c.name}>
                          {i > 0 && <span style={{ color: '#484f58' }}> / </span>}
                          <span style={{ color: colorOf.get(c.name), fontWeight: 600 }}>
                            {c.peak.toLocaleString()}
                          </span>
                        </span>
                      ))}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ color: '#484f58', paddingLeft: 8, marginTop: 6 }}>
        Ports are allocated per worker instance on the App Service plan, so these figures cover every site sharing the plan
        {snat.detector ? ` · detector: ${snat.detector}` : ''}.
        {/* Stated rather than silently tolerated: at a coarser grain a spike that
            lasted one minute is averaged away, and these charts would otherwise
            look directly comparable with the rest of the card. */}
        {(() => {
          const mismatch = grainMismatch(snat.requestedGrain, snat.grainMs);
          if (!mismatch) return null;
          return (
            <span style={{ color: '#d29922' }} title="App Service Diagnostics chooses its own bucket width and ignores finer requests on wider windows. Shorten the time range to get closer to the interval you picked.">
              {' '}Detector returned {mismatch.actual} buckets — the {mismatch.requested} interval could not be applied, so short spikes are averaged out.
            </span>
          );
        })()}
      </div>
    </div>
  );
}

/** 'PT1M' → 60000. Returns null for anything unrecognised. */
export function isoDurationToMs(iso: string | null | undefined): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(String(iso ?? ''));
  if (!m) return null;
  const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
  return ms > 0 ? ms : null;
}

/** 60000 → '1m'. Minutes and hours only — detector grains never go finer. */
export function grainLabel(ms: number | null | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins <= 0) return `${Math.round(ms / 1000)}s`;
  return mins % 60 === 0 && mins >= 60 ? `${mins / 60}h` : `${mins}m`;
}

/**
 * The detector is free to ignore the requested timeGrain, and often does on wide
 * windows. Returns the mismatch to state on the panel, or null when the charts
 * came back at the interval that was asked for.
 */
export function grainMismatch(
  requested: string | null | undefined,
  actualMs: number | null | undefined,
): { requested: string; actual: string } | null {
  const wantMs = isoDurationToMs(requested);
  const want = grainLabel(wantMs);
  const got = grainLabel(actualMs);
  if (!want || !got || !wantMs || !actualMs) return null;
  // One bucket of slack: bins land a second or two apart on real data.
  return Math.abs(actualMs - wantMs) > 1000 ? { requested: want, actual: got } : null;
}

// Detector series are labelled `<worker>(<counter>)` — but which side is which
// flips between charts: "wn0sdwk000K9C(TCP_Allocated)" against "Pending(wn0K9R)".
// The counter is the side that names a counter; whatever is left is the worker.
const COUNTER_WORD = /alloc|used|pending|fail|success|count|total/i;

/** "TCP_Allocated" → "Allocated". The protocol is already in the chart title. */
export function prettyCounter(counter: string): string {
  return counter.replace(/^tcp[\s_-]*/i, '');
}

export function splitSeriesName(name: string): { instance: string; counter: string } {
  const m = /^(.+?)\(([^)]*)\)\s*$/.exec(name);
  if (!m) return { instance: name, counter: '' };
  const left = m[1] ?? '';
  const right = m[2] ?? '';
  return COUNTER_WORD.test(left) && !COUNTER_WORD.test(right)
    ? { instance: right, counter: left }
    : { instance: left, counter: right };
}

/**
 * One legend row per worker: `wn0sdwk000K9C  TCP_Used / TCP_Allocated  12 / 128`.
 * Used before allocated, because the pair reads as "how much of what we hold".
 */
export function groupByInstance(
  series: Array<{ name: string; series: Array<{ t: string; count: number }> }>,
): Array<{ instance: string; counters: Array<{ name: string; counter: string; peak: number }> }> {
  const groups = new Map<string, Array<{ name: string; counter: string; peak: number }>>();
  for (const s of series) {
    const { instance, counter } = splitSeriesName(s.name);
    const peak = s.series.reduce((m, p) => Math.max(m, p.count), 0);
    if (!groups.has(instance)) groups.set(instance, []);
    groups.get(instance)!.push({ name: s.name, counter: counter || s.name, peak });
  }
  const rank = (c: string) => /used/i.test(c) ? 0 : /alloc/i.test(c) ? 1 : 2;
  return [...groups.entries()].map(([instance, counters]) => ({
    instance,
    counters: counters.sort((a, b) => rank(a.counter) - rank(b.counter) || a.counter.localeCompare(b.counter)),
  }));
}

/** Peak of every series in the named chart whose label matches. */
function peakIn(snat: SnatResult | null | undefined, titlePrefix: string, match?: RegExp): number | null {
  const chart = snat?.charts?.find(c => c.title.startsWith(titlePrefix));
  const series = (chart?.series ?? []).filter(s => !match || match.test(s.name));
  if (!series.length) return null;
  return series.reduce((m, s) => Math.max(m, ...s.series.map(p => p.count)), 0);
}

/** Every bucket of every worker added up. Null when the chart is absent entirely
 *  — an empty chart is a real zero, a missing one is unknown. */
function totalIn(snat: SnatResult | null | undefined, titlePrefix: string): number | null {
  const chart = snat?.charts?.find(c => c.title.startsWith(titlePrefix));
  if (!chart) return null;
  return chart.series.reduce((sum, s) => sum + s.series.reduce((a, p) => a + p.count, 0), 0);
}

/**
 * The SNAT rows as they sit inside the FE / API section tables: a summary row that
 * loads the charts on first expand, and the panel underneath.
 *
 * Returned as table rows rather than a self-contained block so the section keeps
 * one set of column widths — the summary lines up with Requests, Dependencies and
 * the rest of the rows above it.
 */
export function SnatPortsRows({
  snat, loading, expanded, onToggle, syncId,
}: {
  snat: SnatResult | null | undefined;
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
  syncId?: string | undefined;
}) {
  const peakAllocated = peakIn(snat, 'SNAT port usage', /alloc/i);
  const peakUsed = peakIn(snat, 'SNAT port usage', /used/i);
  // Failed is the one that means trouble; pending sits beside it because a rising
  // queue is what precedes failures once the plan runs out of ports.
  const failedTotal = totalIn(snat, 'Failed');
  const pendingTotal = totalIn(snat, 'Pending');
  const pendingPeak = peakIn(snat, 'Pending');

  return (
    <>
      <tr
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td className="text-muted-foreground font-bold">
          <span title="SNAT Ports: outbound port allocations per worker instance, from App Service Diagnostics. Ports are allocated per instance on the App Service plan, so the figures cover every site sharing the plan. Expand to load the four portal charts.">SNAT Ports</span>
          {expanded
            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
        </td>
        {/* Fixed colours, not thresholds: amber is what "pending" means and red is
            what "failed" means, so the row is scannable by category even at zero —
            and a zero in red reads as "none of the bad thing", not as an alarm. */}
        <td
          className="text-right tabular-nums"
          style={{ whiteSpace: 'nowrap', color: '#d29922' }}
          title={'Pending SNAT connections: outbound connections queued waiting for a free SNAT port. '
            + 'Totalled across time buckets and worker instances. A queue that keeps growing is what precedes outright failures.'
            + (pendingPeak != null ? ` Peak ${pendingPeak.toLocaleString()} waiting at once.` : '')}
        >
          {loading && !snat ? <CellSkeleton w={64} /> : pendingTotal != null ? `${pendingTotal.toLocaleString()} pending` : '—'}
        </td>
        <td
          className="text-right tabular-nums"
          style={{ whiteSpace: 'nowrap', color: 'hsl(var(--destructive))' }}
          title={'Failed SNAT connections: outbound connections that could not get a SNAT port at all — the direct evidence of port exhaustion. '
            + 'Totalled across time buckets and worker instances. Anything above zero here means requests were dropped, not just delayed.'}
        >
          {loading && !snat ? <CellSkeleton w={56} /> : failedTotal != null ? `${failedTotal.toLocaleString()} failed` : '—'}
        </td>
        {/* Ports sit in the Max column: both figures are peaks over the window, which
            is what that column means on every other row. */}
        <td
          className="text-right tabular-nums"
          style={{ whiteSpace: 'nowrap', color: '#8b9ab3' }}
          title={peakAllocated != null
            ? `Peak ${peakUsed?.toLocaleString() ?? '—'} ports in use out of ${peakAllocated.toLocaleString()} allocated, on the busiest worker`
            : undefined}
        >
          {loading && !snat
            ? <CellSkeleton w={76} />
            : peakAllocated != null
              ? `${peakUsed != null ? peakUsed.toLocaleString() : '—'} / ${peakAllocated.toLocaleString()}`
              : snat ? 'no port data' : '—'}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
            <SnatPortPanel snat={snat} loading={loading} syncId={syncId} />
          </td>
        </tr>
      )}
    </>
  );
}
