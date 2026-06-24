import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./azure-metrics.cjs');

const { _getGranularity, _summarize } = handler;

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
