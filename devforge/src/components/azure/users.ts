import type { UserInsights, EntitySeries } from '@shared/types/azureMetrics.types';

export const USERS_COLOR = '#a371f7';

/** A user agent long enough to be worth ranking but not worth reading whole. */
export const UA_TRUNCATE = 90;

/**
 * Avg / P95 / Max across buckets — deliberately not across requests.
 *
 * Each bucket already holds one distinct-client count, so there is nothing to average
 * within one. The figures therefore describe the shape of the line: avg is the typical
 * bucket, max is the busiest, and P95 is the busiest sustained stretch. Not P99: a
 * nearest-rank P99 over fewer than 100 buckets is always the max, and a day at 15-minute
 * buckets is under 100, so it only ever repeated the Peak cell. P95 separates from the
 * max from 20 buckets up.
 */
export function userStats(series: UserInsights['series'] | undefined) {
  const pts = series ?? [];
  if (!pts.length) return { avg: 0, p95: 0, max: 0, peak: null, current: null, buckets: 0 };

  const values = pts.map(p => p.users);
  const sorted = [...values].sort((a, b) => a - b);
  const peak = pts.reduce((best, p) => (p.users > best.users ? p : best), pts[0]!);

  return {
    avg: Math.round(values.reduce((s, v) => s + v, 0) / values.length * 10) / 10,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
    max: Math.max(...values),
    peak,
    // The latest bucket, not the latest reading of the day: telemetry lags a few
    // minutes, so on a range ending now this bucket can still be filling in.
    current: pts[pts.length - 1]!,
    buckets: pts.length,
  };
}

/**
 * Share of the top clients' traffic held by the single busiest one.
 *
 * The tell for a scraper: real traffic spread across ten clients sits near 10-20%, and
 * one address holding most of it is one machine, not an audience. Returns null below
 * two clients, where a share is 100% by arithmetic and says nothing.
 */
export function topClientShare(topIps: UserInsights['topIps'] | undefined): number | null {
  const rows = topIps ?? [];
  if (rows.length < 2) return null;
  const total = rows.reduce((s, r) => s + r.count, 0);
  if (total <= 0) return null;
  return Math.round((rows[0]!.count / total) * 1000) / 10;
}

/** Bot-ish user agents, by the same needles the KQL bot query matches on. */
const BOT_NEEDLES = [
  'bot', 'crawl', 'spider', 'facebookexternalhit', 'scrapy', 'python-requests',
  'go-http', 'curl', 'wget', 'headlesschrome', 'phantomjs',
];

export function looksAutomated(userAgent: string): boolean {
  const ua = userAgent.toLowerCase();
  return BOT_NEEDLES.some(n => ua.includes(n));
}

/** Shortened for display, keeping the head where the product name lives. */
export function shortUa(userAgent: string, limit = UA_TRUNCATE): string {
  if (!userAgent) return '(unknown)';
  return userAgent.length <= limit ? userAgent : `${userAgent.slice(0, limit - 1)}…`;
}

/** True once there is anything to show — either the line or the client list. */
export function hasUserData(u: UserInsights | null | undefined): boolean {
  return (u?.series?.length ?? 0) > 0 || (u?.topIps?.length ?? 0) > 0;
}

/**
 * One entity's timeline, in the {t, v, m} shape SeriesChart takes.
 *
 * v and m are set to the same count deliberately: SeriesChart collapses a single-valued
 * series to one line, and these buckets hold a count rather than an avg/max pair.
 */
export function entityChartSeries(
  list: EntitySeries[] | undefined,
  key: string | null,
): Array<{ t: string; v: number; m: number }> {
  if (!key) return [];
  const found = (list ?? []).find(e => e.key === key);
  return (found?.series ?? []).map(p => ({ t: p.t, v: p.count, m: p.count }));
}

/** The keys that actually have a timeline — the rows worth making clickable. */
export function plottableKeys(list: EntitySeries[] | undefined): Set<string> {
  return new Set((list ?? []).filter(e => e.series.length > 0).map(e => e.key));
}
