// Exception volume over time, one line per throw site.
//
// The exception lists elsewhere in this card rank endpoints, which answers "which
// URL was hit" and never "which line threw". A shared component that fails on
// every page it renders on scatters into hundreds of unremarkable endpoint rows;
// grouped by its stack frame it is one line, and the shape of that line is the
// diagnosis — a step at a deploy, a spike under load, or a constant bleed that
// has been there all along.

import { useMemo, useState } from 'react';
import { EndpointSeriesChart, INSTANCE_PALETTE } from './azureMetricChart';
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

/** What the legend calls a site: the source file, else the method.
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

/** Everything known about the site, for the row's native tooltip.
 *
 *  The method is shown only for a fileless frame. Where there is a file the site
 *  is the file, and `method` is just one of however many methods in it threw —
 *  naming it would claim a precision the row does not have. */
function siteTitle(s: ExceptionLocationSeries): string {
  return [
    s.assembly && `Assembly: ${s.assembly}`,
    s.file ? `File: ${s.file}` : s.method && `Method: ${s.method}`,
    `${s.trueCount.toLocaleString()} exception${s.trueCount === 1 ? '' : 's'} in this window`,
  ].filter(Boolean).join('\n');
}

/** Identity, matching how the query grouped: the file when there is one, else the
 *  method. Two files with the same basename in different assemblies stay distinct
 *  — they share a legend label but are not the same site. */
export function siteKey(s: ExceptionLocationSeries): string {
  return `${s.assembly}|${s.file || s.method}`;
}

export function ExceptionLocationChart({
  sites, bin, topN, syncId, height = 150,
}: {
  /** Already filtered to the active bucket by the caller. */
  sites: ExceptionLocationSeries[];
  /** KQL bin width behind the series ("5m", "1h", …) — shown as the unit. */
  bin?: string | null | undefined;
  /** Sites-per-bucket cap the query applied, so a full list can say so. */
  topN?: number | null | undefined;
  syncId?: string | undefined;
  height?: number;
}) {
  // Deselected sites, by key. Starts empty — every site plots until hidden, and
  // a key set survives a tab switch harmlessly because keys are bucket-unique.
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const ranked = useMemo(
    () => [...sites].sort((a, b) => b.trueCount - a.trueCount),
    [sites],
  );

  // Colour is assigned by rank over ALL sites, not over the visible ones, so
  // hiding a line never re-colours the lines that stay.
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    ranked.forEach((s, i) => m.set(siteKey(s), INSTANCE_PALETTE[i % INSTANCE_PALETTE.length]!));
    return m;
  }, [ranked]);

  if (!ranked.length) return null;

  const shown = ranked.filter(s => !hidden.has(siteKey(s)));
  const toggle = (key: string) => setHidden(prev => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  return (
    <div style={{ paddingLeft: 20, paddingTop: 6, paddingBottom: 6 }}>
      <div style={{ fontSize: 9, color: '#6e7681', fontWeight: 600, marginBottom: 2 }}>
        Exceptions over time by throw site
        {bin ? <span style={{ fontWeight: 400 }}> · per {bin}</span> : null}
      </div>

      <EndpointSeriesChart
        series={shown.map(s => ({ url: siteLabel(s), series: s.series }))}
        colors={shown.map(s => colorOf.get(siteKey(s)) ?? '#8b9ab3')}
        {...(bin ? { binLabel: bin } : {})}
        height={height}
        {...(syncId ? { syncId } : {})}
      />

      {/* The legend doubles as the filter: eight overlapping lines are unreadable
          until you can mute the loud one and see what is underneath it. */}
      <div className="flex flex-wrap gap-x-3 gap-y-1" style={{ marginTop: 4 }}>
        {ranked.map(s => {
          const key = siteKey(s);
          const off = hidden.has(key);
          const color = colorOf.get(key) ?? '#8b9ab3';
          return (
            <button
              key={key}
              onClick={e => { e.stopPropagation(); toggle(key); }}
              title={siteTitle(s)}
              className="flex items-center gap-1"
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: 9, opacity: off ? 0.35 : 1,
              }}
            >
              <span style={{
                width: 8, height: 2, borderRadius: 1, flexShrink: 0,
                background: color,
              }} />
              <span style={{ color: off ? '#6e7681' : '#c9d1d9', textDecoration: off ? 'line-through' : 'none' }}>
                {siteLabel(s)}
              </span>
              <span className="tabular-nums" style={{ color: '#6e7681' }}>
                {s.trueCount.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>

      {topN != null && ranked.length >= topN && (
        <div style={{ fontSize: 9, color: '#6e7681', marginTop: 3 }}>
          Showing the {topN} highest-volume throw sites — narrow the time range to see the rest.
        </div>
      )}
    </div>
  );
}
