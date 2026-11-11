import { describe, it, expect } from 'vitest';
import { workerChanges, workerCounts } from './workerCount';

const at = (m: number) => new Date(Date.parse('2026-11-10T09:00:00Z') + m * 300000).toISOString();
const stamps = [0, 1, 2, 3, 4].map(at);
// wk_c stops serving after the second bucket (a scale-in), and nothing serves in the last one.
const inst = (name: string, buckets: number[]) => ({ name, series: buckets.map(b => ({ t: at(b).replace('.000Z', 'Z'), v: 100 })) });

describe('workerCounts', () => {
  it('counts the workers that served each bucket, 0 where none did, on the CPU chart\'s stamps', () => {
    const rows = workerCounts(stamps, [inst('wk_a', [0, 1, 2, 3]), inst('wk_b', [0, 1, 2, 3]), inst('wk_c', [0, 1])], [inst('wk_a', [0, 1, 2, 3, 4])]);
    expect(rows.map(r => [r.fe, r.api])).toEqual([[3, 1], [3, 1], [2, 1], [2, 1], [0, 1]]);
  });

  it('is null for a site with no per-worker data, so the chart draws no line for it', () => {
    expect(workerCounts(stamps, null, undefined).every(r => r.fe === null && r.api === null)).toBe(true);
  });
});

describe('workerChanges', () => {
  it('lists each step in the frontend count', () => {
    const rows = workerCounts(stamps, [inst('wk_a', [0, 1, 2, 3]), inst('wk_c', [0, 1])]);
    expect(workerChanges(rows)).toEqual([{ t: at(2), from: 2, to: 1 }, { t: at(4), from: 1, to: 0 }]);
  });
});
