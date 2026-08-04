import { describe, it, expect } from 'vitest';
import { perfChartRows, perfTotals, hasPerfData, msColor, depTotals, depChartRows, depKey } from './performance';
import type { EndpointPerfRow } from '@shared/types/azureMetrics.types';

const pt = (over: Partial<{ t: string; count: number; c4: number; c5: number; avgMs: number; p95: number }> = {}) =>
  ({ t: '10:00', count: 0, c4: 0, c5: 0, avgMs: 0, p95: 0, ...over });

const row = (over: Partial<EndpointPerfRow> = {}): EndpointPerfRow =>
  ({ url: '/a', count: 0, rpm: 0, fourXx: 0, fiveXx: 0, avgMs: 0, p95: 0, p99: 0, maxMs: 0, ...over });

describe('perfChartRows', () => {
  it('splits a bucket into ok / 4xx / 5xx segments that sum to the request count', () => {
    const [r] = perfChartRows([pt({ count: 100, c4: 12, c5: 3 })]);
    expect(r).toMatchObject({ ok: 85, c4: 12, c5: 3, count: 100 });
    expect(r!.ok + r!.c4 + r!.c5).toBe(100);
  });

  it('clamps ok at zero when the status counts exceed the row count', () => {
    // A request with no usable result code counts as a 5xx, so the classes can
    // over-sum. A negative segment inverts the recharts stack.
    expect(perfChartRows([pt({ count: 5, c4: 4, c5: 4 })])[0]!.ok).toBe(0);
  });

  it('carries avg and p95 through untouched for the latency lines', () => {
    expect(perfChartRows([pt({ avgMs: 210.5, p95: 1840 })])[0]).toMatchObject({ avgMs: 210.5, p95: 1840 });
  });

  it('preserves bucket order rather than re-sorting', () => {
    const out = perfChartRows([pt({ t: '10:00' }), pt({ t: '10:05' }), pt({ t: '10:10' })]);
    expect(out.map(r => r.t)).toEqual(['10:00', '10:05', '10:10']);
  });

  it('returns nothing for a missing timeline', () => {
    expect(perfChartRows(undefined)).toEqual([]);
  });

  it('keeps an all-error bucket visible as a full-height 5xx bar', () => {
    expect(perfChartRows([pt({ count: 7, c5: 7 })])[0]).toMatchObject({ ok: 0, c5: 7, count: 7 });
  });
});

describe('perfTotals', () => {
  it('sums requests and errors and reports the worst endpoint P95, not an average of them', () => {
    expect(perfTotals([
      row({ url: '/a', count: 100, fourXx: 3, fiveXx: 1, p95: 120,  avgMs: 50,   maxMs: 900 }),
      row({ url: '/b', count: 20,  fourXx: 0, fiveXx: 4, p95: 4200, avgMs: 3000, maxMs: 9100 }),
    ])).toMatchObject({
      endpoints: 2, requests: 120, fourXx: 3, fiveXx: 5,
      worstP95: 4200, slowest: 9100, failing: 2,
    });
  });

  it('weights the average by request count rather than averaging the averages', () => {
    // Naive mean would be 4025ms. The busy endpoint is 40ms and owns 40k of 40.003k
    // requests, so the true weighted figure is barely above it.
    const t = perfTotals([
      row({ count: 40_000, avgMs: 40 }),
      row({ count: 3, avgMs: 8000 }),
    ]);
    expect(Math.round(t.avgMs)).toBe(41);
  });

  it('counts only endpoints with a 5xx as failing', () => {
    expect(perfTotals([
      row({ fiveXx: 0, fourXx: 9 }),
      row({ fiveXx: 2 }),
    ]).failing).toBe(1);
  });

  it('returns zeroes rather than NaN for an empty set', () => {
    expect(perfTotals([])).toEqual({
      endpoints: 0, requests: 0, fourXx: 0, fiveXx: 0,
      worstP95: 0, avgMs: 0, slowest: 0, failing: 0,
    });
  });

  it('does not divide by zero when the set has endpoints but no requests', () => {
    expect(perfTotals([row({ count: 0, avgMs: 500 })]).avgMs).toBe(0);
  });

  it('handles a missing endpoint list', () => {
    expect(perfTotals(undefined).endpoints).toBe(0);
  });
});

describe('hasPerfData', () => {
  const base = { fiveXxCap: 50, fiveXxCapped: false };

  it('is false for null, and for a payload with no endpoints', () => {
    expect(hasPerfData(null)).toBe(false);
    expect(hasPerfData({ ...base, endpoints: [] })).toBe(false);
  });

  it('is true for endpoints alone — timelines arrive separately, per endpoint', () => {
    expect(hasPerfData({ ...base, endpoints: [row()] })).toBe(true);
  });
});

describe('msColor', () => {
  it('crosses to amber at 1s and to red at 5s', () => {
    expect(msColor(999)).toBe('#3fb950');
    expect(msColor(1000)).toBe('#d29922');
    expect(msColor(4999)).toBe('#d29922');
    expect(msColor(5000)).toBe('#f85149');
  });
});

describe('depTotals', () => {
  const dep = (over: Partial<{ target: string; count: number; failCount: number; totalMs: number }>) => ({
    type: 'SQL', target: 'db', name: 'q',
    count: 0, failCount: 0, avgMs: 0, p95: 0, totalMs: 0, ...over,
  });

  it('sums calls, failures and time, and counts distinct targets', () => {
    expect(depTotals([
      dep({ target: 'db',  count: 10, failCount: 1, totalMs: 400 }),
      dep({ target: 'api', count: 5,  failCount: 0, totalMs: 100 }),
      dep({ target: 'db',  count: 2,  failCount: 1, totalMs: 50 }),
    ])).toEqual({ calls: 17, failed: 2, totalMs: 550, targets: 2 });
  });

  it('does not count an empty target as a distinct one', () => {
    expect(depTotals([dep({ target: '' }), dep({ target: '' })]).targets).toBe(0);
  });

  it('returns zeroes for no calls', () => {
    expect(depTotals([])).toEqual({ calls: 0, failed: 0, totalMs: 0, targets: 0 });
  });
});

describe('depChartRows', () => {
  const pt = (over: Partial<{ t: string; count: number; failCount: number; avgMs: number; p95: number }> = {}) =>
    ({ t: '10:00', count: 0, failCount: 0, avgMs: 0, p95: 0, ...over });

  it('splits a bucket into succeeded / failed with no middle class', () => {
    const [r] = depChartRows([pt({ count: 100, failCount: 7 })]);
    expect(r).toMatchObject({ ok: 93, c4: 0, c5: 7, count: 100 });
  });

  it('clamps ok at zero when failures exceed the row count', () => {
    expect(depChartRows([pt({ count: 3, failCount: 5 })])[0]!.ok).toBe(0);
  });

  it('carries the latency pair through for the lines', () => {
    expect(depChartRows([pt({ avgMs: 38, p95: 91 })])[0]).toMatchObject({ avgMs: 38, p95: 91 });
  });

  it('returns nothing for a dependency with no timeline', () => {
    expect(depChartRows(undefined)).toEqual([]);
  });
});

describe('depKey', () => {
  it('distinguishes the same call name on different targets', () => {
    const a = depKey({ type: 'SQL', target: 'db1', name: 'SELECT 1' });
    const b = depKey({ type: 'SQL', target: 'db2', name: 'SELECT 1' });
    expect(a).not.toBe(b);
  });

  it('is stable for the same triple', () => {
    expect(depKey({ type: 'Http', target: 'api', name: 'GET /x' }))
      .toBe(depKey({ type: 'Http', target: 'api', name: 'GET /x' }));
  });
});
