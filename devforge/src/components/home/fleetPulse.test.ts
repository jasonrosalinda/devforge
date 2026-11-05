import { describe, it, expect } from 'vitest';
import type { AppMetrics, ReleaseFetchResult } from '@shared/types/azureMetrics.types';
import type { UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { PULSE_WINDOW_MS, buildPulseRow, formatRate, relativeAgo, rowIssues, type PulseInput, type PulseRow } from './fleetPulse';
import { toPoints } from './sparkline';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const MIN = 60_000;
const at = (minsAgo: number) => new Date(NOW - minsAgo * MIN).toISOString();

const series = (vals: number[]) => vals.map((v, i) => ({ t: at(vals.length - 1 - i), v, m: v }));
const metrics = (over: Partial<AppMetrics> = {}): AppMetrics => ({
  label: 'prdmeduapp', type: 'appservice', cpuUnit: '%', memUnit: '%',
  cpu: { avg: 20, max: 30, p99: 30, series: series([10, 20, 30]) },
  memory: { avg: 50, max: 55, p99: 55, series: series([50, 52, 55]) },
  requestsSeries: [2, 1, 0].map(m => ({ t: at(m), count: 100 })),
  failedRequestsSeries: [{ t: at(2), count: 0 }, { t: at(0), count: 1 }],
  ...over,
} as AppMetrics);

const input = (over: Partial<PulseInput> = {}): PulseInput => ({
  key: 'prdmeduapp', label: 'MEDU', hasApi: true, metrics: metrics(), nowMs: NOW, ...over,
});
const monitor = (status: number): UptimeRobotMonitor => ({ id: 1, friendly_name: 'home', url: '', status, logs: [] });

describe('buildPulseRow', () => {
  it('turns the monitor fetch into sparkline series and current values', () => {
    const row = buildPulseRow(input());
    expect(row.cpu).toEqual([10, 20, 30]);
    expect(row.current).toEqual({ cpu: 30, mem: 55 });
    // The fixture app has an API but the fetch returned no API series → FE only, unlabelled.
    expect(row.http5xx).toEqual([{ site: 'fe', label: '5xx', rates: [0, 0.01], current: 0.01, peak: 0.01 }]);
    expect(row.snapshot?.status).toBe('healthy');
  });

  it('splits 5xx into FE and API when the API site reports its own requests', () => {
    const m = metrics({
      apiRequestsSeries: [1, 0].map(n => ({ t: at(n), count: 50 })),
      apiFailedRequestsSeries: [{ t: at(0), count: 5 }],
    });
    const row = buildPulseRow(input({ metrics: m }));
    expect(row.http5xx.map(x => [x.label, x.current, x.peak])).toEqual([['FE 5xx', 0.01, 0.01], ['API 5xx', 0.1, 0.1]]);
    // An app configured without an API ignores stray API series.
    expect(buildPulseRow(input({ metrics: m, hasApi: false })).http5xx.map(x => x.label)).toEqual(['5xx']);
  });

  it('drops the in-progress minute Azure reports as 0 for both CPU and memory', () => {
    const m = metrics({
      cpu: { avg: 20, max: 30, p99: 30, series: series([10, 20, 0]) },
      memory: { avg: 50, max: 55, p99: 55, series: series([50, 52, 0]) },
    });
    const row = buildPulseRow(input({ metrics: m }));
    expect(row.cpu).toEqual([10, 20]);
    // Several minutes still filling are all trimmed, not just the last one.
    const two = metrics({
      cpu: { avg: 20, max: 30, p99: 30, series: series([10, 20, 0, 0]) },
      memory: { avg: 50, max: 55, p99: 55, series: series([50, 52, 0, 0]) },
    });
    expect(buildPulseRow(input({ metrics: two })).current).toMatchObject({ cpu: 20, mem: 52 });
    expect(row.current).toMatchObject({ cpu: 20, mem: 52 });
    // A real 0% CPU with memory reported is kept.
    const idle = buildPulseRow(input({ metrics: metrics({ cpu: { avg: 0, max: 0, p99: 0, series: series([1, 0]) } }) }));
    expect(idle.current.cpu).toBe(0);
  });

  it('places releases in the window as ticks and picks the latest release across sites', () => {
    const releases: ReleaseFetchResult = {
      fe: { events: [{ at: at(60), source: 'swap' }, { at: at(60 * 24), source: 'swap' }], last: { at: at(60), source: 'swap' }, sources: {} },
      api: { events: [{ at: at(30), source: 'deploy' }], last: { at: at(30), source: 'deploy', by: 'jason' }, sources: {} },
    };
    const row = buildPulseRow(input({ releases }));
    expect(row.releaseTicks).toEqual([1 - 60 * MIN / PULSE_WINDOW_MS, 1 - 30 * MIN / PULSE_WINDOW_MS]);
    expect(row.lastRelease).toEqual({ site: 'api', event: releases.api!.last });
    expect(buildPulseRow(input({ releases, hasApi: false })).lastRelease?.site).toBe('fe');
  });

  it('reads UptimeRobot live status: down wins, paused-only is unknown, none is null', () => {
    expect(buildPulseRow(input({ urMonitors: [monitor(2), monitor(9)] })).uptime).toBe('down');
    expect(buildPulseRow(input({ urMonitors: [monitor(2)] })).uptime).toBe('up');
    expect(buildPulseRow(input({ urMonitors: [monitor(0)] })).uptime).toBeNull();
    expect(buildPulseRow(input()).uptime).toBeNull();
  });

  it('marks a failed or empty fetch as an error row but keeps its release info', () => {
    const releases: ReleaseFetchResult = { fe: { events: [], last: { at: at(5), source: 'swap' }, sources: {} }, api: null };
    const row = buildPulseRow(input({ metrics: { ...metrics(), error: 'Forbidden' }, releases }));
    expect(row).toMatchObject({ error: 'Forbidden', cpu: [], current: { cpu: null } });
    expect(row.lastRelease).not.toBeNull();
    expect(buildPulseRow(input({ metrics: undefined })).error).toBe('Azure returned no CPU data');
  });
});

describe('rowIssues', () => {
  it('has nothing to say about a healthy app', () => {
    expect(rowIssues(buildPulseRow(input()))).toEqual([]);
  });

  it('lists an app\'s issues worst first', () => {
    const m = metrics({ cpu: { avg: 75, max: 80, p99: 80, series: series([75, 75, 75]) } });
    const issues = rowIssues(buildPulseRow(input({ label: 'HOT', metrics: m, urMonitors: [monitor(9)] })));
    expect(issues.map(i => i.tone)).toEqual(['critical', 'warning']);
    expect(issues[0]!.text).toBe('HOT is down (UptimeRobot)');
    expect(issues[1]!.text).toMatch(/^HOT warning — CPU avg 75%/);
  });

  it('flags 5xx above 5% per site, from the value the card shows', () => {
    const m = metrics({
      failedRequestsSeries: [{ t: at(0), count: 20 }],
      apiRequestsSeries: [{ t: at(0), count: 100 }],
      apiFailedRequestsSeries: [{ t: at(0), count: 3 }],
    });
    const issues = rowIssues(buildPulseRow(input({ metrics: m })));
    expect(issues).toEqual([{ tone: 'critical', text: 'MEDU FE 5xx at 20.0% now' }]);
    const apiOnly = metrics({ apiRequestsSeries: [{ t: at(0), count: 100 }], apiFailedRequestsSeries: [{ t: at(0), count: 6 }] });
    expect(rowIssues(buildPulseRow(input({ metrics: apiOnly })))).toEqual([{ tone: 'critical', text: 'MEDU API 5xx at 6.0% now' }]);
  });

  it('reports an error row as a warning', () => {
    const row: PulseRow = buildPulseRow(input({ metrics: undefined }));
    expect(rowIssues(row)).toEqual([{ tone: 'warning', text: "MEDU: couldn't load (Azure returned no CPU data)" }]);
  });
});

describe('formatRate', () => {
  it('never shows a non-zero rate as zero', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(0.00004)).toBe('<0.1%');
    expect(formatRate(0.001)).toBe('0.1%');
    expect(formatRate(0.1234)).toBe('12.3%');
  });
});

describe('relativeAgo', () => {
  it.each([
    [0, 'just now'], [-5 * MIN, 'just now'], [59 * 1000, 'just now'],
    [12 * MIN, '12m ago'], [59 * MIN, '59m ago'], [60 * MIN, '1h ago'],
    [47 * 60 * MIN, '47h ago'], [48 * 60 * MIN, '2d ago'],
  ])('%i ms ago → %s', (ago, text) => {
    expect(relativeAgo(NOW - ago, NOW)).toBe(text);
  });
});

describe('toPoints', () => {
  it('scales into the box with 0 at the bottom and max at the top', () => {
    expect(toPoints([0, 50, 100], 100, 10, 100)).toBe('0,10 50,5 100,0');
  });
  it('uses the series max when it exceeds the given max, and clamps negatives', () => {
    expect(toPoints([-1, 20], 10, 10, 10)).toBe('0,10 10,0');
  });
  it('draws a single value as a flat line and nothing for no values', () => {
    expect(toPoints([5], 100, 10, 10)).toBe('0,5 100,5');
    expect(toPoints([], 100, 10)).toBe('');
  });
  it('keeps an all-zero series on the floor instead of dividing by zero', () => {
    expect(toPoints([0, 0], 10, 10)).toBe('0,10 10,10');
  });
});
