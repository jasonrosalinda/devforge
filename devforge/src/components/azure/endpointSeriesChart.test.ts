import { describe, it, expect } from 'vitest';
import { mergeUrlSeries } from './azureMetricChart';

describe('mergeUrlSeries', () => {
  it('aligns endpoints on timestamps, not on position', () => {
    // /b starts one bucket late. Merging by index would put its 5 at 10:00 —
    // exactly the misattribution this function exists to prevent.
    const { rows, stamps } = mergeUrlSeries([
      { url: '/a', series: [{ t: '10:00', count: 1 }, { t: '10:05', count: 2 }] },
      { url: '/b', series: [{ t: '10:05', count: 5 }] },
    ]);
    expect(stamps).toEqual(['10:00', '10:05']);
    expect(rows).toEqual([
      { t: '10:00', u0: 1 },
      { t: '10:05', u0: 2, u1: 5 },
    ]);
  });

  it('leaves silent buckets undefined rather than zero', () => {
    // A gap means "reported nothing", not "served zero requests" — the line has to
    // break there instead of dropping to the axis.
    const { rows } = mergeUrlSeries([
      { url: '/a', series: [{ t: '10:00', count: 4 }, { t: '10:10', count: 4 }] },
      { url: '/b', series: [{ t: '10:05', count: 9 }] },
    ]);
    expect(rows[0]).not.toHaveProperty('u1');
    expect(rows[1]).not.toHaveProperty('u0');
    expect(rows[2]).not.toHaveProperty('u1');
  });

  it('sorts timestamps chronologically regardless of input order', () => {
    const { stamps } = mergeUrlSeries([
      { url: '/a', series: [{ t: '2026-07-31T10:10:00Z', count: 1 }] },
      { url: '/b', series: [{ t: '2026-07-31T09:00:00Z', count: 1 }] },
    ]);
    expect(stamps).toEqual(['2026-07-31T09:00:00Z', '2026-07-31T10:10:00Z']);
  });

  it('handles a single endpoint', () => {
    const { rows } = mergeUrlSeries([{ url: '/a', series: [{ t: '10:00', count: 7 }] }]);
    expect(rows).toEqual([{ t: '10:00', u0: 7 }]);
  });

  it('returns nothing for no endpoints', () => {
    expect(mergeUrlSeries([])).toEqual({ rows: [], stamps: [] });
  });
});
