import { describe, it, expect } from 'vitest';
import { splitSeriesName, groupByInstance, isoDurationToMs, grainLabel, grainMismatch } from './snatPortSection';

const pts = (...counts: number[]) => counts.map((count, i) => ({ t: `10:0${i}`, count }));

describe('splitSeriesName', () => {
  it('reads worker(counter) — the port usage chart', () => {
    expect(splitSeriesName('wn0sdwk000K9C(TCP_Allocated)')).toEqual({ instance: 'wn0sdwk000K9C', counter: 'TCP_Allocated' });
  });

  it('reads counter(worker) — the pending and new-connection charts', () => {
    expect(splitSeriesName('Pending(wn0sdwk000K9R)')).toEqual({ instance: 'wn0sdwk000K9R', counter: 'Pending' });
    expect(splitSeriesName('Successful(wn0sdwk000KFZ)')).toEqual({ instance: 'wn0sdwk000KFZ', counter: 'Successful' });
  });

  it('leaves an unbracketed label alone', () => {
    expect(splitSeriesName('Count')).toEqual({ instance: 'Count', counter: '' });
  });
});

describe('groupByInstance', () => {
  it('puts a worker\'s counters on one row, used before allocated', () => {
    const out = groupByInstance([
      { name: 'wn0K9C(TCP_Allocated)', series: pts(120, 128) },
      { name: 'wn0K9R(TCP_Allocated)', series: pts(256) },
      { name: 'wn0K9C(Tcp_Used)', series: pts(12, 9) },
    ]);
    expect(out.map(g => g.instance)).toEqual(['wn0K9C', 'wn0K9R']);
    expect(out[0]!.counters.map(c => [c.counter, c.peak])).toEqual([['Tcp_Used', 12], ['TCP_Allocated', 128]]);
    expect(out[1]!.counters.map(c => [c.counter, c.peak])).toEqual([['TCP_Allocated', 256]]);
  });

  it('keeps the full series name so the legend can still colour-match the line', () => {
    const [group] = groupByInstance([{ name: 'Pending(wn0K9R)', series: pts(1) }]);
    expect(group!.counters[0]!.name).toBe('Pending(wn0K9R)');
    expect(group!.instance).toBe('wn0K9R');
  });

  it('falls back to the whole label when there is no counter to split off', () => {
    const [group] = groupByInstance([{ name: 'Count', series: pts(0) }]);
    expect(group!.counters[0]!.counter).toBe('Count');
  });
});

describe('grain reporting', () => {
  it('parses ISO durations the dashboard uses', () => {
    expect(isoDurationToMs('PT1M')).toBe(60_000);
    expect(isoDurationToMs('PT15M')).toBe(900_000);
    expect(isoDurationToMs('PT1H')).toBe(3_600_000);
    expect(isoDurationToMs('P1D')).toBeNull();
    expect(isoDurationToMs(null)).toBeNull();
  });

  it('labels a grain the way the interval buttons do', () => {
    expect(grainLabel(60_000)).toBe('1m');
    expect(grainLabel(300_000)).toBe('5m');
    expect(grainLabel(3_600_000)).toBe('1h');
    expect(grainLabel(null)).toBeNull();
  });

  it('reports a detector that served coarser buckets than asked for', () => {
    expect(grainMismatch('PT1M', 300_000)).toEqual({ requested: '1m', actual: '5m' });
  });

  it('stays quiet when the grain was honoured, allowing for bin jitter', () => {
    expect(grainMismatch('PT5M', 300_000)).toBeNull();
    expect(grainMismatch('PT5M', 300_500)).toBeNull();
  });

  it('stays quiet when either side is unknown', () => {
    expect(grainMismatch(null, 300_000)).toBeNull();
    expect(grainMismatch('PT1M', null)).toBeNull();
  });
});
