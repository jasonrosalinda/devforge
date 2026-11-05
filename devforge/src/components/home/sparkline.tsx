/** SVG polyline points for `values` scaled into w×h, with 0 at the bottom and `max` at the
 *  top (the series' own max when larger). Pure; exported for tests. */
export function toPoints(values: number[], w: number, h: number, max = 0): string {
  if (!values.length) return '';
  const top = Math.max(max, ...values) || 1;
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (v: number) => +(h - (Math.max(0, v) / top) * h).toFixed(1);
  // One value draws as a flat line across, not a dot at the left edge.
  if (values.length === 1) return `0,${y(values[0]!)} ${w},${y(values[0]!)}`;
  return values.map((v, i) => `${+(i * step).toFixed(1)},${y(v)}`).join(' ');
}

const W = 120;
const H = 28;

/** A tiny trend line: area under it, release ticks, and an optional threshold. No recharts —
 *  a dozen of these on Home must cost next to nothing. */
export function Sparkline({ values, max = 0, ticks = [], threshold, color, label }: {
  values: number[];
  /** Fixed top of the scale (100 for a percentage), so a flat 5% line doesn't fill the box. */
  max?: number;
  /** 0..1 positions along the window. */
  ticks?: number[];
  threshold?: number | undefined;
  color: string;
  label: string;
}) {
  const points = toPoints(values, W, H, Math.max(max, threshold ?? 0));
  const top = Math.max(max, threshold ?? 0, ...values) || 1;
  return (
    // Stretches to its container's width; non-scaling strokes keep lines crisp when it does.
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="min-w-0 flex-1 overflow-visible">
      {ticks.map((t, i) => (
        <line key={i} x1={t * W} x2={t * W} y1={0} y2={H} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 2" strokeWidth={1} opacity={0.6} vectorEffect="non-scaling-stroke" />
      ))}
      {threshold != null && (
        <line x1={0} x2={W} y1={H - (threshold / top) * H} y2={H - (threshold / top) * H} stroke="hsl(var(--error))" strokeWidth={1} opacity={0.4} vectorEffect="non-scaling-stroke" />
      )}
      {points && (
        <>
          <polygon points={`0,${H} ${points} ${W},${H}`} fill={color} opacity={0.15} />
          <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </>
      )}
      {!points && <line x1={0} x2={W} y1={H - 1} y2={H - 1} stroke="hsl(var(--border))" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}
