import { describe, it, expect } from 'vitest';
import { breakdownTarget, buildRemarks, collectRemarks, formatStatusBreakdown, nowRemarkItems, nowRemarkText, type MetricRemark } from './appRemarks';
import type { AppMetrics } from '@shared/types/azureMetrics.types';

const STEP_MS = 15 * 60 * 1000;
const T0 = new Date('2026-08-12T00:00:00Z').getTime();
const ts = (i: number) => new Date(T0 + i * STEP_MS).toISOString();

/** n buckets, 15m apart, all healthy except one bad reading at `badIndex`. */
function cpuSeries(n: number, badIndex: number | null) {
  return {
    avg: 0, max: 0, p99: 0,
    series: Array.from({ length: n }, (_, i) => ({ t: ts(i), v: 10, m: badIndex === i ? 90 : 10 })),
  };
}

const metricsWithCpu = (n: number, badIndex: number | null) =>
  ({ cpu: cpuSeries(n, badIndex), memory: cpuSeries(n, null) } as unknown as AppMetrics);

describe('buildRemarks — scoped to the trailing interval only', () => {
  it('reads as active when the bad reading is in the last bucket before rangeEnd', () => {
    const n = 5;
    const metrics = metricsWithCpu(n, n - 1); // bad at the very last bucket
    const { text, severity } = buildRemarks(metrics, ts(0), ts(n - 1));
    expect(severity).toBe('critical');
    expect(text).toMatch(/^Active issues: CPU spike/);
  });

  it('ignores a bad reading older than the trailing interval — reads as clean, not "recovered since"', () => {
    // Root cause of the reported bug: a spike at 12:04 AM inside a 12:00-12:59 AM
    // range with a 5m interval used to surface as "No CPU spike since ... 12:04
    // AM" — referencing history outside the interval the remark is meant to be
    // about. Scoped to the trailing window, that reading is never looked at, so
    // it reads as clean instead of name-dropping a stale timestamp.
    const n = 5;
    const metrics = metricsWithCpu(n, n - 3); // bad two buckets (30m) before the end, outside the 15m window
    const { text, severity } = buildRemarks(metrics, ts(0), ts(n - 1));
    expect(severity).toBe('ok');
    expect(text).toContain('CPU spike');
    expect(text).not.toContain('since');
    expect(text).not.toMatch(/^Active issues/);
  });

  it('matches the exact example: 11:50 PM end, 15m interval, bad at 11:50 PM is active', () => {
    const end = new Date('2026-08-12T23:50:00Z');
    const series = [-2, -1, 0].map(stepsFromEnd => ({
      t: new Date(end.getTime() + stepsFromEnd * STEP_MS).toISOString(),
      v: 10,
      m: stepsFromEnd === 0 ? 90 : 10,
    }));
    const metrics = { cpu: { avg: 0, max: 0, p99: 0, series }, memory: cpuSeries(3, null) } as unknown as AppMetrics;
    const { severity } = buildRemarks(metrics, series[0]!.t, end.toISOString());
    expect(severity).toBe('critical');
  });

  it('a bad reading one bucket before 11:50 PM (i.e. at 11:35 PM) is still active — inside the trailing interval', () => {
    const end = new Date('2026-08-12T23:50:00Z');
    const series = [-1, 0].map(stepsFromEnd => ({
      t: new Date(end.getTime() + stepsFromEnd * STEP_MS).toISOString(),
      v: 10,
      m: stepsFromEnd === -1 ? 90 : 10, // bad at 11:35 PM, healthy at 11:50 PM
    }));
    const metrics = { cpu: { avg: 0, max: 0, p99: 0, series }, memory: cpuSeries(2, null) } as unknown as AppMetrics;
    const { severity } = buildRemarks(metrics, series[0]!.t, end.toISOString());
    expect(severity).toBe('critical');
  });

  it('reports ok with CPU spike among the clean kinds when nothing ever crossed the threshold', () => {
    const metrics = metricsWithCpu(5, null);
    const { text, severity } = buildRemarks(metrics, ts(0), ts(4));
    expect(severity).toBe('ok');
    expect(text).toContain('CPU spike');
    expect(text).toMatch(/^No .*detected in this window\.$/);
  });
});

describe('buildRemarks — 5xx/4xx rate across mismatched series grains', () => {
  it('sums a finer-grained error series into its containing requests bucket instead of an exact-timestamp coincidence', () => {
    // failedRequestsSeries is fetched at a fixed 1-minute KQL bin regardless of
    // the selected range's granularity, while requestsSeries uses the range's
    // real bucket width — so on a 15m view, three 1-minute 5xx points (2 each)
    // land inside ONE 15-minute requests bucket [bucketStart, bucketStart+15m).
    // An exact-t join would only see whichever single point happens to share
    // the bucket's exact start timestamp (2/100 = 2%, under the 5% threshold);
    // bucket-summing correctly reads 6/100 = 6%, matching what actually
    // happened across that whole bucket.
    const oneMin = 60 * 1000;
    const bucketStartMs = new Date(ts(1)).getTime();
    const bucketStart = new Date(bucketStartMs).toISOString();
    // rangeEnd sits inside the bucket (14 of its 15 minutes in), so the trailing
    // 15m window comfortably covers the bucket's start and all three 1m points.
    const rangeEnd = new Date(bucketStartMs + 14 * oneMin).toISOString();
    const metrics = {
      cpu: cpuSeries(2, null),
      memory: cpuSeries(2, null),
      requestsSeries: [{ t: bucketStart, count: 100 }],
      failedRequestsSeries: [
        { t: new Date(bucketStartMs).toISOString(), count: 2 },
        { t: new Date(bucketStartMs + oneMin).toISOString(), count: 2 },
        { t: new Date(bucketStartMs + 2 * oneMin).toISOString(), count: 2 },
      ],
    } as unknown as AppMetrics;

    const { text, severity } = buildRemarks(metrics, ts(0), rangeEnd);
    expect(severity).toBe('critical');
    // ts(1) is 00:15 UTC = 08:15 SGT, the bucket the 6% sits in.
    expect(text).toContain('5xx errors (peak 6.0% at 08:15)');
  });
});

describe('collectRemarks — 4xx peak time and window', () => {
  // 15m buckets; the range ends 5 min into the last one, so only that bucket is examined.
  const metrics = (fourXx: number[]) => ({
    cpu: cpuSeries(3, null),
    memory: cpuSeries(3, null),
    requestsSeries: [0, 1, 2].map(i => ({ t: ts(i), count: 100 })),
    http4xxSeries: fourXx.map((count, i) => ({ t: ts(i), count })),
  } as unknown as AppMetrics);
  const fourXx = (m: AppMetrics, end: string) => collectRemarks(m, end).find(r => r.kind === '4xx surge')!;

  it('names the peak bucket in SGT and carries it as the window to ask App Insights about', () => {
    const end = new Date(new Date(ts(2)).getTime() + 5 * 60 * 1000).toISOString();
    const r = fourXx(metrics([0, 0, 9]), end);
    expect(r.severity).toBe('critical');
    expect(r.display).toBe('4xx surge (peak 9.0% at 08:30)');
    expect(r.peakWindow).toEqual({ startIso: ts(2), endIso: ts(3) });
    expect(breakdownTarget(r)).toEqual({ key: `4xx|${ts(2)}|${ts(3)}`, cls: '4xx', startIso: ts(2), endIso: ts(3) });
  });

  it('has no peak window when there is no rate at all', () => {
    const r = fourXx({ cpu: cpuSeries(3, null), memory: cpuSeries(3, null) } as unknown as AppMetrics, ts(2));
    expect(r.display).toBeUndefined();
    expect(r.peakWindow).toBeUndefined();
    expect(breakdownTarget(r)).toBeNull();
  });
});

describe('formatStatusBreakdown', () => {
  const row = (code: string, endpoint: string, count: number, bots = 0, role = 'medu-fe') => ({ code, endpoint, role, count, bots });

  it('lists each code and endpoint, busiest first, at most five, with its bot share', () => {
    expect(formatStatusBreakdown([
      row('404', 'GET /a', 50), row('401', 'POST /login', 30, 3), row('404', 'GET /b', 70, 70),
      row('429', 'GET /c', 5), row('400', 'POST /d', 2), row('403', 'GET /e', 1),
    ])).toEqual([
      '404 × 70 on GET /b (100% bot)',
      '404 × 50 on GET /a (0% bot)',
      '401 × 30 on POST /login (10% bot)',
      '429 × 5 on GET /c (0% bot)',
      '400 × 2 on POST /d (0% bot)',
    ]);
  });

  it('says <1% rather than 0% when a few bots are in a big count', () => {
    expect(formatStatusBreakdown([row('404', 'GET /a', 1000, 2)])).toEqual(['404 × 1,000 on GET /a (<1% bot)']);
  });

  it('names the role only when the rows span more than one', () => {
    expect(formatStatusBreakdown([row('404', 'GET /a', 3, 0, 'medu-fe'), row('401', 'GET /api/x', 2, 2, 'medu-api')]))
      .toEqual(['404 × 3 on GET /a [medu-fe] (0% bot)', '401 × 2 on GET /api/x [medu-api] (100% bot)']);
  });

  it('says plainly when App Insights saw none of them', () => {
    expect(formatStatusBreakdown([])).toEqual(['no matching requests in App Insights for that bucket']);
  });
});

describe('nowRemarkText and nowRemarkItems', () => {
  const surge: MetricRemark = {
    kind: '4xx surge', display: '4xx surge (peak 5.3% at 14:30)', lastBadAt: ts(1), severity: 'critical',
    peakWindow: { startIso: ts(1), endIso: ts(2) },
  };

  it('prefixes the site when the app has an API', () => {
    expect(nowRemarkText(surge, true)).toBe('FE 4xx surge (peak 5.3% at 14:30)');
    expect(nowRemarkText(surge, false)).toBe('4xx surge (peak 5.3% at 14:30)');
  });

  it('lists the breakdown once it is in, nothing before', () => {
    expect(nowRemarkItems(surge, {})).toEqual([]);
    expect(nowRemarkItems(surge, { [`4xx|${ts(1)}|${ts(2)}`]: ['404 × 120 on GET /b (100% bot)'] }))
      .toEqual(['404 × 120 on GET /b (100% bot)']);
  });

  it('leaves non-HTTP remarks as they are', () => {
    const cpu: MetricRemark = { kind: 'CPU spike', display: 'CPU spike (1 spike)', lastBadAt: ts(1), severity: 'critical' };
    expect(nowRemarkText(cpu, true)).toBe('CPU spike (1 spike)');
    expect(nowRemarkItems(cpu, {})).toEqual([]);
  });
});
