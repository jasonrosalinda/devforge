import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./azure-metrics.cjs');

const { _getGranularity, _summarize, _groupUrlSeries } = handler;

describe('groupUrlSeries', () => {
  it('groups flat KQL rows into one series per endpoint', () => {
    expect(_groupUrlSeries([
      ['10:00', '/a', 5],
      ['10:00', '/b', 2],
      ['10:05', '/a', 7],
    ])).toEqual([
      { url: '/a', series: [{ t: '10:00', count: 5 }, { t: '10:05', count: 7 }] },
      { url: '/b', series: [{ t: '10:00', count: 2 }] },
    ]);
  });

  it('orders endpoints by total volume so colour-by-index matches the Top list', () => {
    const out = _groupUrlSeries([
      ['10:00', '/small', 1],
      ['10:00', '/big', 50],
      ['10:05', '/mid', 10],
    ]);
    expect(out.map(s => s.url)).toEqual(['/big', '/mid', '/small']);
  });

  it('sorts each series chronologically even when KQL returns rows out of order', () => {
    const [a] = _groupUrlSeries([
      ['2026-07-31T10:05:00Z', '/a', 2],
      ['2026-07-31T10:00:00Z', '/a', 1],
    ]);
    expect(a.series.map(p => p.t)).toEqual(['2026-07-31T10:00:00Z', '2026-07-31T10:05:00Z']);
  });

  it('labels a null endpoint rather than dropping its traffic', () => {
    expect(_groupUrlSeries([['10:00', null, 3]])[0].url).toBe('(unknown)');
  });

  it('coerces non-numeric counts to 0 instead of NaN', () => {
    expect(_groupUrlSeries([['10:00', '/a', null]])[0].series[0].count).toBe(0);
  });

  it('skips malformed rows', () => {
    expect(_groupUrlSeries([null, 'nope', ['10:00', '/a', 1]])).toEqual([
      { url: '/a', series: [{ t: '10:00', count: 1 }] },
    ]);
  });

  it('returns nothing for no rows', () => {
    expect(_groupUrlSeries([])).toEqual([]);
  });
});

describe('getGranularity', () => {
  it('returns PT5M for 1h', () => {
    expect(_getGranularity('1h')).toBe('PT5M');
  });
  it('returns PT15M for 6h', () => {
    expect(_getGranularity('6h')).toBe('PT15M');
  });
  it('returns PT15M for 1d (24h)', () => {
    expect(_getGranularity('1d')).toBe('PT15M');
  });
  it('returns PT1H for 7d', () => {
    expect(_getGranularity('7d')).toBe('PT1H');
  });
  it('defaults to PT1H for unknown range', () => {
    expect(_getGranularity('unknown')).toBe('PT1H');
  });
});

describe('summarize', () => {
  it('returns avg and max from timeseries data', () => {
    const data = [
      { timeStamp: new Date('2024-01-01T00:00Z'), average: 10, maximum: 20 },
      { timeStamp: new Date('2024-01-01T00:05Z'), average: 30, maximum: 40 },
    ];
    const result = _summarize(data);
    expect(result.avg).toBe(20);
    expect(result.max).toBe(40);
    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toEqual({
      t: '2024-01-01T00:00:00.000Z',
      v: 10,
      m: 20,
    });
  });

  it('handles empty data', () => {
    const result = _summarize([]);
    expect(result.avg).toBe(0);
    expect(result.max).toBe(0);
    expect(result.series).toHaveLength(0);
  });

  it('handles null average/maximum gracefully', () => {
    const data = [
      { timeStamp: new Date('2024-01-01T00:00Z'), average: null, maximum: null },
    ];
    const result = _summarize(data);
    expect(result.avg).toBe(0);
    expect(result.max).toBe(0);
  });
});
