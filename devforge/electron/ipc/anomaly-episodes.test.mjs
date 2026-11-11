import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as ts from '../../src/components/azure/anomalyDetection.ts';

const require = createRequire(import.meta.url);
const cjs = require('./anomaly-episodes.cjs');

const T0 = Date.parse('2026-11-10T11:00:00Z');
const at = (i) => new Date(T0 + i * 300000).toISOString();
const series = (values) => values.map((v, i) => ({ t: at(i), v, m: v }));
// 30 quiet buckets with a correlated spike at 20–22: CPU, memory and both 5xx rates.
const wave = (base, spike, from = 20, to = 22) => Array.from({ length: 30 }, (_, i) => (i >= from && i <= to ? spike : base + (i % 3)));

describe('anomaly-episodes.cjs matches the card detector (anomalyDetection.ts)', () => {
  it('uses the same sensitivities and floors', () => {
    for (const k of ['CPU_SENSITIVITY', 'MEMORY_SENSITIVITY', 'DB_CPU_SENSITIVITY', 'DB_MEMORY_SENSITIVITY', 'ERROR_RATE_SENSITIVITY', 'CPU_SPIKE_FLOOR', 'MEMORY_SPIKE_FLOOR', 'ERROR_RATE_SPIKE_FLOOR']) {
      expect(cjs[k], k).toEqual(ts[k]);
    }
  });

  it('flags, groups and labels identically on the same series', () => {
    const cpu = { avg: 0, max: 0, series: series(wave(20, 95)) };
    const extras = [
      { name: 'Memory', series: series(wave(40, 92)), sensitivity: ts.MEMORY_SENSITIVITY, floor: ts.MEMORY_SPIKE_FLOOR },
      { name: 'DB CPU', series: series(wave(10, 30)), sensitivity: ts.DB_CPU_SENSITIVITY, floor: ts.DB_CPU_SPIKE_FLOOR },
      { name: 'FE 5xx', series: series(wave(0.1, 12)), sensitivity: ts.ERROR_RATE_SENSITIVITY },
      { name: 'API 5xx', series: series(wave(0.2, 9, 21, 23)), sensitivity: ts.ERROR_RATE_SENSITIVITY },
      { name: 'API 4xx', series: [], sensitivity: ts.ERROR_RATE_SENSITIVITY },
    ];
    const tsRows = ts.detectCorrelatedAnomalies(cpu, extras);
    const cjsRows = cjs.detectCorrelatedAnomalies(cpu, extras);
    expect(cjsRows).toEqual(tsRows);
    expect(tsRows.length).toBeGreaterThan(0);
    expect(cjs.groupAnomalyEpisodes(cjsRows, 300000)).toEqual(ts.groupAnomalyEpisodes(tsRows, 300000));
    for (const v of [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 50], [5, 5, 5, 5, 5, 5, 5, 5, 5, 5]]) {
      expect(cjs.robustAnomalyFlags(v, 2)).toEqual(ts.robustAnomalyFlags(v, 2));
      expect(cjs.linefit(v)).toEqual(ts.linefit(v));
    }
  });
});

describe('incidentEpisodes', () => {
  const arm = (values) => values.map((v, i) => ({ timeStamp: at(i), average: v, maximum: v }));
  // App Insights writes timestamps with 7 decimals; they must still join ARM's.
  const aiRows = (rates) => rates.map((r, i) => [at(i).replace('.000Z', '.0000000Z'), 1000, r * 10, 0]);

  it('finds a Critical episode when both sites error under CPU pressure, joining ARM and App Insights timestamps', () => {
    const eps = cjs.incidentEpisodes(
      { cpuSeries: arm(wave(20, 95)), memSeries: arm(wave(40, 50)), fiveXxRows: aiRows(wave(0.1, 12)) },
      { fiveXxRows: aiRows(wave(0.1, 9)) },
    );
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ startT: at(20), endT: at(22), peakSeverity: 'Critical', incidentType: expect.stringMatching(/^Both surfaces erroring/) });
    expect(eps[0].metricsInvolved).toEqual(expect.arrayContaining(['CPU', 'FE 5xx', 'API 5xx']));
  });

  it('leaves out CPU-only Info episodes and returns nothing without CPU data', () => {
    expect(cjs.incidentEpisodes({ cpuSeries: arm(wave(20, 95)) }, null)).toEqual([]);
    expect(cjs.incidentEpisodes({ cpuSeries: [] }, null)).toEqual([]);
  });
});
