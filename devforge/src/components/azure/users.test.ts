import { describe, it, expect } from 'vitest';
import { userStats, topClientShare, looksAutomated, shortUa, hasUserData, entityChartSeries, plottableKeys } from './users';

import type { TopClient } from '@shared/types/azureMetrics.types';

const pt = (t: string, users: number) => ({ t, users });
const client = (ip: string, count: number): TopClient => ({
  ip, country: 'SG', count, rpm: 1,
  firstSeen: '10:00', lastSeen: '10:10',
  urlCount: 1, fourXx: 0, fiveXx: 0,
  userAgent: 'curl/8.4.0', agents: 1,
});

describe('userStats', () => {
  it('averages across buckets and names the peak bucket', () => {
    const s = userStats([pt('10:00', 10), pt('10:05', 30), pt('10:10', 20)]);
    expect(s).toMatchObject({ avg: 20, max: 30, buckets: 3 });
    expect(s.peak).toEqual(pt('10:05', 30));
  });

  it('uses nearest-rank P99, matching the ARM summarize it replaced', () => {
    // 100 buckets, values 1..100 — ceil(100 * 0.99) - 1 = index 98, the 99th value.
    const s = userStats(Array.from({ length: 100 }, (_, i) => pt(`t${i}`, i + 1)));
    expect(s.p99).toBe(99);
    expect(s.max).toBe(100);
  });

  it('rounds the average to one decimal rather than emitting a long float', () => {
    expect(userStats([pt('a', 1), pt('b', 2)]).avg).toBe(1.5);
    expect(userStats([pt('a', 1), pt('b', 1), pt('c', 2)]).avg).toBe(1.3);
  });

  it('keeps the first of two equal peaks rather than drifting to the later one', () => {
    expect(userStats([pt('10:00', 9), pt('10:05', 9)]).peak).toEqual(pt('10:00', 9));
  });

  it('returns zeroes and no peak for an empty or missing series', () => {
    expect(userStats([])).toEqual({ avg: 0, p99: 0, max: 0, peak: null, buckets: 0 });
    expect(userStats(undefined).peak).toBeNull();
  });

  it('handles a single bucket without a percentile that falls off the array', () => {
    expect(userStats([pt('10:00', 7)])).toMatchObject({ avg: 7, p99: 7, max: 7, buckets: 1 });
  });
});

describe('topClientShare', () => {
  it('reports the busiest client\'s share of the listed traffic', () => {
    expect(topClientShare([client('a', 900), client('b', 100)])).toBe(90);
  });

  it('reads low when traffic is spread across clients', () => {
    expect(topClientShare(Array.from({ length: 10 }, (_, i) => client(`ip${i}`, 100)))).toBe(10);
  });

  it('is null for a single client, where the share is 100% by arithmetic', () => {
    expect(topClientShare([client('a', 50)])).toBeNull();
    expect(topClientShare([])).toBeNull();
    expect(topClientShare(undefined)).toBeNull();
  });

  it('is null rather than NaN when every listed client has zero requests', () => {
    expect(topClientShare([client('a', 0), client('b', 0)])).toBeNull();
  });
});

describe('looksAutomated', () => {
  it('flags crawlers and scripted clients case-insensitively', () => {
    expect(looksAutomated('Googlebot/2.1')).toBe(true);
    expect(looksAutomated('python-requests/2.31')).toBe(true);
    expect(looksAutomated('CURL/8.4.0')).toBe(true);
    expect(looksAutomated('Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/120')).toBe(true);
  });

  it('leaves a real browser alone', () => {
    expect(looksAutomated('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15')).toBe(false);
    expect(looksAutomated('')).toBe(false);
  });
});

describe('shortUa', () => {
  it('leaves a short agent untouched', () => {
    expect(shortUa('curl/8.4.0')).toBe('curl/8.4.0');
  });

  it('truncates to the limit including the ellipsis, keeping the head', () => {
    const out = shortUa('x'.repeat(200), 10);
    expect(out).toBe(`${'x'.repeat(9)}…`);
    expect(out).toHaveLength(10);
  });

  it('labels an empty agent rather than rendering blank', () => {
    expect(shortUa('')).toBe('(unknown)');
  });
});

describe('hasUserData', () => {
  const base = { clientSeries: [], agentSeries: [] };

  it('is true with either a series or a client list', () => {
    expect(hasUserData({ ...base, bin: '5m', series: [pt('a', 1)], topIps: [] })).toBe(true);
    expect(hasUserData({ ...base, bin: null, series: [], topIps: [client('a', 1)] })).toBe(true);
  });

  it('is false for null and for an empty payload', () => {
    expect(hasUserData(null)).toBe(false);
    expect(hasUserData({ ...base, bin: null, series: [], topIps: [] })).toBe(false);
  });
});

describe('entityChartSeries', () => {
  const list = [
    { key: '10.0.0.1', series: [{ t: '10:00', count: 4 }, { t: '10:05', count: 9 }] },
    { key: 'curl/8.4.0', series: [{ t: '10:00', count: 1 }] },
  ];

  it('returns the named entity as single-valued points so the chart draws one line', () => {
    expect(entityChartSeries(list, '10.0.0.1')).toEqual([
      { t: '10:00', v: 4, m: 4 },
      { t: '10:05', v: 9, m: 9 },
    ]);
  });

  it('matches the key exactly rather than by prefix', () => {
    expect(entityChartSeries(list, '10.0.0.')).toEqual([]);
  });

  it('returns nothing for no selection, an unknown key, or a missing list', () => {
    expect(entityChartSeries(list, null)).toEqual([]);
    expect(entityChartSeries(list, 'nope')).toEqual([]);
    expect(entityChartSeries(undefined, '10.0.0.1')).toEqual([]);
  });
});

describe('plottableKeys', () => {
  it('excludes entities whose timeline came back empty', () => {
    const keys = plottableKeys([
      { key: 'a', series: [{ t: '10:00', count: 1 }] },
      { key: 'b', series: [] },
    ]);
    expect(keys.has('a')).toBe(true);
    expect(keys.has('b')).toBe(false);
  });

  it('is empty for a missing list', () => {
    expect(plottableKeys(undefined).size).toBe(0);
  });
});
