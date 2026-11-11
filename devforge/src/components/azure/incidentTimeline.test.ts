import { describe, it, expect } from 'vitest';
import { buildTimelineLanes, type TimelineInput } from './incidentTimeline';
import { httpRateBuckets } from './appRemarks';
import type { AppMetrics, CrashResult, ReleaseResult, RestartResult } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';

const T0 = Date.parse('2026-11-05T00:00:00Z');
const MIN = 60 * 1000;
const iso = (m: number) => new Date(T0 + m * MIN).toISOString();

const flat = (n: number, step = 15) => ({
  avg: 10, max: 10, p99: 10,
  series: Array.from({ length: n }, (_, i) => ({ t: iso(i * step), v: 10, m: 10 })),
});
const baseMetrics = { cpu: flat(8), memory: flat(8) } as unknown as AppMetrics;

const input = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  startMs: T0, endMs: T0 + 120 * MIN, metrics: baseMetrics, hasApi: false, ...over,
});
const lane = (lanes: ReturnType<typeof buildTimelineLanes>, key: string) => lanes.find(l => l.key === key)!;

describe('buildTimelineLanes', () => {
  it('returns every lane, empty when nothing happened', () => {
    const lanes = buildTimelineLanes(input());
    expect(lanes.map(l => l.key)).toEqual(['releases', 'changes', 'restarts', 'crashes', 'downtime', 'anomalies', 'http5xx']);
    expect(lanes.every(l => l.items.length === 0)).toBe(true);
  });

  it('shows Activity Log changes per site with who made them, inside the range only', () => {
    const fe: ReleaseResult = { events: [], last: null, sources: {}, changes: [
      { at: iso(-60), kind: 'config', label: 'Configuration change' },
      { at: iso(15), kind: 'restart', label: 'Restart', by: 'ops@mims.com' },
    ] };
    const api: ReleaseResult = { events: [], last: null, sources: {}, changes: [{ at: iso(40), kind: 'plan', label: 'App Service plan change' }] };
    const items = lane(buildTimelineLanes(input({ hasApi: true, releases: fe, apiReleases: api })), 'changes').items;
    expect(items.map(i => [i.startMs, i.site, i.cause])).toEqual([[T0 + 15 * MIN, 'fe', 'restart'], [T0 + 40 * MIN, 'api', 'plan']]);
    expect(items[0]!.title).toMatch(/^FE · .* · Restart\nby ops@mims\.com$/);
  });

  it('keeps releases inside the range and drops the 30-day look-back ones', () => {
    const releases: ReleaseResult = {
      events: [
        { at: iso(-3 * 24 * 60), source: 'swap' },
        { at: iso(30), source: 'deploy', build: '1.2.3', by: 'jason' },
      ],
      last: null, sources: {},
    };
    const items = lane(buildTimelineLanes(input({ releases })), 'releases').items;
    expect(items).toHaveLength(1);
    expect(items[0]!.startMs).toBe(T0 + 30 * MIN);
    expect(items[0]!.release).toEqual({ site: 'fe', event: releases.events[1] });
    expect(items[0]!.title).toContain('Build 1.2.3');
  });

  it('tags FE and API when the app has an API, and ignores API data when it has none', () => {
    const r = (m: number): ReleaseResult => ({ events: [{ at: iso(m), source: 'swap' }], last: null, sources: {} });
    const withApi = lane(buildTimelineLanes(input({ hasApi: true, releases: r(10), apiReleases: r(20) })), 'releases').items;
    expect(withApi.map(i => i.release!.site)).toEqual(['fe', 'api']);
    expect(withApi[1]!.title.startsWith('API · ')).toBe(true);
    const noApi = lane(buildTimelineLanes(input({ releases: r(10), apiReleases: r(20) })), 'releases').items;
    expect(noApi).toHaveLength(1);
    expect(noApi[0]!.title.startsWith('FE')).toBe(false);
  });

  it('plots dated restarts and skips undated ones', () => {
    const restarts: RestartResult = {
      charts: [],
      insights: [{ status: 'Critical', message: '', items: [
        { name: 'App Crash', html: '', text: 'Around 11/05/2026 00:45:00 (UTC), on Instance WN1, your application process experienced a crash.' },
      ] }],
    };
    const items = lane(buildTimelineLanes(input({ restarts })), 'restarts').items;
    expect(items.every(i => Number.isFinite(i.startMs))).toBe(true);
    const chartRestarts: RestartResult = { charts: [{ title: 'Restart', series: [{ name: 'Kudu Kill', series: [{ t: iso(15), count: 2 }, { t: iso(30), count: 0 }] }] }] };
    const fromChart = lane(buildTimelineLanes(input({ restarts: chartRestarts })), 'restarts').items;
    expect(fromChart).toHaveLength(1);
    expect(fromChart[0]!.title).toContain('2× Kudu Kill');
  });

  it('plots captured crash events', () => {
    const crashes: CrashResult = { charts: [], events: [{ t: iso(50), exitCode: 'e0434352', category: 'CLR Exception', exceptionType: 'System.NullReferenceException', stackTrace: '' }] };
    const items = lane(buildTimelineLanes(input({ crashes })), 'crashes').items;
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('System.NullReferenceException');
  });

  it('uses UptimeRobot downtime as intervals, clipped to the range', () => {
    const urMonitors: UptimeRobotMonitor[] = [{
      id: 1, friendly_name: 'MEDU home', url: '', status: 2,
      logs: [
        { type: 1, datetime: (T0 - 10 * MIN) / 1000, duration: 20 * 60, reason: { code: 500, detail: 'Internal Server Error' } },
        { type: 2, datetime: (T0 + 10 * MIN) / 1000, duration: 60 },
      ],
    }];
    const items = lane(buildTimelineLanes(input({ urMonitors })), 'downtime').items;
    expect(items).toHaveLength(1);
    expect(items[0]!.startMs).toBe(T0);
    expect(items[0]!.endMs).toBe(T0 + 10 * MIN);
    expect(items[0]!.title).toContain('MEDU home down');
    expect(items[0]!.title).toContain('Internal Server Error');
  });

  it('falls back to Azure availability downtime only when UptimeRobot reports none', () => {
    const metrics = { ...baseMetrics, availability: { pct: 99, downtimeMins: 5, incidents: 1, series: [], downtimeIntervals: [{ start: T0 + 5 * MIN, end: T0 + 10 * MIN, cause: 'HTTP 503' }] } } as unknown as AppMetrics;
    const items = lane(buildTimelineLanes(input({ metrics })), 'downtime').items;
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('Azure availability down');
    expect(items[0]!.title).toContain('HTTP 503');
  });

  it('merges consecutive 5xx buckets over the threshold into one burst', () => {
    const metrics = {
      ...baseMetrics,
      requestsSeries: [0, 15, 30, 45].map(m => ({ t: iso(m), count: 100 })),
      failedRequestsSeries: [{ t: iso(15), count: 10 }, { t: iso(30), count: 8 }, { t: iso(45), count: 1 }],
    } as unknown as AppMetrics;
    const items = lane(buildTimelineLanes(input({ metrics })), 'http5xx').items;
    expect(items).toHaveLength(1);
    expect(items[0]!.startMs).toBe(T0 + 15 * MIN);
    expect(items[0]!.endMs).toBe(T0 + 45 * MIN);
    expect(items[0]!.title).toContain('Peak 10.0%');
  });

  it('splits 5xx bursts into FE and API lanes from each site\'s App Insights timeline', () => {
    const perf = (c5: number[]) => ({ performance: { overallSeries: c5.map((n, i) => ({ t: iso(i * 15), count: 100, c4: 0, c5: n, avgMs: 0, p95: 0 })) } });
    const metrics = {
      ...baseMetrics,
      requestInsights: perf([0, 10, 0, 0]),
      apiRequestInsights: perf([0, 0, 8, 9]),
    } as unknown as AppMetrics;
    const lanes = buildTimelineLanes(input({ metrics, hasApi: true }));
    const fe = lane(lanes, 'http5xx');
    const api = lane(lanes, 'http5xxApi');
    expect(fe.label).toBe('FE 5xx');
    expect(fe.items.map(i => [i.startMs, i.endMs, i.burstSite])).toEqual([[T0 + 15 * MIN, T0 + 30 * MIN, 'fe']]);
    expect(api.label).toBe('API 5xx');
    expect(api.items.map(i => [i.startMs, i.endMs, i.burstSite])).toEqual([[T0 + 30 * MIN, T0 + 60 * MIN, 'api']]);
    expect(api.items[0]!.title).toMatch(/^API · 5xx above 5%.*\nPeak 9\.0%$/s);
  });

  it('ignores a bucket with too few requests even when its 5xx rate is high', () => {
    const series = [{ n: 10, c5: 5 }, { n: 100, c5: 0 }, { n: 100, c5: 10 }].map((b, i) => ({ t: iso(i * 15), count: b.n, c4: 0, c5: b.c5, avgMs: 0, p95: 0 }));
    const metrics = { ...baseMetrics, requestInsights: { performance: { overallSeries: series } } } as unknown as AppMetrics;
    const items = lane(buildTimelineLanes(input({ metrics })), 'http5xx').items;
    expect(items.map(i => i.startMs)).toEqual([T0 + 30 * MIN]);
  });

  it('has no API lane for an app without an API', () => {
    expect(buildTimelineLanes(input()).some(l => l.key === 'http5xxApi')).toBe(false);
  });

  it('drops events with unparseable timestamps', () => {
    const crashes: CrashResult = { charts: [], events: [{ t: 'not a date', exitCode: '', category: 'x', exceptionType: null, stackTrace: '' }] };
    expect(lane(buildTimelineLanes(input({ crashes })), 'crashes').items).toHaveLength(0);
  });
});

describe('httpRateBuckets', () => {
  it('sums finer error points into the containing requests bucket', () => {
    const rates = httpRateBuckets(
      [{ t: iso(15), count: 2 }, { t: iso(16), count: 2 }, { t: iso(17), count: 2 }],
      [{ t: iso(0), count: 100 }, { t: iso(15), count: 100 }],
    );
    expect(rates).toEqual([{ t: iso(15), rate: 0.06 }]);
  });

  it('returns nothing without errors or requests, and skips zero-request buckets', () => {
    expect(httpRateBuckets(null, [{ t: iso(0), count: 1 }])).toEqual([]);
    expect(httpRateBuckets([{ t: iso(0), count: 1 }], [])).toEqual([]);
    expect(httpRateBuckets([{ t: iso(0), count: 1 }], [{ t: iso(0), count: 0 }])).toEqual([]);
  });

  it('drops error points before the first requests bucket', () => {
    expect(httpRateBuckets([{ t: iso(-5), count: 3 }], [{ t: iso(0), count: 10 }])).toEqual([]);
  });
});
