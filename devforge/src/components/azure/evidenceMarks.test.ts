import { describe, it, expect } from 'vitest';
import { evidenceMarks } from './releaseMarkers';

const stamps = Array.from({ length: 12 }, (_, i) => new Date(Date.parse('2026-11-10T12:00:00Z') + i * 60000).toISOString());

describe('evidenceMarks', () => {
  it('snaps each numbered moment to its bucket and keeps a range when it spans buckets', () => {
    expect(evidenceMarks([
      { n: 1, atMs: Date.parse('2026-11-10T12:02:30Z'), endMs: Date.parse('2026-11-10T12:05:10Z'), label: 'burst' },
      { n: 2, atMs: Date.parse('2026-11-10T12:07:00Z'), endMs: Date.parse('2026-11-10T12:07:40Z'), label: 'same bucket' },
    ], stamps)).toEqual([
      { n: 1, x: stamps[2], x2: stamps[5], label: 'burst' },
      { n: 2, x: stamps[7], x2: null, label: 'same bucket' },
    ]);
  });

  it('drops a moment outside the chart, and draws nothing without markers', () => {
    expect(evidenceMarks([{ n: 1, atMs: Date.parse('2026-11-10T13:30:00Z'), label: 'later' }], stamps)).toEqual([]);
    expect(evidenceMarks(undefined, stamps)).toEqual([]);
  });
});
