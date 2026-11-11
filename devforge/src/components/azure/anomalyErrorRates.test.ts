import { describe, it, expect } from 'vitest';
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import { buildExtras, detectCorrelatedAnomalies, groupAnomalyEpisodes } from './anomalyDetection';

const T0 = Date.parse('2026-11-10T11:00:00Z');
const at = (i: number) => new Date(T0 + i * 300000).toISOString();          // ARM: …:00.000Z
const aiAt = (i: number) => at(i).replace('.000Z', 'Z');                     // App Insights: …:00Z
const n = 30;
const cpu = (spike: number) => Array.from({ length: n }, (_, i) => ({ t: at(i), v: i === 20 ? spike : 20 + (i % 3), m: 0 }));
const overall = (rate: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ t: aiAt(i), count: 1000, c4: 0, c5: Math.round(rate(i) * 10), avgMs: 0, p95: 0 }));
const metrics = (cpuSpike: number, feRate: (i: number) => number, apiRate: (i: number) => number) => ({
  cpu: { avg: 0, max: 0, series: cpu(cpuSpike) },
  memory: { avg: 0, max: 0, series: [] },
  requestInsights: { performance: { overallSeries: overall(feRate) } },
  apiRequestInsights: { performance: { overallSeries: overall(apiRate) } },
}) as unknown as AppMetrics;

describe('error rates in the correlated detector', () => {
  // App Insights and ARM stamp the same bucket differently; keyed by string, the error
  // rates never joined CPU's buckets and the detector ignored every 4xx and 5xx.
  it('joins App Insights error rates to ARM CPU buckets', () => {
    const m = metrics(25, i => (i === 20 ? 13.6 : 0.1), i => (i === 20 ? 9 : 0.2));
    const rows = detectCorrelatedAnomalies(m.cpu, buildExtras(m));
    expect(rows.map(r => [r.t, r.severity, r.incidentType])).toEqual([[at(20), 'Critical', expect.stringMatching(/^Both surfaces erroring/)]]);
  });

  // 10 Nov 17:00–20:00: scattered 0.1% API 5xx buckets came out as six Warning episodes.
  it('does not call a 0.1% error rate a spike', () => {
    const m = metrics(22, i => ([5, 12, 25].includes(i) ? 0.3 : 0), i => ([3, 9, 17, 28].includes(i) ? 0.1 : 0));
    expect(groupAnomalyEpisodes(detectCorrelatedAnomalies(m.cpu, buildExtras(m)))).toEqual([]);
  });
});
