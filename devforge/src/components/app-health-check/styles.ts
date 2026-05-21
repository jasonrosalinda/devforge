// Shared constants + helpers for the App Health Check page.

export const C = {
  bg:         '#07090f',
  surface:    '#0d1117',
  border:     '#21262d',
  text:       '#e6edf3',
  textSub:    '#8b9ab3',
  textMuted:  '#484f58',
  accent:     '#58a6ff',
  green:      '#3fb950',
  yellow:     '#d29922',
  red:        '#f85149',
  btnBg:      '#21262d',
  btnActive:  '#1f6feb',
} as const;

export const INGESTION_DELAY_MS = 5 * 60 * 1000;

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

export function maxEndDt(): string {
  return toDatetimeLocal(new Date(Date.now() - INGESTION_DELAY_MS));
}

export const inputStyle: React.CSSProperties = {
  padding: '4px 8px',
  borderRadius: 6,
  border: `1px solid ${C.border}`,
  background: C.btnBg,
  color: C.text,
  fontSize: 12,
  colorScheme: 'dark',
};
