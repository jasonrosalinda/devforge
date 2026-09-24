import { describe, it, expect } from 'vitest';
import { diffApp, snapshotApp, type AppSnapshot } from './healthAlerts';
import type { AppMetrics } from '@shared/types/azureMetrics.types';

const snap = (over: Partial<AppSnapshot> = {}): AppSnapshot => ({
  status: 'healthy', episodes: {}, fiveXxActive: false, downActive: false, ...over,
});

describe('diffApp', () => {
  it('says nothing on the baseline check', () => {
    expect(diffApp(undefined, snap({ status: 'critical', fiveXxActive: true }))).toEqual([]);
  });

  it('reports a status getting worse, not the same or better', () => {
    expect(diffApp(snap(), snap({ status: 'warning' }))).toEqual(['Status healthy → warning']);
    expect(diffApp(snap({ status: 'warning' }), snap({ status: 'warning' }))).toEqual([]);
    expect(diffApp(snap({ status: 'critical' }), snap({ status: 'warning' }))).toEqual([]);
  });

  it('reports a new episode once, and again only when it escalates', () => {
    const warn = { '2026-09-24T08:00:00Z': { severity: 'Warning' as const, label: 'CPU + DB CPU' } };
    const crit = { '2026-09-24T08:00:00Z': { severity: 'Critical' as const, label: 'CPU + DB CPU' } };
    expect(diffApp(snap(), snap({ episodes: warn }))).toEqual(['Anomaly (Warning): CPU + DB CPU']);
    expect(diffApp(snap({ episodes: warn }), snap({ episodes: warn }))).toEqual([]);
    expect(diffApp(snap({ episodes: warn }), snap({ episodes: crit }))).toEqual(['Anomaly (Critical): CPU + DB CPU']);
    expect(diffApp(snap({ episodes: crit }), snap({ episodes: warn }))).toEqual([]);
  });

  it('reports 5xx and downtime when they start, not while they continue', () => {
    expect(diffApp(snap(), snap({ fiveXxActive: true, downActive: true })))
      .toEqual(['5xx errors active', 'Downtime reported by UptimeRobot']);
    expect(diffApp(snap({ fiveXxActive: true, downActive: true }), snap({ fiveXxActive: true, downActive: true })))
      .toEqual([]);
  });
});

describe('snapshotApp', () => {
  it('reads a quiet app as healthy with nothing active', () => {
    const t0 = Date.parse('2026-09-24T00:00:00Z');
    const series = Array.from({ length: 30 }, (_, i) => {
      const t = new Date(t0 + i * 60_000).toISOString();
      return { t, v: 10, m: 10 };
    });
    const m = {
      label: 'app', type: 'appservice',
      cpu: { avg: 10, max: 10, p99: 10, series },
      memory: { avg: 30, max: 30, p99: 30, series: series.map(p => ({ ...p, v: 30, m: 30 })) },
      cpuUnit: '%', memUnit: '%',
    } as unknown as AppMetrics;
    expect(snapshotApp(m, [], series.at(-1)!.t)).toEqual(snap());
  });
});
