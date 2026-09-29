import { describe, it, expect } from 'vitest';
import { diffApp, snapshotApp, trackFetch, type AppSnapshot } from './healthAlerts';
import type { AppMetrics } from '@shared/types/azureMetrics.types';

const snap = (over: Partial<AppSnapshot> = {}): AppSnapshot => ({
  status: 'healthy', statusDetail: 'CPU avg 10%, p99 10%', episodes: {}, fiveXxActive: false, downActive: false, ...over,
});

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

describe('diffApp', () => {
  it('says nothing on the baseline check', () => {
    expect(diffApp(undefined, snap({ status: 'critical', fiveXxActive: true }))).toEqual([]);
  });

  it('reports a status getting worse with the numbers behind it, not the same or better', () => {
    const detail = 'CPU avg 72.1%, p99 88% · Memory avg 36%, p99 43%';
    expect(diffApp(snap(), snap({ status: 'warning', statusDetail: detail }))).toEqual([`Status healthy → warning — ${detail}`]);
    expect(diffApp(snap({ status: 'warning' }), snap({ status: 'warning' }))).toEqual([]);
    expect(diffApp(snap({ status: 'critical' }), snap({ status: 'warning' }))).toEqual([]);
  });

  it('reports a new episode once, and again only when it escalates', () => {
    const text = 'at 9:37 AM — CPU 85%, DB CPU 62.3%';
    const warn = { '2026-09-24T08:00:00Z': { severity: 'Warning' as const, text } };
    const crit = { '2026-09-24T08:00:00Z': { severity: 'Critical' as const, text } };
    expect(diffApp(snap(), snap({ episodes: warn }))).toEqual([`Anomaly (Warning) ${text}`]);
    expect(diffApp(snap({ episodes: warn }), snap({ episodes: warn }))).toEqual([]);
    expect(diffApp(snap({ episodes: warn }), snap({ episodes: crit }))).toEqual([`Anomaly (Critical) ${text}`]);
    expect(diffApp(snap({ episodes: crit }), snap({ episodes: warn }))).toEqual([]);
  });

  it('puts the incident hint on its own line', () => {
    const eps = { t: { severity: 'Warning' as const, text: 'at 9:37 AM — CPU 85%', hint: 'Check slow queries' } };
    expect(diffApp(snap(), snap({ episodes: eps }))).toEqual(['Anomaly (Warning) at 9:37 AM — CPU 85%\nCheck slow queries']);
  });

  it('reports 5xx and downtime when they start, with their detail, not while they continue', () => {
    const on = snap({ fiveXxActive: true, fiveXxDetail: '5xx errors (peak 7.2%)', downActive: true, downDetail: 'downtime (1 incident, 3 min)' });
    expect(diffApp(snap(), on)).toEqual(['5xx errors (peak 7.2%)', 'UptimeRobot reports downtime (1 incident, 3 min)']);
    expect(diffApp(on, on)).toEqual([]);
  });

  it('falls back to plain wording when a detail is missing', () => {
    expect(diffApp(snap(), snap({ fiveXxActive: true, downActive: true })))
      .toEqual(['5xx errors active', 'UptimeRobot reports downtime']);
  });
});

describe('trackFetch', () => {
  it('alerts once on the third failed check in a row, then stays quiet', () => {
    let h = trackFetch(undefined, 'boom');
    expect(h.line).toBeNull();
    h = trackFetch(h.next, 'boom');
    expect(h.line).toBeNull();
    h = trackFetch(h.next, 'boom');
    expect(h.line).toBe("Monitor can't reach Azure: boom");
    h = trackFetch(h.next, 'boom');
    expect(h.line).toBeNull();
  });

  it('says monitoring resumed on the first good check after an alert, and nothing otherwise', () => {
    let h = trackFetch(undefined, 'boom');
    h = trackFetch(h.next, null);
    expect(h.line).toBeNull(); // one blip, never alerted
    for (let i = 0; i < 3; i++) h = trackFetch(h.next, 'boom');
    h = trackFetch(h.next, null);
    expect(h.line).toBe('Monitoring resumed');
    expect(trackFetch(h.next, null).line).toBeNull();
  });

  it('starts counting again after a good check', () => {
    let h = trackFetch(undefined, 'boom');
    h = trackFetch(h.next, 'boom');
    h = trackFetch(h.next, null);
    h = trackFetch(h.next, 'boom');
    expect(trackFetch(h.next, 'boom').line).toBeNull();
  });

  it('turns an expired Azure CLI sign-in into the command to fix it, and keeps other errors short', () => {
    const run = (err: string) => {
      let h = trackFetch(undefined, err);
      h = trackFetch(h.next, err);
      return trackFetch(h.next, err).line;
    };
    expect(run("DefaultAzureCredential failed.\nAzureCliCredential: Please run 'az login' to set up an account"))
      .toBe("Monitor can't reach Azure: sign-in expired — run az login");
    expect(run(`first line\n${'x'.repeat(500)}`)).toBe("Monitor can't reach Azure: first line");
    expect(run('y'.repeat(500))!.length).toBeLessThanOrEqual("Monitor can't reach Azure: ".length + 160);
  });
});

describe('snapshotApp', () => {
  const t0 = Date.parse('2026-09-24T00:00:00Z');
  const pts = (values: number[]) => values.map((v, i) => ({ t: new Date(t0 + i * 60_000).toISOString(), v, m: v }));
  const flat = (v: number) => Array.from({ length: 30 }, () => v);

  it('reads a quiet app as healthy with nothing active', () => {
    const series = pts(flat(10));
    const m = {
      label: 'app', type: 'appservice',
      cpu: { avg: 10, max: 10, p99: 10, series },
      memory: { avg: 30, max: 30, p99: 30, series: pts(flat(30)) },
      cpuUnit: '%', memUnit: '%',
    } as unknown as AppMetrics;
    expect(snapshotApp(m, [], series.at(-1)!.t)).toEqual(snap({ statusDetail: 'CPU avg 10%, p99 10% · Memory avg 30%, p99 30%' }));
  });

  it('describes memory in MB without a p99, since it has no capacity to be a share of', () => {
    const series = pts(flat(10));
    const m = {
      label: 'app', type: 'appservice',
      cpu: { avg: 10, max: 10, p99: 10, series },
      memory: { avg: 512.4, max: 600, p99: 590, series: pts(flat(512)) },
      cpuUnit: '%', memUnit: 'MB',
    } as unknown as AppMetrics;
    expect(snapshotApp(m, [], series.at(-1)!.t).statusDetail).toBe('CPU avg 10%, p99 10% · Memory avg 512 MB');
  });

  it('names each spiking metric with its peak and the time the episode started', () => {
    const cpuVals = flat(20); cpuVals[20] = 85;
    const dbVals = flat(10); dbVals[20] = 62.34;
    const cpu = pts(cpuVals);
    const m = {
      label: 'app', type: 'appservice',
      cpu: { avg: 22, max: 85, p99: 85, series: cpu },
      memory: { avg: 30, max: 30, p99: 30, series: pts(flat(30)) },
      dbCpu: { avg: 11, max: 62, p99: 62, series: pts(dbVals) },
      cpuUnit: '%', memUnit: '%',
    } as unknown as AppMetrics;
    const eps = Object.values(snapshotApp(m, [], cpu.at(-1)!.t).episodes);
    expect(eps).toEqual([{
      severity: 'Warning',
      text: `at ${time(cpu[20]!.t)} — CPU 85%, DB CPU 62.3%`,
      hint: 'Correlated CPU pressure, no errors yet — monitor, check for slow queries',
    }]);
  });
});
