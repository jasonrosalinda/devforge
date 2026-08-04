/**
 * Loading placeholders for the app health card.
 *
 * The card loads in three waves — metrics, then the App Insights details, then the
 * per-section detector calls — so at any moment part of it has data and part does not.
 * A skeleton says "this is coming"; an em dash says "this is nothing". Using the dash for
 * both is the failure worth avoiding: a row reading `— / —` while its fetch is still in
 * flight looks like a healthy app with no errors.
 *
 * So these are only ever rendered against a live loading flag. A value that is absent
 * because it was never requested, or because the window genuinely holds none, keeps its
 * dash.
 */

/** The shared shimmer. Matches the whole-card skeleton and the chart placeholder. */
export function SkeletonBlock({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`animate-pulse rounded bg-muted ${className ?? ''}`} style={style} />;
}

/**
 * A numeric table cell's placeholder — right-aligned, so it sits where the figure will.
 *
 * Widths vary a little per cell so a row of them does not read as a progress bar; the
 * `w` prop is the bar width in pixels.
 */
export function CellSkeleton({ w = 44 }: { w?: number }) {
  return (
    <span className="inline-flex justify-end w-full" aria-hidden>
      <SkeletonBlock className="h-2.5" style={{ width: w }} />
    </span>
  );
}

/**
 * The expanded body of a section whose payload has not arrived: a chart-sized block over
 * a few list lines, roughly the shape of what replaces it.
 *
 * Shaped rather than a single grey box because the panel is tall — a full-height blank
 * rectangle reads as a broken layout, while a chart plus rows reads as content loading.
 */
export function PanelSkeleton({ rows = 4, chartHeight = 110 }: { rows?: number; chartHeight?: number }) {
  return (
    <div style={{ padding: '2px 8px 4px' }} aria-busy="true" aria-label="Loading">
      <SkeletonBlock className="w-full rounded-md" style={{ height: chartHeight }} />
      <div className="flex flex-col gap-1" style={{ marginTop: 6 }}>
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-2">
            {/* The label column tapers down the list, the way real endpoint and client
                names do — uniform bars look like a table that failed to populate. */}
            <SkeletonBlock className="h-2.5" style={{ width: `${68 - i * 9}%` }} />
            <SkeletonBlock className="h-2.5 ml-auto" style={{ width: 40 }} />
            <SkeletonBlock className="h-2.5" style={{ width: 40 }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The same, as a full-width row inside one of the card's four-column tables. */
export function PanelSkeletonRow({ rows = 4, chartHeight = 110 }: { rows?: number; chartHeight?: number }) {
  return (
    <tr>
      <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
        <PanelSkeleton rows={rows} chartHeight={chartHeight} />
      </td>
    </tr>
  );
}

/** A list-only placeholder, for sections that expand to rows without a chart. */
export function ListSkeletonRow({ rows = 5 }: { rows?: number }) {
  return (
    <tr>
      <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
        <div className="flex flex-col gap-1" style={{ padding: '2px 8px 4px' }} aria-busy="true" aria-label="Loading">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="flex items-center gap-2">
              <SkeletonBlock className="h-2.5" style={{ width: `${70 - i * 8}%` }} />
              <SkeletonBlock className="h-2.5 ml-auto" style={{ width: 44 }} />
            </div>
          ))}
        </div>
      </td>
    </tr>
  );
}
