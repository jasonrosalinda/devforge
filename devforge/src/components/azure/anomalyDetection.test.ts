import { describe, it, expect } from 'vitest';
import {
  linefit, robustAnomalyFlags, detectCorrelatedAnomalies, groupAnomalyEpisodes, buildAnomalyRemark,
} from './anomalyDetection';
import type { CorrelatedAnomalyRow, NamedMetricInput } from './anomalyDetection';
import type { AppMetrics, MetricSeries } from '@shared/types/azureMetrics.types';

const T0 = new Date('2026-08-12T00:00:00Z').getTime();
const STEP_MS = 5 * 60 * 1000;
const ts = (i: number) => new Date(T0 + i * STEP_MS).toISOString();

const series = (values: number[]): MetricSeries => ({
  avg: 0, max: 0, p99: 0,
  series: values.map((v, i) => ({ t: ts(i), v, m: v })),
});

/** n flat points at `base`, with one point swapped for `spikeValue` at `spikeIndex`. */
const flatWithSpike = (n: number, base: number, spikeIndex: number, spikeValue: number): number[] =>
  Array.from({ length: n }, (_, i) => (i === spikeIndex ? spikeValue : base));

const flat = (n: number, base: number): number[] => flatWithSpike(n, base, -1, base);

describe('linefit', () => {
  it('fits an exact line through a perfectly linear series', () => {
    const { slope, intercept, baseline } = linefit([1, 2, 3, 4, 5]);
    expect(slope).toBeCloseTo(1);
    expect(intercept).toBeCloseTo(1);
    expect(baseline).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('robustAnomalyFlags', () => {
  it('flags nothing on a perfectly flat series, and never produces NaN/Infinity', () => {
    const { flags, scores } = robustAnomalyFlags(flat(20, 50), 2.5);
    expect(flags.every(f => f === 0)).toBe(true);
    expect(scores.every(s => Number.isFinite(s))).toBe(true);
  });

  it('flags an isolated upward spike as +1 at that index only', () => {
    const spikeIndex = 10;
    const { flags } = robustAnomalyFlags(flatWithSpike(20, 50, spikeIndex, 500), 2.5);
    expect(flags[spikeIndex]).toBe(1);
    expect(flags.filter(f => f !== 0)).toEqual([1]);
  });

  it('flags an isolated dip as -1', () => {
    const dipIndex = 10;
    const { flags } = robustAnomalyFlags(flatWithSpike(20, 50, dipIndex, -400), 2.5);
    expect(flags[dipIndex]).toBe(-1);
  });

  it('skips detection below the minimum sample size instead of over-fitting noise', () => {
    const { flags, scores } = robustAnomalyFlags(flatWithSpike(5, 50, 2, 500), 2.5);
    expect(flags.every(f => f === 0)).toBe(true);
    expect(scores.every(s => s === 0)).toBe(true);
  });
});

describe('detectCorrelatedAnomalies', () => {
  const spikeIndex = 10;
  const extra = (name: string, values: number[], sensitivity = 2.5): NamedMetricInput => ({
    name, sensitivity,
    series: values.map((v, i) => ({ t: ts(i), v, m: v })),
  });

  it('reports Warning, not Critical, for 3 of 4 pressure signals with no 5xx involved', () => {
    // The pure-pressure fallback needs ALL 4 signals (signals_firing >= 4) to
    // reach Critical on its own now that 5xx has its own, more aggressive
    // escalation path — 3 corroborating signals is meaningful but no longer
    // enough by itself.
    const cpu = series(flatWithSpike(20, 50, spikeIndex, 500));
    const extras = [
      extra('Memory', flatWithSpike(20, 60, spikeIndex, 500)),
      extra('DB CPU', flatWithSpike(20, 40, spikeIndex, 500)),
    ];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ t: ts(spikeIndex), severity: 'Warning', signalsFiring: 3 });
  });

  it('reports Critical when all four pressure signals spike together', () => {
    const cpu = series(flatWithSpike(20, 50, spikeIndex, 500));
    const extras = [
      extra('Memory', flatWithSpike(20, 60, spikeIndex, 500)),
      extra('DB CPU', flatWithSpike(20, 40, spikeIndex, 500)),
      extra('DB Memory', flatWithSpike(20, 45, spikeIndex, 500)),
    ];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ t: ts(spikeIndex), severity: 'Critical', signalsFiring: 4 });
  });

  it('reports Info for a CPU-only spike — "probably a batch job, not an incident"', () => {
    const cpu = series(flatWithSpike(20, 50, spikeIndex, 500));
    const extras = [extra('Memory', flat(20, 60))];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'Info', signalsFiring: 1 });
  });

  it('drops a memory-only spike entirely (Normal, not reported)', () => {
    const cpu = series(flat(20, 50));
    const extras = [extra('Memory', flatWithSpike(20, 60, spikeIndex, 600))];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(0);
  });

  it('caps at Warning (never Critical) for a DB-less app with CPU+Memory correlated', () => {
    const cpu = series(flatWithSpike(20, 50, spikeIndex, 500));
    const extras = [extra('Memory', flatWithSpike(20, 60, spikeIndex, 500))];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'Warning', signalsFiring: 2 });
  });

  it('never throws with no extras configured, and returns [] for short series', () => {
    const cpu = series(flatWithSpike(5, 50, 2, 500));
    expect(() => detectCorrelatedAnomalies(cpu, [])).not.toThrow();
    expect(detectCorrelatedAnomalies(cpu, [])).toEqual([]);
  });

  it('reaches Critical from CPU + FE 5xx alone, with no DB or API tier configured', () => {
    // 5xx always escalates: one surface erroring (FE 5xx) alongside CPU
    // pressure is Critical outright, via the surface-aware rule rather than the
    // plain pressure count — `signalsFiring` only tallies CPU here (1) since
    // 4xx/5xx are deliberately excluded from that count.
    const cpu = series(flatWithSpike(20, 50, spikeIndex, 500));
    const extras = [
      extra('FE 4xx', flatWithSpike(20, 2, spikeIndex, 40), 3.0),
      extra('FE 5xx', flatWithSpike(20, 0.5, spikeIndex, 30), 3.0),
    ];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'Critical', signalsFiring: 1 });
    expect(rows[0]!.metrics['FE 4xx']?.flag).toBe(1);
    expect(rows[0]!.metrics['FE 5xx']?.flag).toBe(1);
    expect(rows[0]!.incidentType).toMatch(/Frontend errors under CPU pressure/);
  });

  it('escalates to Critical when both FE and API 5xx fire together, even with no CPU/DB pressure', () => {
    const cpu = series(flat(20, 50));
    const extras = [
      extra('FE 5xx', flatWithSpike(20, 0.5, spikeIndex, 30), 3.0),
      extra('API 5xx', flatWithSpike(20, 0.5, spikeIndex, 30), 3.0),
    ];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'Critical', signalsFiring: 0 });
    expect(rows[0]!.incidentType).toMatch(/Both surfaces erroring/);
  });

  it('reports Warning (not Critical) for a lone 5xx surge with no corroborating pressure', () => {
    const cpu = series(flat(20, 50));
    const extras = [extra('FE 5xx', flatWithSpike(20, 0.5, spikeIndex, 30), 3.0)];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ severity: 'Warning' });
  });

  it('4xx never drives severity on its own, only the incident-type hint', () => {
    const cpu = series(flat(20, 50));
    const extras = [extra('FE 4xx', flatWithSpike(20, 2, spikeIndex, 40), 3.0)];
    const rows = detectCorrelatedAnomalies(cpu, extras);
    expect(rows).toHaveLength(0);
  });
});

describe('groupAnomalyEpisodes', () => {
  const row = (over: Partial<CorrelatedAnomalyRow> = {}): CorrelatedAnomalyRow => ({
    t: ts(0), severity: 'Critical', signalsFiring: 3, compositeScore: 3,
    metrics: {
      CPU: { pct: 90, flag: 1, score: 3 },
      Memory: { pct: 90, flag: 1, score: 3 },
    },
    incidentType: '',
    ...over,
  });

  it('merges adjacent flagged buckets into one episode', () => {
    const episodes = groupAnomalyEpisodes([row({ t: ts(0) }), row({ t: ts(1) })], STEP_MS);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ bucketCount: 2, startT: ts(0), endT: ts(1) });
  });

  it('keeps far-apart buckets as separate episodes', () => {
    const episodes = groupAnomalyEpisodes([row({ t: ts(0) }), row({ t: ts(100) })], STEP_MS);
    expect(episodes).toHaveLength(2);
  });

  it('takes the max severity and score across a merged episode', () => {
    const episodes = groupAnomalyEpisodes(
      [row({ t: ts(0), severity: 'Warning', compositeScore: 1 }), row({ t: ts(1), severity: 'Critical', compositeScore: 5 })],
      STEP_MS,
    );
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({ peakSeverity: 'Critical', peakCompositeScore: 5 });
  });
});

describe('buildAnomalyRemark', () => {
  const spikeIndex = 10;

  it('returns a Critical sentence for a single correlated episode', () => {
    const cpu = series(flatWithSpike(20, 50, spikeIndex, 500));
    const memory = series(flatWithSpike(20, 60, spikeIndex, 500));
    const dbCpu = series(flatWithSpike(20, 40, spikeIndex, 500));
    const dbMemory = series(flatWithSpike(20, 45, spikeIndex, 500));
    const metrics = { cpu, memory, dbCpu, dbMemory } as unknown as AppMetrics;

    const remark = buildAnomalyRemark(metrics);
    expect(remark).not.toBeNull();
    expect(remark!.severity).toBe('critical');
    expect(remark!.text).toContain('Critical');
    expect(remark!.text).toMatch(/^Correlated pressure spike across/);
  });

  it('returns null when nothing rises above Info', () => {
    const cpu = series(flat(20, 50));
    const memory = series(flat(20, 60));
    const metrics = { cpu, memory, dbCpu: undefined, dbMemory: undefined } as unknown as AppMetrics;

    expect(buildAnomalyRemark(metrics)).toBeNull();
  });
});
