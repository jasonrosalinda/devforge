import { describe, it, expect } from 'vitest';
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import { investigationEpisodes, investigationGranularity } from './useInvestigationTelemetry';

const H = 3_600_000;

describe('investigationGranularity', () => {
  it('drills in at 1 minute up to App Health Check\'s 24h limit for it, coarser beyond', () => {
    expect(investigationGranularity(2 * H)).toBe('PT1M');
    expect(investigationGranularity(24 * H)).toBe('PT1M');
    expect(investigationGranularity(48 * H)).toBe('PT5M');
    expect(investigationGranularity(7 * 24 * H)).toBe('PT15M');
  });
});

describe('investigationEpisodes', () => {
  const T0 = Date.parse('2026-11-10T12:00:00Z');
  const at = (i: number) => new Date(T0 + i * 60000).toISOString();
  const cpu = (spike: number) => Array.from({ length: 30 }, (_, i) => ({ t: at(i), v: i === 20 ? spike : 20 + (i % 3), m: 0 }));
  const overall = (rate: number) => Array.from({ length: 30 }, (_, i) => ({ t: at(i).replace('.000Z', 'Z'), count: 1000, c4: 0, c5: i === 20 ? rate * 10 : 0, avgMs: 0, p95: 0 }));

  it('returns the card detector\'s Warning and Critical episodes, not CPU-only Info', () => {
    const m = { cpu: { avg: 0, max: 0, series: cpu(95) }, memory: { avg: 0, max: 0, series: [] },
      requestInsights: { performance: { overallSeries: overall(13.6) } } } as unknown as AppMetrics;
    expect(investigationEpisodes(m)).toEqual([expect.objectContaining({ startT: at(20), peakSeverity: 'Critical', metricsInvolved: expect.arrayContaining(['CPU', 'FE 5xx']) })]);
    const cpuOnly = { cpu: { avg: 0, max: 0, series: cpu(95) }, memory: { avg: 0, max: 0, series: [] } } as unknown as AppMetrics;
    expect(investigationEpisodes(cpuOnly)).toEqual([]);
  });
});
