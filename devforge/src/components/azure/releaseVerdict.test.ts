import { describe, it, expect } from 'vitest';
import type { AppMetrics, CrashResult, ReleaseEvent, RestartResult } from '@shared/types/azureMetrics.types';
import {
  compareWindows, computeReleaseVerdict, judge, newExceptionTypes, overallVerdict, splitEventCounts, verdictTeamsTable, verdictWindows,
  type VerdictRow, type VerdictWindow,
} from './releaseVerdict';
import { teamsTableHtml } from '@/lib/teams-html';

const AT = Date.parse('2026-11-05T06:00:00Z');
const H = 3600 * 1000;

const insights = (o: { req?: number; p95?: number; t5?: number; t4?: number; exc?: number; dep?: number; depFail?: number; types?: Array<{ type: string; count: number }> }) => ({
  total5xx: o.t5 ?? 0,
  total4xx: o.t4 ?? 0,
  errorTypes: o.types ?? [],
  insight: {
    totalRequests: o.req ?? 1000, requestP95: o.p95 ?? 300, totalExceptions: o.exc ?? 0,
    totalDependencies: o.dep ?? 0, failedDependencies: o.depFail ?? 0,
  },
});

const win = (o: { cpu?: number; p99?: number; mem?: number; memUnit?: string; minutes?: number; restarts?: number; crashes?: number; fe?: ReturnType<typeof insights>; api?: ReturnType<typeof insights> } = {}): VerdictWindow => ({
  metrics: {
    cpu: { avg: o.cpu ?? 20, max: 0, p99: o.p99 ?? 40, series: [] },
    memory: { avg: o.mem ?? 50, max: 0, series: [] },
    memUnit: o.memUnit ?? '%',
    requestInsights: o.fe ?? insights({}),
    apiRequestInsights: o.api ?? null,
  } as unknown as AppMetrics,
  minutes: o.minutes ?? 120,
  restarts: o.restarts ?? 0,
  crashes: o.crashes ?? 0,
});

const row = (rows: VerdictRow[], key: string) => rows.find(r => r.key === key)!;

describe('judge', () => {
  it('needs both the absolute floor and the relative threshold', () => {
    expect(judge(20, 24, 5)).toBe('same');      // under the 5-pt floor
    expect(judge(60, 70, 5)).toBe('same');      // +10 pts but only +16 %
    expect(judge(20, 30, 5)).toBe('worse');     // +10 pts, +50 %
    expect(judge(30, 20, 5)).toBe('better');
  });

  it('treats any change above the floor from zero as a change', () => {
    expect(judge(0, 2, 1)).toBe('worse');
    expect(judge(0, 0.5, 1)).toBe('same');
  });

  it('is n/a when either side is missing', () => {
    expect(judge(null, 5, 1)).toBe('n/a');
    expect(judge(5, null, 1)).toBe('n/a');
  });
});

describe('compareWindows', () => {
  it('flags a 5xx regression and leaves steady metrics alone', () => {
    const rows = compareWindows(win({ fe: insights({ t5: 1 }) }), win({ fe: insights({ t5: 30 }) }), 'fe');
    expect(row(rows, 'rate5xx')).toMatchObject({ beforeText: '0.10%', afterText: '3.00%', judgement: 'worse' });
    expect(row(rows, 'cpuAvg').judgement).toBe('same');
    expect(row(rows, 'p95').judgement).toBe('same');
  });

  it('never judges request volume — it is context', () => {
    const rows = compareWindows(win({ fe: insights({ req: 1000 }) }), win({ fe: insights({ req: 5000 }) }), 'fe');
    expect(row(rows, 'rpm')).toMatchObject({ judgement: 'n/a', beforeText: '8.3', afterText: '41.7' });
  });

  it('normalises restarts and crashes per hour, so a shorter after window is fair', () => {
    // 2 in 2h vs 1 in 1h: the same rate, though the raw counts differ.
    const rows = compareWindows(win({ restarts: 2, minutes: 120 }), win({ restarts: 1, minutes: 60 }), 'fe');
    expect(row(rows, 'restarts')).toMatchObject({ before: 1, after: 1, judgement: 'same' });
    const worse = compareWindows(win({ crashes: 0 }), win({ crashes: 6, minutes: 60 }), 'fe');
    expect(row(worse, 'crashes').judgement).toBe('worse');
  });

  it('reads the API site from apiRequestInsights and shows — when it has none', () => {
    const rows = compareWindows(win({ api: insights({ p95: 200 }) }), win({ api: insights({ p95: 900 }) }), 'api');
    expect(row(rows, 'p95')).toMatchObject({ judgement: 'worse', afterText: '900 ms' });
    const none = compareWindows(win(), win(), 'api');
    expect(row(none, 'p95')).toMatchObject({ beforeText: '—', judgement: 'n/a' });
  });

  it('formats memory in MB with an MB floor when the plan reports MB', () => {
    const rows = compareWindows(win({ mem: 1000, memUnit: 'MB' }), win({ mem: 1080, memUnit: 'MB' }), 'fe');
    expect(row(rows, 'memAvg')).toMatchObject({ afterText: '1080 MB', judgement: 'same' });
  });

  it('guards the divide when there were no requests or dependencies', () => {
    const rows = compareWindows(win({ fe: insights({ req: 0, t5: 3 }) }), win({ fe: insights({ req: 0 }) }), 'fe');
    expect(row(rows, 'rate5xx').before).toBeNull();
    expect(row(rows, 'depFail').before).toBeNull();
    expect(row(rows, 'cpuAvg').deltaPct).toBe(0);
  });
});

describe('newExceptionTypes', () => {
  it('lists types new in the after top list, with enough hits, busiest first', () => {
    const before = [{ type: 'A', count: 50 }];
    const after = [{ type: 'A', count: 60 }, { type: 'B', count: 3 }, { type: 'C', count: 7 }, { type: 'D', count: 20 }];
    expect(newExceptionTypes(before, after)).toEqual([{ type: 'D', count: 20 }, { type: 'C', count: 7 }]);
    expect(newExceptionTypes(null, null)).toEqual([]);
  });
});

describe('overallVerdict', () => {
  const r = (judgement: VerdictRow['judgement']) => ({ judgement } as VerdictRow);
  it('regresses on any worse row or any new exception type', () => {
    expect(overallVerdict([r('better'), r('worse')], [])).toBe('regressed');
    expect(overallVerdict([r('better')], [{ type: 'X' }])).toBe('regressed');
  });
  it('improves only with no regression, else no change', () => {
    expect(overallVerdict([r('same'), r('better')], [])).toBe('improved');
    expect(overallVerdict([r('same'), r('n/a')], [])).toBe('no-change');
  });
});

describe('splitEventCounts', () => {
  it('splits restarts and crash timeline counts at the release, skipping undated events', () => {
    const restarts: RestartResult = { charts: [{ title: 'Restarts', series: [{ name: 'Kudu Kill', series: [
      { t: new Date(AT - H).toISOString(), count: 2 },
      { t: new Date(AT + H).toISOString(), count: 3 },
    ] }] }] };
    const crashes: CrashResult = { events: [], charts: [{ title: 'Crashes', series: [{ name: 'w3wp', series: [
      { t: new Date(AT).toISOString(), count: 4 },
      { t: 'bad', count: 9 },
    ] }] }] };
    expect(splitEventCounts(AT, restarts, crashes)).toEqual({ before: { restarts: 2, crashes: 0 }, after: { restarts: 3, crashes: 4 } });
    expect(splitEventCounts(AT, null, null)).toEqual({ before: { restarts: 0, crashes: 0 }, after: { restarts: 0, crashes: 0 } });
  });
});

describe('verdictWindows', () => {
  it('cuts the after window at now', () => {
    expect(verdictWindows(AT, 2, AT + H)).toEqual({ beforeStart: AT - 2 * H, beforeEnd: AT, afterStart: AT, afterEnd: AT + H });
    expect(verdictWindows(AT, 2, AT + 5 * H).afterEnd).toBe(AT + 2 * H);
  });
});

describe('verdictTeamsTable', () => {
  const event: ReleaseEvent = { at: new Date(AT).toISOString(), source: 'swap', by: '<evil>', build: '1.2' };
  it('builds an escaped table with the verdict in the title and new types in the footer', () => {
    const rows = compareWindows(win({ fe: insights({ t5: 1 }) }), win({ fe: insights({ t5: 30 }) }), 'fe');
    const table = verdictTeamsTable({ appName: 'MEDU', site: 'api', hasApi: true, event, hours: 2, rows, newTypes: [{ type: 'System.Timeout', count: 9 }], verdict: 'regressed' });
    expect(table.title).toBe('Release verdict — MEDU API: Regressed');
    expect(table.subtitle).toContain('2026-11-05 14:00 SGT');
    expect(table.rows.find(r => r[0] === '5xx rate')).toEqual(['5xx rate', '0.10%', '3.00%', '+2900% ▲ worse']);
    expect(table.footer).toEqual(['New exception types after the release: System.Timeout (9)']);
    expect(teamsTableHtml(table)).not.toContain('<evil>');
  });

  it('drops rows with no data on either side and omits the site for a single-site app', () => {
    const rows = compareWindows(win(), win(), 'api');
    const table = verdictTeamsTable({ appName: 'MSP', site: 'fe', hasApi: false, event, hours: 1, rows, newTypes: [], verdict: 'no-change' });
    expect(table.title).toBe('Release verdict — MSP: No change');
    expect(table.rows.some(r => r[0] === 'Response p95')).toBe(false);
    expect(table.footer).toEqual([]);
  });
});

describe('computeReleaseVerdict', () => {
  const event: ReleaseEvent = { at: new Date(AT).toISOString(), source: 'swap' };
  const fakeApi = (beforeFe: ReturnType<typeof insights>, afterFe: ReturnType<typeof insights>, error?: string) => {
    const calls: Array<{ customStart?: string; silent?: boolean }> = [];
    return {
      calls,
      api: {
        fetch: async (o: { customStart?: string; silent?: boolean }) => {
          calls.push(o);
          const m = win({ fe: Date.parse(o.customStart!) < AT ? beforeFe : afterFe }).metrics;
          return { app: error ? ({ error } as unknown as AppMetrics) : m };
        },
        fetchRestarts: async () => ({ fe: null, api: null }),
        fetchCrashes: async () => ({ fe: null, api: null }),
      },
    };
  };

  it('needs 15 minutes of after-release data before it fetches anything', async () => {
    const { api, calls } = fakeApi(insights({}), insights({}));
    const out = await computeReleaseVerdict(api as never, { appKey: 'app', site: 'fe', event, hours: 1, config: {}, nowMs: AT + 10 * 60_000 });
    expect(out).toEqual({ kind: 'too-soon', minutesSince: 10 });
    expect(calls).toEqual([]);
  });

  it('fetches both windows silently and judges them', async () => {
    const { api, calls } = fakeApi(insights({ t5: 2 }), insights({ t5: 40 }));
    const out = await computeReleaseVerdict(api as never, { appKey: 'app', site: 'fe', event, hours: 1, config: {}, nowMs: AT + 2 * H });
    expect(calls.map(c => c.silent)).toEqual([true, true]);
    expect(out.kind === 'done' && out.result.verdict).toBe('regressed');
    expect(out.kind === 'done' && row(out.result.rows, 'rate5xx').judgement).toBe('worse');
  });

  it('reports a fetch error instead of a verdict', async () => {
    const { api } = fakeApi(insights({}), insights({}), 'AuthorizationFailed');
    const out = await computeReleaseVerdict(api as never, { appKey: 'app', site: 'fe', event, hours: 1, config: {}, nowMs: AT + 2 * H });
    expect(out).toEqual({ kind: 'error', message: 'AuthorizationFailed' });
  });
});
