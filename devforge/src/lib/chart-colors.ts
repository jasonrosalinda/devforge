/**
 * Shared colour source for the Azure dashboard charts and their surrounding chrome.
 *
 * Two families, deliberately kept apart:
 *
 * - `CHART_COLORS` / `INSTANCE_PALETTE` are **categorical** and stay literal hex.
 *   The hues are picked for mutual separability once several lines overlap, and
 *   that separability must not shift with the theme.
 *
 * - `UI` is **semantic** and resolves through CSS custom properties, so it tracks
 *   the active theme with no re-render. Both React inline styles and Recharts
 *   props (`stroke`, `fill`, `contentStyle`, …) resolve `hsl(var(--x))` normally.
 *
 * Exported HTML reports (`rcaHtml.ts`, `app-health-check/styles.ts`) and the
 * raster export in `useCopyElementAsImage.ts` cannot see the app's custom
 * properties, so they keep their own literal hex and must not import `UI`.
 * Where a `UI` token has to cross into one of those — html2canvas's
 * `backgroundColor` option, say — put it through `resolveCssColor` below.
 */

export const CHART_COLORS = {
  cpuAvg: '#c4b5fd',
  cpuMax: '#a78bfa',
  memAvg: '#fdba74',
  memMax: '#f97316',
  avail: '#3fb950',
  // Database. CPU and memory get separate hues for the same reason the app's do
  // (purple vs orange) — two shades of one colour are unreadable once four lines
  // overlap. None of these appear in INSTANCE_PALETTE below, which the per-instance
  // health lines draw from: #2dd4bf and #22d3ee are in it, so the teal is 0d9488.
  dbCpuAvg: '#5eead4',   // teal-300
  dbCpuMax: '#0d9488',   // teal-600
  dbMemAvg: '#a5b4fc',   // indigo-300
  dbMemMax: '#4f46e5',   // indigo-600
};

export const INSTANCE_PALETTE = [
  '#38bdf8', '#f472b6', '#facc15', '#60a5fa', '#22d3ee',
  '#e879f9', '#2dd4bf', '#a3e635', '#93c5fd', '#d946ef',
];

/**
 * Theme-aware chrome and status colours.
 *
 * `textDim` is `textMuted` at reduced alpha rather than a separate token: the
 * original palette carried three tiers of grey (primary / secondary / tertiary)
 * and collapsing them all onto `--muted-foreground` would have flattened that
 * hierarchy.
 */
export const UI = {
  text: 'hsl(var(--foreground))',
  textMuted: 'hsl(var(--muted-foreground))',
  textDim: 'hsl(var(--muted-foreground) / 0.7)',
  border: 'hsl(var(--border))',
  /** Chart tooltips and popovers — matches the themed popover surface. */
  surface: 'hsl(var(--popover))',
  background: 'hsl(var(--background))',
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  error: 'hsl(var(--error))',
  info: 'hsl(var(--info))',
} as const;

/**
 * HTTP response-band series colours for the endpoint performance charts.
 *
 * `ok` is deliberately one shade deeper than `UI.success`: it fills a large area
 * with the 4xx and 5xx bands stacked on top, and at full brightness the base
 * segment competes with the two bands that are actually worth looking at. That
 * trade-off is why this family stays literal instead of using the status tokens.
 */
export const PERF_COLORS = {
  ok: '#2ea043',
  fourXx: '#f97316',
  fiveXx: '#f85149',
  line: '#58a6ff',
} as const;

/** Fallback for an instance index past the end of INSTANCE_PALETTE. */
export const SERIES_FALLBACK = UI.textMuted;

/**
 * Flattens a `UI` token to a literal colour the raster exporters can parse.
 *
 * html2canvas runs its own CSS parser over the `backgroundColor` option string
 * and never resolves `var()`, so `hsl(var(--background))` reaches its hsl parser
 * with a function token where the hue belongs and it throws "Unsupported angle
 * type". A throwaway probe node lets the browser resolve the property first.
 *
 * `fallback` defaults to the live body background — the same literal the raster
 * export would have used had no colour been passed at all.
 */
export const resolveCssColor = (value: string, fallback?: string): string => {
  if (!value.includes('var(')) return value;

  const fallbackColor = () =>
    fallback
    ?? (typeof document !== 'undefined' && document.body
      ? getComputedStyle(document.body).backgroundColor || '#ffffff'
      : '#ffffff');

  if (typeof document === 'undefined' || !document.body) return fallbackColor();

  const probe = document.createElement('span');
  probe.style.cssText = `position:fixed;left:-9999px;top:-9999px;color:${value};`;
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  return resolved && !resolved.includes('var(') ? resolved : fallbackColor();
};
