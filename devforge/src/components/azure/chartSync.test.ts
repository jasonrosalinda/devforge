import { describe, it, expect } from 'vitest';
import { nearestTick } from './azureMetricChart';

// The Users chart bins on 15 minutes while the metric charts bin on 5, so an
// exact-value sync leaves it out of the hover group entirely.
const ticks = [
  { value: '2026-08-01T06:00:00.000Z', index: 0 },
  { value: '2026-08-01T06:15:00.000Z', index: 1 },
  { value: '2026-08-01T06:30:00.000Z', index: 2 },
];

describe('nearestTick', () => {
  it('matches an exact timestamp', () => {
    expect(nearestTick(ticks, { activeLabel: '2026-08-01T06:15:00.000Z' })).toBe(1);
  });

  it('snaps a bucket this chart does not have to the closest one it does', () => {
    expect(nearestTick(ticks, { activeLabel: '2026-08-01T06:20:00.000Z' })).toBe(1);
    expect(nearestTick(ticks, { activeLabel: '2026-08-01T06:25:00.000Z' })).toBe(2);
  });

  it('clamps to the ends rather than dropping the hover', () => {
    expect(nearestTick(ticks, { activeLabel: '2026-08-01T04:00:00.000Z' })).toBe(0);
    expect(nearestTick(ticks, { activeLabel: '2026-08-01T23:00:00.000Z' })).toBe(2);
  });

  it('uses the tick index, not the array position', () => {
    expect(nearestTick(
      [{ value: '2026-08-01T06:00:00.000Z', index: 7 }],
      { activeLabel: '2026-08-01T06:01:00.000Z' },
    )).toBe(7);
  });

  it('falls back to the source index when the label is not a timestamp', () => {
    expect(nearestTick(ticks, { activeLabel: 'not a date', activeIndex: 2 })).toBe(2);
    expect(nearestTick(ticks, { activeLabel: undefined })).toBe(-1);
  });

  it('ignores ticks whose value is unparseable', () => {
    expect(nearestTick(
      [{ value: 'nonsense', index: 0 }, { value: '2026-08-01T06:00:00.000Z', index: 1 }],
      { activeLabel: '2026-08-01T06:00:00.000Z' },
    )).toBe(1);
  });
});

describe('nearestTick fast path', () => {
  it('returns the exact tick without scanning when the label matches one', () => {
    // The common case inside one card: charts sharing a bin have the same tick values.
    expect(nearestTick(ticks, { activeLabel: '2026-08-01T06:15:00.000Z' })).toBe(1);
  });

  it('gives the same answer on a repeat call, so caching cannot skew it', () => {
    const first = nearestTick(ticks, { activeLabel: '2026-08-01T06:07:00.000Z' });
    const again = nearestTick(ticks, { activeLabel: '2026-08-01T06:07:00.000Z' });
    expect(again).toBe(first);
  });

  it('still resolves a label that parses but matches no tick exactly', () => {
    expect(nearestTick(ticks, { activeLabel: '2026-08-01T06:14:00.000Z' })).toBe(1);
  });

  it('skips unparseable ticks rather than letting NaN win the comparison', () => {
    const mixed = [{ value: 'not-a-date', index: 0 }, ...ticks.map(t => ({ ...t, index: t.index + 1 }))];
    expect(nearestTick(mixed, { activeLabel: '2026-08-01T06:15:00.000Z' })).toBe(2);
  });

  it('falls back to the active index when the label is unparseable', () => {
    expect(nearestTick(ticks, { activeLabel: 'nonsense', activeIndex: 3 })).toBe(3);
  });
});
