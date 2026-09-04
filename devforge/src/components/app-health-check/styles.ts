// Shared constants + helpers for the App Health Check page.

import { UI } from '@/lib/chart-colors';

/**
 * Page palette. Was a fixed GitHub-dark ramp, which left this page as a dark
 * island once the rest of the app became theme-aware — a black legend panel on a
 * white page in light mode. Now an alias layer over the shared semantic tokens,
 * so the names stay put for the five files that use them.
 */
export const C = {
  bg:          UI.background,
  surface:     'hsl(var(--card))',
  border:      UI.border,
  text:        UI.text,
  textSub:     UI.textMuted,
  textMuted:   UI.textDim,
  accent:      UI.info,
  green:       UI.success,
  yellow:      UI.warning,
  red:         UI.error,
  btnBg:       'hsl(var(--muted))',
  btnActive:   UI.info,
  warnBg:      'hsl(var(--warning) / 0.1)',
  warnBorder:  'hsl(var(--warning) / 0.35)',
  errorBg:     'hsl(var(--error) / 0.1)',
  errorBorder: 'hsl(var(--error) / 0.3)',
} as const;

export const GRANULARITIES: { label: string; value: string; maxSpanHours: number }[] = [
  { label: '1m',  value: 'PT1M',  maxSpanHours: 24 },
  { label: '5m',  value: 'PT5M',  maxSpanHours: 120 },
  { label: '15m', value: 'PT15M', maxSpanHours: 360 },
  { label: '1h',  value: 'PT1H',  maxSpanHours: 1440 },
  { label: '6h',  value: 'PT6H',  maxSpanHours: Infinity },
];

export function todayMidnight(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Current local time, for the "now" button and the default end of the range.
 *
 * The picker used to be clamped five minutes back for App Insights ingestion lag.
 * That silently refused the most recent window during an incident — exactly when
 * it is wanted — so the range is unrestricted and a thin last bucket is simply
 * what a very recent end looks like.
 */
export function nowDt(): string {
  return toDatetimeLocal(new Date());
}

export const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: `1px solid ${C.border}`,
  background: C.btnBg,
  color: C.text,
  fontSize: 12,
  // 'light dark' lets the native date picker follow the active theme; it was
  // pinned to 'dark', which rendered a dark picker on the light background.
  colorScheme: 'light dark',
};
