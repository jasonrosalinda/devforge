// Exception volume over time — one combined line, summed across whatever throw
// sites the caller passes in (a whole bucket, or one exception type's sites).
//
// The exception lists elsewhere in this card rank endpoints, which answers "which
// URL was hit" and never "which line threw". A shared component that fails on
// every page it renders on scatters into hundreds of unremarkable endpoint rows;
// grouped by its stack frame and totalled, the plotted line's shape is the
// diagnosis — a step at a deploy, a spike under load, or a constant bleed that
// has been there all along. One line per site instead would answer "which site"
// at the cost of "is this getting worse", which is the question a chart is for;
// per-site drill-down lives in the throw-site table below instead.

import { useMemo } from 'react';
import { EndpointSeriesChart } from './azureMetricChart';
import type { ExceptionLocationSeries } from '@shared/types/azureMetrics.types';

/** Last path segment of a stack frame's source path — `/src/src/App/Foo.razor`
 *  → `Foo.razor`. The full path goes in the row's tooltip; at legend width it
 *  would push the only distinguishing part (the file) off the end. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Short type name from a fully-qualified one, minus the compiler's async
 *  state-machine suffix: `A.B.Widget+<OnInitializedAsync>d__4.MoveNext` reads as
 *  `Widget.OnInitializedAsync`. */
function shortMethod(method: string): string {
  const asyncMatch = method.match(/^(?:.*\.)?([^.+]+)\+<([^>]+)>/);
  if (asyncMatch) return `${asyncMatch[1]}.${asyncMatch[2]}`;
  const parts = method.split('.');
  return parts.length > 2 ? parts.slice(-2).join('.') : method;
}

/** The display name for a site: the source file, else the method.
 *
 *  No line number — sites are grouped without one. The same defect reports
 *  different lines as its file is edited between deploys, and `Widget.razor:24`
 *  plotted beside `Widget.razor:84` reads as two problems while halving the
 *  apparent height of the one that exists. Lines live in the drill-down table. */
export function siteLabel(s: ExceptionLocationSeries): string {
  if (s.file) return baseName(s.file);
  if (s.method) return shortMethod(s.method);
  return s.assembly || '(unknown site)';
}

/** Identity, matching how the query grouped: the file when there is one, else the
 *  method. Two files with the same basename in different assemblies stay distinct
 *  — they share a display name but are not the same site. */
export function siteKey(s: ExceptionLocationSeries): string {
  return `${s.assembly}|${s.file || s.method}`;
}

export function ExceptionLocationChart({
  sites, bin, topN, syncId, height = 150, color,
}: {
  /** Already filtered to the active bucket by the caller. */
  sites: ExceptionLocationSeries[];
  /** KQL bin width behind the series ("5m", "1h", …) — shown as the unit. */
  bin?: string | null | undefined;
  /** Sites-per-bucket cap the query applied, so a full list can say so. */
  topN?: number | null | undefined;
  syncId?: string | undefined;
  height?: number;
  /** The active bucket's accent (EXC_TABS), so the combined line reads as "this
   *  classification" without a legend entry of its own. */
  color?: string | undefined;
}) {
  const ranked = useMemo(
    () => [...sites].sort((a, b) => b.trueCount - a.trueCount),
    [sites],
  );

  if (!ranked.length) return null;

  // One combined total rather than a line per site: summed bucket-by-bucket
  // across every site passed in — the caller has already narrowed `sites` to
  // whatever this chart is meant to total (a bucket, or one exception type's
  // throw sites), so there is no further filtering to do here.
  const overallSeries = useMemo(() => {
    const totals = new Map<string, number>();
    for (const s of ranked) {
      for (const p of s.series) totals.set(p.t, (totals.get(p.t) ?? 0) + p.count);
    }
    return [...totals.entries()]
      .sort(([a], [b]) => new Date(a).getTime() - new Date(b).getTime())
      .map(([t, count]) => ({ t, count }));
  }, [ranked]);

  return (
    <div style={{ paddingLeft: 20, paddingTop: 6, paddingBottom: 6 }}>
      <div style={{ fontSize: 9, color: '#6e7681', fontWeight: 600, marginBottom: 2 }}>
        Exceptions over time
        {bin ? <span style={{ fontWeight: 400 }}> · per {bin}</span> : null}
      </div>

      <EndpointSeriesChart
        series={[{ url: 'Exceptions', series: overallSeries }]}
        colors={[color ?? '#f85149']}
        {...(bin ? { binLabel: bin } : {})}
        height={height}
        {...(syncId ? { syncId } : {})}
      />

      {topN != null && ranked.length >= topN && (
        <div style={{ fontSize: 9, color: '#6e7681', marginTop: 3 }}>
          Showing the {topN} highest-volume throw sites — narrow the time range to see the rest.
        </div>
      )}
    </div>
  );
}
