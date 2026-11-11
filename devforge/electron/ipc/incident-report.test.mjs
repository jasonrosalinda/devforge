import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./incident-report.cjs');

const {
  _sgt: sgt,
  _sgtTime: sgtTime,
  _durFormat: durFormat,
  _computeAnomalyScore: computeAnomalyScore,
  _computeDowntime: computeDowntime,
  _generateMarkdown: generateMarkdown,
  _buildRcaPrompt: buildRcaPrompt,
  _buildInstanceHealth: buildInstanceHealth,
  _stripModelNarration: stripModelNarration,
  _detectBursts: detectBursts,
  _restartEvents: restartEvents,
  _topFrames: topFrames,
  _siteSnatSection: siteSnatSection,
  _siteSnatReport: siteSnatReport,
  _meanOf: meanOf,
  _anomalyEpisodesSection: anomalyEpisodesSection,
  _baselineSection: baselineSection,
  _baselinePeriods: baselinePeriods,
} = handler;

describe('meanOf', () => {
  // An API with no health-check path publishes HealthCheckStatus as nulls: the report printed
  // "Availability 0.00% | 100.00% (min)" because the average counted them as 0 and the min as 100.
  it('averages only the points that carry a value, and is null when none do', () => {
    expect(meanOf([{ average: null }, { average: null }], 'average')).toBeNull();
    expect(meanOf([{ average: 100 }, { average: null }, { average: 50 }], 'average')).toBe(75);
    expect(meanOf([], 'average')).toBeNull();
    expect(meanOf(undefined, 'average')).toBeNull();
  });
});

// The model sometimes appends an acknowledgement that it disregarded the
// environment's caveman hook. The prompt forbids it, but prompt compliance is not
// guaranteed, so the output is sanitised too.
describe('stripModelNarration', () => {
  const body = [
    '## Quick Summary',
    '',
    'The site was down for 23 minutes from 17:00 SGT.',
    '',
    '# Root Cause Analysis Report',
    '',
    '## 1. Executive Summary',
    '',
    'Anomaly score 85/100.',
  ].join('\n');

  it('removes the caveman-hook acknowledgement from the tail', () => {
    const out = stripModelNarration(
      `${body}\n\nAnalysis complete. The prompt's explicit writing rules override the active caveman hook, so this report is in formal prose as required.\n`
    );
    expect(out).toBe(body);
  });

  it('removes a preamble before the first heading', () => {
    const out = stripModelNarration(`Here is the root cause analysis, in formal prose as required.\n\n${body}`);
    expect(out).toBe(body);
  });

  it('strips a bare "Analysis complete." sign-off', () => {
    expect(stripModelNarration(`${body}\n\nAnalysis complete.`)).toBe(body);
  });

  it('leaves clean output untouched', () => {
    expect(stripModelNarration(body)).toBe(body);
  });

  // Only the ends are trimmed, so a body sentence containing a matched word stays.
  it('never strips narration-like wording from inside the report', () => {
    const withInner = [
      '## Quick Summary',
      '',
      'Requests failed as required by the retry policy.',
      '',
      '## 1. Executive Summary',
      '',
      'The deploy completed as instructed by the release runbook.',
    ].join('\n');
    expect(stripModelNarration(withInner)).toBe(withInner);
  });

  it('never discards headings, tables, lists, or code blocks', () => {
    const structural = [
      '## Quick Summary',
      '',
      'Down 23 minutes.',
      '',
      '## 2. Root Cause Analysis',
      '',
      '| Signal | Observed |',
      '|---|---|',
      '| CPU | 91% |',
      '',
      '- Contributing factor as required',
      '',
      '```',
      'az webapp restart',
      '```',
    ].join('\n');
    expect(stripModelNarration(structural)).toBe(structural);
  });

  it('handles empty and CRLF input', () => {
    expect(stripModelNarration('')).toBe('');
    expect(stripModelNarration(null)).toBeNull();
    expect(stripModelNarration('## Quick Summary\r\n\r\nDown.\r\n')).toBe('## Quick Summary\n\nDown.');
  });
});

// Azure returns a point for every bucket in the timespan for each instance
// dimension, with `total` absent where the instance served nothing — including
// every bucket before it existed. Scoring those 100% made scale-out invisible and
// let a DOWN instance (serving no traffic) read as perfectly healthy.
describe('buildInstanceHealth', () => {
  const t = (i) => `2026-07-29T02:${String(i * 5).padStart(2, '0')}:00Z`;

  it('omits no-data buckets instead of scoring them 100%', () => {
    const req = [{ name: 'wk_0', data: [
      { timeStamp: t(0) },                    // absent total — instance not yet created
      { timeStamp: t(1), total: 0 },          // explicit zero — still no signal
      { timeStamp: t(2), total: 100 },
    ] }];
    const err = [{ name: 'wk_0', data: [{ timeStamp: t(2), total: 10 }] }];
    const [inst] = buildInstanceHealth(req, err);
    expect(inst.series).toEqual([{ t: t(2), v: 90 }]);
  });

  it('makes a scaled-out instance start later than an original one', () => {
    const req = [
      { name: 'wk_0', data: [{ timeStamp: t(0), total: 50 }, { timeStamp: t(1), total: 50 }, { timeStamp: t(2), total: 50 }] },
      { name: 'wk_1', data: [{ timeStamp: t(0) }, { timeStamp: t(1) }, { timeStamp: t(2), total: 50 }] },
    ];
    const [orig, scaled] = buildInstanceHealth(req, []);
    expect(orig.series[0].t).toBe(t(0));
    expect(scaled.series[0].t).toBe(t(2));
    expect(scaled.series).toHaveLength(1);
  });

  // A crashed instance stops serving, so its absence must not read as health.
  it('leaves a crashed instance with no points rather than 100%', () => {
    const req = [{ name: 'wk_0', data: [{ timeStamp: t(0), total: 40 }, { timeStamp: t(1) }, { timeStamp: t(2) }] }];
    const [inst] = buildInstanceHealth(req, []);
    expect(inst.series).toHaveLength(1);
    expect(inst.series.every(p => p.v === 100)).toBe(true); // the one real bucket was clean
    expect(inst.series.map(p => p.t)).not.toContain(t(1));
  });

  it('returns null when there is no per-instance data at all', () => {
    expect(buildInstanceHealth(null, null)).toBeNull();
    expect(buildInstanceHealth([], [])).toBeNull();
  });
});

// ── Timestamps ────────────────────────────────────────────────────────────────
// The RCA prompt asserts every telemetry timestamp is SGT. Before these helpers
// existed most sections emitted raw UTC, so the model dated incidents 8h early.

describe('sgt', () => {
  it('shifts UTC by +8 and labels SGT', () => {
    expect(sgt('2026-07-30T06:05:00Z')).toBe('2026-07-30 14:05 SGT');
  });
  it('rolls the date forward past UTC midnight', () => {
    expect(sgt('2026-07-30T17:30:00Z')).toBe('2026-07-31 01:30 SGT');
  });
  it('accepts epoch milliseconds as well as ISO strings', () => {
    expect(sgt(Date.parse('2026-07-30T06:05:00Z'))).toBe('2026-07-30 14:05 SGT');
  });
  it('yields an em dash for malformed input rather than NaN', () => {
    expect(sgt('not-a-date')).toBe('—');
    expect(sgt(undefined)).toBe('—');
  });
});

describe('sgtTime', () => {
  it('returns just HH:mm for dense table columns', () => {
    expect(sgtTime('2026-07-30T06:05:00Z')).toBe('14:05');
  });
  it('degrades to an em dash on bad input', () => {
    expect(sgtTime('')).toBe('—');
  });
});

describe('durFormat', () => {
  it('formats sub-minute spans in seconds', () => {
    expect(durFormat(30_000)).toBe('30s');
  });
  it('formats minute spans', () => {
    expect(durFormat(45 * 60_000)).toBe('45m');
  });
  it('formats hour+minute spans', () => {
    expect(durFormat(5_400_000)).toBe('1h 30m');
  });
  it('rejects negative and non-numeric input', () => {
    expect(durFormat(-1)).toBe('—');
    expect(durFormat(NaN)).toBe('—');
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────
// 4 hours at 5-minute resolution with a confirmed outage in buckets 12–18, and
// only worker 0 unhealthy — so the cause must classify as instance_crash.

const START = Date.parse('2026-07-29T02:00:00Z'); // 10:00 SGT
const N = 48;
const iso = (i) => new Date(START + i * 300_000).toISOString();
const bad = (i) => i >= 12 && i <= 18;

const series = (fn) => Array.from({ length: N }, (_, i) => ({ timeStamp: iso(i), ...fn(i) }));

function makeData(overrides = {}) {
  return {
    cpuSeries: series(i => ({ average: bad(i) ? 91 : 34, maximum: bad(i) ? 99 : 51 })),
    memSeries: series(i => ({ average: bad(i) ? 88 : 61, maximum: bad(i) ? 94 : 70 })),
    rtSeries: series(i => ({ average: bad(i) ? 8.4 : 0.42, maximum: bad(i) ? 14.2 : 1.1 })),
    availSeries: series(i => ({ average: bad(i) ? 42 : 100 })),
    requestsSeries: series(i => ({ total: bad(i) ? 1900 : 600 })),
    fail5xxSeries: series(i => ({ total: bad(i) ? 640 : 1 })),
    fail4xxSeries: series(i => ({ total: bad(i) ? 12 : 4 })),
    exceptionAnalysis: null, endpointLatency: null, sqlDeep: null, deploymentEvents: null,
    snatIndicators: null, failedDeps: null, highFreqIPs: null, threadPoolCounters: null,
    gcCounters: null, failedUrlsByStatus: null, slowUrls: null, timeoutsByEndpoint: null,
    socketSkew: null, planCapacity: null, connectionsSeries: [],
    trafficInsight: {
      totalDeps: 9000, failedDeps: 700, depFailRate: 7.8, depP95: 12000, depP99: 30100,
      totalReqs: 42000, failedReqs: 4600, reqFailRate: 10.9, reqP95: 9800, reqP99: 14200,
      socketLayerExceptions: 31, timeoutExceptions: 122, oomExceptions: 4,
      totalExceptions: 620, uniqueUsers: 1840, botRequests: 210,
    },
    oomInsights: { summary: { records: 3, trueCount: 4, instances: 1, firstSeen: iso(15), lastSeen: iso(17) }, details: [] },
    dependencyTimeouts: [{ name: 'sp_GetOrders', resultCode: '-2', type: 'SQL', target: 'sql-prod', count: 88, p95: 30000, maxMs: 30100, firstSeen: iso(12), lastSeen: iso(18) }],
    socketCounters: { planName: 'plan-prod', metrics: [{ name: 'TcpEstablished', avg: 120, max: 300 }, { name: 'TcpTimeWait', avg: 1400, max: 4100 }] },
    dbCpuSeries: series(() => ({ average: 22, maximum: 31 })),
    dbMemSeries: series(() => ({ average: 55, maximum: 61 })),
    userTraffic: {
      timeline: Array.from({ length: N }, (_, i) => ({ timestamp: iso(i), users: bad(i) ? 610 : 95, sessions: bad(i) ? 700 : 110, requests: bad(i) ? 1900 : 600, failed: bad(i) ? 640 : 1 })),
      bursts: [{ timestamp: iso(12), users: 610, sessions: 700, requests: 1900, failed: 640, userFactor: 6.4, reqFactor: 3.2, failRate: 33.68 }],
      baseline: { userMedian: 95, reqMedian: 600, buckets: N },
      peak: { users: 610, requests: 1900, atUsers: iso(12), atRequests: iso(12) },
      totalUsers: 1840,
      byCountry: [{ country: 'SG', users: 1500, requests: 38000 }],
    },
    instanceHealthSeries: ['wk_0', 'wk_1'].map((name, idx) => ({
      name, series: Array.from({ length: N }, (_, i) => ({ t: iso(i), v: (bad(i) && idx === 0) ? 11 : 100 })),
    })),
    instanceProbeSeries: ['wk_0', 'wk_1'].map((name, idx) => ({
      name, series: Array.from({ length: N }, (_, i) => ({ t: iso(i), v: (bad(i) && idx === 0) ? 0 : 100 })),
    })),
    hasDbConfig: true, hasEdgeConfig: false, edge: null,
    ...overrides,
  };
}

const render = (data, extra = {}) => generateMarkdown({
  appName: 'app-prod', resourceGroup: 'rg-prod', startMs: START, endMs: START + N * 300_000,
  data, anomaly: computeAnomalyScore(data), hasAppInsights: true,
  uptimeRobotIncidents: undefined, apiData: null, apiName: null, ...extra,
});

// ── Anomaly score ─────────────────────────────────────────────────────────────

describe('computeAnomalyScore', () => {
  // avail<99 (+30) · 5xx>2% (+20) · socket exceptions>5 (+5) · OOM>0 (+15) ·
  // dep timeouts>10 (+10) · RT P99 14.2s>5s (+15). CPU avg 42% and memory avg 65%
  // stay under their thresholds because the spike is only 7 of 48 buckets.
  it('scores a severe incident from the rules that actually fire', () => {
    expect(computeAnomalyScore(makeData()).score).toBe(95);
  });

  // HttpResponseTime arrives in seconds; the rule and the report both need ms.
  it('converts response time to milliseconds so the P99 rule can fire', () => {
    expect(computeAnomalyScore(makeData()).rtP99).toBeCloseTo(14200, 0);
  });

  it('derives the TimeWait:Established ratio from socket counters', () => {
    expect(computeAnomalyScore(makeData()).socketRatio).toBeCloseTo(11.7, 1);
  });

  it('reports no ratio when socket counters are unavailable', () => {
    expect(computeAnomalyScore(makeData({ socketCounters: null })).socketRatio).toBeNull();
  });

  it('sums dependency timeouts by result code', () => {
    expect(computeAnomalyScore(makeData()).depTimeoutCount).toBe(88);
  });

  // Container Apps publish no Requests/Http5xx ARM metrics, so an ARM-only
  // failRate was always 0 and the 5xx rule could never fire for them.
  it('falls back to App Insights request totals when ARM metrics are empty', () => {
    const a = computeAnomalyScore(makeData({ requestsSeries: [], fail5xxSeries: [] }));
    expect(a.usingAiRequests).toBe(true);
    expect(a.totalReqs).toBe(42000);
    expect(a.failRate).toBeGreaterThan(10);
  });

  it('prefers ARM totals when they are present', () => {
    const a = computeAnomalyScore(makeData());
    expect(a.usingAiRequests).toBe(false);
  });

  it('stays at zero for a clean window', () => {
    const quiet = makeData({
      cpuSeries: series(() => ({ average: 12, maximum: 20 })),
      memSeries: series(() => ({ average: 40, maximum: 45 })),
      rtSeries: series(() => ({ average: 0.1, maximum: 0.3 })),
      availSeries: series(() => ({ average: 100 })),
      fail5xxSeries: series(() => ({ total: 0 })),
      oomInsights: null, dependencyTimeouts: null, socketCounters: null,
      trafficInsight: { ...makeData().trafficInsight, socketLayerExceptions: 0, timeoutExceptions: 0, failedReqs: 0, reqFailRate: 0 },
      snatIndicators: null, sqlDeep: null,
    });
    expect(computeAnomalyScore(quiet).score).toBe(0);
  });
});

// ── Downtime detection ────────────────────────────────────────────────────────

describe('computeDowntime', () => {
  it('detects the confirmed interval and classifies a single-worker failure', () => {
    const iv = computeDowntime(makeData());
    expect(iv).toHaveLength(1);
    expect(iv[0].cause).toBe('instance_crash');
    expect(iv[0].affected).toBe(1);
    expect(iv[0].totalInstances).toBe(2);
  });

  it('classifies a full outage when every worker is unhealthy', () => {
    const all = makeData({
      instanceHealthSeries: ['wk_0', 'wk_1'].map(name => ({
        name, series: Array.from({ length: N }, (_, i) => ({ t: iso(i), v: bad(i) ? 5 : 100 })),
      })),
    });
    expect(computeDowntime(all)[0].cause).toBe('full_outage');
  });

  it('classifies dependency failure when instances stayed healthy', () => {
    const healthy = makeData({
      instanceHealthSeries: ['wk_0', 'wk_1'].map(name => ({
        name, series: Array.from({ length: N }, (_, i) => ({ t: iso(i), v: 100 })),
      })),
      instanceProbeSeries: [],   // probe condition defaults true without data
    });
    expect(computeDowntime(healthy)[0].cause).toBe('dependency_failure');
  });

  it('returns nothing for a fully available window', () => {
    expect(computeDowntime(makeData({ availSeries: series(() => ({ average: 100 })) }))).toEqual([]);
  });

  // 4xx-dominant errors are an auth/client storm, not an outage.
  it('ignores windows where 4xx dominates 5xx', () => {
    const clientErrors = makeData({
      fail5xxSeries: series(i => ({ total: bad(i) ? 5 : 0 })),
      fail4xxSeries: series(i => ({ total: bad(i) ? 900 : 4 })),
    });
    expect(computeDowntime(clientErrors)).toEqual([]);
  });

  it('survives an empty availability series', () => {
    expect(computeDowntime(makeData({ availSeries: [] }))).toEqual([]);
  });
});

// ── Report rendering ──────────────────────────────────────────────────────────

describe('detectBursts', () => {
  const t = (min) => new Date(Date.UTC(2026, 10, 10, 6, min)).toISOString();

  it('merges adjacent buckets above 5% into one interval and ignores quiet ones', () => {
    const out = detectBursts([
      [t(20), 1000, 10],     // 1%, fine
      [t(10), 1000, 100],    // 10%
      [t(5), 1000, 60],      // 6%
      [t(0), 1000, 50],      // exactly 5%, not above
      [t(30), 0, 0],         // no traffic
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ start: Date.parse(t(5)), end: Date.parse(t(15)), failed: 160, total: 2000 });
    expect(out[0].peak).toBeCloseTo(0.1);
  });

  it('ignores a thin bucket: 1 failure in 10 requests is noise, 20 requests is not', () => {
    expect(detectBursts([[t(0), 10, 5]])).toEqual([]);
    expect(detectBursts([[t(0), 19, 19]])).toEqual([]);
    expect(detectBursts([[t(0), 20, 2]])).toHaveLength(1);
  });

  it('keeps separate bursts apart', () => {
    expect(detectBursts([[t(0), 100, 50], [t(30), 100, 50]])).toHaveLength(2);
  });

  it('returns nothing for no data', () => {
    expect(detectBursts(null)).toEqual([]);
    expect(detectBursts([])).toEqual([]);
  });
});

describe('5xx bursts in the report', () => {
  const burst = {
    start: START, end: START + 300_000, total: 2000, failed: 713, peak: 0.36,
    endpoints: [{ name: 'POST User/SaveUserProfile', code: '500', count: 713 }],
    deps: [{ op: 'POST User/SaveUserProfile', type: 'Http (tracked component)', target: 'ssoapi.mims.com', failed: 684 }],
  };
  const part = (md) => md.slice(md.indexOf('### 5xx Bursts'));

  it('lists each burst with its endpoints and failing downstream calls', () => {
    const md = part(render(makeData({ fiveXxBursts: [burst] })));
    expect(md).toContain('36.0%');
    expect(md).toContain('`POST User/SaveUserProfile`');
    expect(md).toContain('ssoapi.mims.com');
  });

  it('says so when there is no burst, and stays silent when the fetch failed', () => {
    expect(part(render(makeData({ fiveXxBursts: [] })))).toContain('No 5xx burst');
    expect(render(makeData({ fiveXxBursts: null }))).not.toContain('### 5xx Bursts');
  });

  it('says the API shares the frontend\'s App Insights instead of repeating its tables', () => {
    const md = render(makeData(), {
      apiName: 'app-api', apiData: { reqSummary: null, arm: null, sharedInsights: true, fiveXxBursts: [burst] },
    });
    const apiPart = md.slice(md.indexOf('## API: app-api'));
    expect(apiPart).toContain('same Application Insights resource as the frontend');
    expect(apiPart).not.toContain('### Top Endpoints');
    expect(apiPart).not.toContain('### 5xx Bursts');
  });

  it('reports the API\'s bursts too', () => {
    const md = render(makeData(), { apiName: 'app-api', apiData: { reqSummary: null, arm: null, fiveXxBursts: [burst] } });
    expect(md.slice(md.indexOf('## API: app-api'))).toContain('### 5xx Bursts');
  });

  it('gives a burst far from any downtime its own 5-minute timeline rows', () => {
    const md = render(makeData({ fiveXxBursts: [{ ...burst, start: START + 20 * 300_000, end: START + 21 * 300_000 }] }));
    const rows = md.slice(md.indexOf('## Incident Timeline')).split('\n').filter(l => l.startsWith('| ')).length;
    const without = render(makeData()).slice(render(makeData()).indexOf('## Incident Timeline')).split('\n').filter(l => l.startsWith('| ')).length;
    expect(rows).toBeGreaterThan(without);
  });
});

describe('exceptions in the report', () => {
  const stack = JSON.stringify([
    { level: 0, method: 'System.Net.Http.HttpClient.Send', fileName: null },
    { level: 1, method: 'MIMS.Education.API.Controllers.UserController.SaveProfile', fileName: 'C:\\src\\Controllers\\UserController.cs', line: 88 },
    { level: 2, method: 'MIMS.Education.API.Startup.Handle', fileName: '/src/Startup.cs', line: 12 },
    { level: 3, method: 'Microsoft.AspNetCore.Hosting.Run' },
    { level: 4, method: 'MIMS.Education.API.Deep.Frame', fileName: 'Deep.cs', line: 1 },
  ]);

  it('names the application frames where an exception was thrown, framework frames last', () => {
    expect(topFrames(stack)).toBe(
      'MIMS.Education.API.Controllers.UserController.SaveProfile (UserController.cs:88) ← MIMS.Education.API.Startup.Handle (Startup.cs:12) ← MIMS.Education.API.Deep.Frame (Deep.cs:1)');
    expect(topFrames(JSON.stringify([{ method: 'System.A' }, { method: 'System.B' }]))).toBe('System.A ← System.B');
  });

  it('returns nothing for an absent or malformed stack', () => {
    expect(topFrames('')).toBe('');
    expect(topFrames('not json')).toBe('');
    expect(topFrames('{"a":1}')).toBe('');
  });

  it('shows where each exception was thrown and the busiest buckets', () => {
    const exceptionAnalysis = [{
      type: 'System.Net.Http.HttpRequestException', outerMessage: '429 Too Many Requests', count: 395,
      firstOccurrence: '2026-11-10T12:00:00Z', lastOccurrence: '2026-11-10T12:25:00Z',
      sampleInnerMsg: '', sampleOpName: 'POST User/SaveUserProfile', sampleInnerType: '', thrownAt: 'UserController.SaveProfile (UserController.cs:88)',
    }];
    const md = render(makeData({ exceptionAnalysis, exceptionPeaks: [{ t: '2026-11-10T12:05:00Z', count: 120 }] }));
    const part = md.slice(md.indexOf('## 10. Error Intelligence'));
    expect(part).toContain('Thrown at');
    expect(part).toContain('UserController.SaveProfile (UserController.cs:88)');
    expect(part).toContain('Busiest 5-minute buckets: 2026-11-10 20:05 SGT (120)');
  });

  it('shows the same columns for the API', () => {
    const md = render(makeData(), { apiName: 'app-api', apiData: { reqSummary: null, arm: null, exceptionPeaks: [], exceptionAnalysis: [{
      type: 'X', outerMessage: 'm', count: 3, firstOccurrence: '', lastOccurrence: '', sampleInnerMsg: '', sampleOpName: '', sampleInnerType: '', thrownAt: 'Api.Handler (H.cs:1)',
    }] } });
    expect(md.slice(md.indexOf('## API: app-api'))).toContain('Api.Handler (H.cs:1)');
  });
});

describe('restarts & crashes in the report', () => {
  const restarts = {
    charts: [{ title: 'Application restarts', series: [
      { name: 'App Crash', series: [{ t: '2026-07-29T02:05:00.000Z', count: 2 }, { t: '2026-07-29T02:10:00.000Z', count: 0 }] },
      { name: 'Platform Healing Your App', series: [{ t: '2026-07-29T02:00:00.000Z', count: 1 }] },
    ] }],
    insights: [{ status: 'Critical', message: 'Application stop events are detected', items: [{ name: 'RD0001', text: 'stopped by Platform Healing' }] }],
  };
  const crashes = {
    charts: [{ title: 'Crashes timeline', series: [{ name: 'Crashes', series: [{ t: '2026-07-29T02:05:00.000Z', count: 2 }] }] }],
    events: [{ t: '2026-07-29T02:05:00.000Z', exitCode: '0xE0434352', category: 'CLR Exception', exceptionType: 'System.ObjectDisposedException', stackTrace: 'A.B()\nC.D()\nE.F()\nG.H()' }],
  };
  const part = (siteEvents) => {
    const md = render(makeData({ siteEvents }));
    return md.includes('## 17.') ? md.slice(md.indexOf('## 17.')) : '';
  };

  it('orders restart buckets newest first and drops empty ones', () => {
    expect(restartEvents(restarts)).toEqual([
      { t: '2026-07-29T02:05:00.000Z', cause: 'App Crash', count: 2 },
      { t: '2026-07-29T02:00:00.000Z', cause: 'Platform Healing Your App', count: 1 },
    ]);
  });

  // What the webappstart detector really returns: no chart at all, the events only in prose.
  // Reading the chart alone reported "none" for an incident that had three Kudu kills.
  it('reads restarts from the detector prose when the chart is empty', () => {
    const prose = {
      charts: [],
      insights: [{ status: 'Critical', message: 'Application stop events are detected', items: [
        { name: 'Kudu Kill(w3wp)', text: 'We analyzed ``3`` Kudu Kill Events.' },
        { name: 'Kudu Kill(w3wp)', text: 'Kudu Kill(w3wp) Around 11/10/2026 12:21:51 (UTC), on Instance WN0SDWK000M2U, your application process (w3wp.exe) was terminated. Kudu Kill(w3wp) Around 11/10/2026 12:23:05 (UTC), on Instance WN0SDWK000M7O, your application process was terminated.' },
        { name: 'Additional Information', text: 'Kudu Kill Around 01/01/2020 00:00:00 (UTC), on Instance IGNORED' },
      ] }],
    };
    const md = part({ fe: { restarts: prose, crashes: null }, api: null });
    expect(md).toContain('**Restarts:** 3');
    expect(md).not.toContain('none in the window');
    expect(md).toContain('WN0SDWK000M2U');
    expect(md).toContain('2026-11-10 20:23 SGT');   // 12:23 UTC
    expect(md).not.toContain('IGNORED');
    expect(restartEvents(prose).map(e => e.instance)).toEqual(['WN0SDWK000M7O', 'WN0SDWK000M2U']);
  });

  it('reports restart causes, detector findings and crash exceptions with their top frames', () => {
    const md = part({ fe: { restarts, crashes }, api: null });
    expect(md).toContain('**Restarts:** 3');
    expect(md).toContain('Platform Healing Your App');
    expect(md).toContain('Application stop events are detected');
    expect(md).toContain('`System.ObjectDisposedException`');
    expect(md).toContain('A.B() ← C.D() ← E.F()');
    expect(md).not.toContain('G.H()');
  });

  it('says "unknown" rather than "none" when a detector is missing, and "none" only when it answered empty', () => {
    const missing = part({ fe: { restarts: null, crashes: null }, api: null });
    expect(missing).toContain('unknown (not "none")');
    const empty = part({ fe: { restarts: { charts: [], insights: [] }, crashes: { charts: [], events: [] } }, api: null });
    expect(empty).toContain('**Restarts:** none in the window.');
    expect(empty).toContain('**Crashes:** none in the window.');
  });

  it('omits the section when neither site was queried', () => {
    expect(part({ fe: null, api: null })).toBe('');
  });
});

describe('generateMarkdown', () => {
  it('emits every category including the new ones', () => {
    const md = render(makeData());
    for (const heading of [
      '## Downtime Intervals (confirmed)',
      '## Incident Timeline (deterministic)',
      '## 14. Memory & Out-of-Memory Exceptions',
      '## 15. Database Server Health',
      '## 16. User Traffic & Bursts',
      '### Outbound Socket / TCP Counters',
      '### Dependency Timeouts (by result code)',
    ]) {
      expect(md).toContain(heading);
    }
  });

  // The single most important invariant: the prompt tells the model the telemetry
  // is SGT, so no raw UTC may survive anywhere in the document.
  it('never leaks an ISO-8601 or Z-suffixed timestamp', () => {
    const md = render(makeData());
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(md).not.toMatch(/\d{2}:\d{2}:\d{2}(\.\d+)?Z/);
  });

  it('lists the API\'s 5xx and 4xx endpoints, and omits the tables when there are none', () => {
    const api = (failedUrlsByStatus) => render(makeData(), {
      apiName: 'app-api', apiData: { reqSummary: null, arm: null, failedUrlsByStatus },
    });
    const md = api({ urls5xx: [{ name: '/v1/orders', count: 7 }], urls4xx: [{ name: '/v1/login', count: 3 }] });
    const apiPart = md.slice(md.indexOf('## API: app-api'));
    expect(apiPart).toContain('**5xx errors by endpoint:**');
    expect(apiPart).toContain('`/v1/orders`');
    expect(apiPart).toContain('**4xx errors by endpoint:**');
    expect(apiPart).toContain('`/v1/login`');

    const none = api(null);
    expect(none.slice(none.indexOf('## API: app-api'))).not.toContain('errors by endpoint');
  });

  it('marks unconfigured sections as unassessed rather than healthy', () => {
    const md = render(makeData({ hasDbConfig: false, edge: null, hasEdgeConfig: false }));
    expect(md).toContain('## 13. Network / Edge Diagnostics');
    expect(md).toMatch(/edge\/network path could NOT be assessed/);
    expect(md).toMatch(/server-side DB compute could NOT be assessed/);
  });

  it('renders without throwing when every optional signal is missing', () => {
    const bare = {
      cpuSeries: [], memSeries: [], rtSeries: [], availSeries: [], requestsSeries: [],
      fail5xxSeries: [], fail4xxSeries: [], connectionsSeries: [], dbCpuSeries: [], dbMemSeries: [],
      instanceProbeSeries: [], hasDbConfig: false, hasEdgeConfig: false, edge: null,
    };
    const md = generateMarkdown({
      appName: 'bare', resourceGroup: 'rg', startMs: START, endMs: START + 3_600_000,
      data: bare, anomaly: computeAnomalyScore(bare), hasAppInsights: false,
      uptimeRobotIncidents: undefined, apiData: null, apiName: null,
    });
    expect(md).toContain('# Azure App Service Incident Report');
    expect(md).toContain('No time-series data available');
  });

  it('distinguishes DOWN buckets from adjacent context buckets', () => {
    const md = render(makeData());
    const timeline = md.slice(md.indexOf('## Incident Timeline'), md.indexOf('## 1. Dependency'));
    expect(timeline).toContain('**DOWN**');
    // A context row can legitimately read 100% availability, so labelling it DOWN
    // would contradict its own numbers.
    expect(timeline).toContain('context');
  });

  it('labels rollup rows with the bucket count they merged', () => {
    const md = render(makeData());
    expect(md).toMatch(/_rollup \d+×\d+m_/);
  });

  // Gauges are read at their per-bucket peak: a 5-minute average flattens the
  // spike that caused the failure. Availability is the inverse — its worst value.
  it('reports CPU, memory, response time and DB at their peak', () => {
    const md = render(makeData());
    const timeline = md.slice(md.indexOf('## Incident Timeline'), md.indexOf('## 1. Dependency'));
    expect(timeline).toContain('CPU max%');
    expect(timeline).toContain('Mem max%');
    expect(timeline).toContain('DB CPU max%');
    expect(timeline).not.toContain('CPU avg%');
    expect(timeline).toMatch(/per-bucket PEAKS/);
    // Fixture: during the outage cpu average is 91 and maximum 99 — the row must
    // carry the maximum.
    const downRow = timeline.split('\n').find(l => l.includes('**DOWN**') && l.includes('99.0'));
    expect(downRow).toBeDefined();
    expect(downRow).not.toMatch(/\|\s*91\.0\s*\|/);
    // Memory: average 88, maximum 94.
    expect(timeline).toMatch(/\|\s*94\.0\s*\|/);
  });

  it('uses the worst value, not the mean, when rolling up quiet stretches', () => {
    const md = render(makeData());
    const timeline = md.slice(md.indexOf('## Incident Timeline'), md.indexOf('## 1. Dependency'));
    // Table rows only — the explanatory note above contains the literal "_rollup NxNm_".
    const rollup = timeline.split('\n').find(l => l.startsWith('|') && l.includes('_rollup'));
    expect(rollup).toBeDefined();
    // Quiet buckets in the fixture peak at 51% CPU / 70% memory.
    expect(rollup).toMatch(/\|\s*51\.0\s*\|/);
    expect(rollup).toMatch(/\|\s*70\.0\s*\|/);
  });

  // Database load belongs on the same timeline as app load, otherwise there is no
  // way to tell whether the database led the incident or merely reacted to it.
  it('includes database columns in the timeline when a database is configured', () => {
    const md = render(makeData());
    const timeline = md.slice(md.indexOf('## Incident Timeline'), md.indexOf('## 1. Dependency'));
    expect(timeline).toContain('DB CPU max%');
    expect(timeline).toContain('DB Mem max%');
    // Header column count must match the rendered cell count. Match on the table
    // row specifically — the explanatory note above it also mentions "DB CPU".
    const lines = timeline.split('\n');
    const header = lines.find(l => l.startsWith('|') && l.includes('DB CPU max%'));
    const firstRow = lines.find(l => /^\| \d{2}:\d{2}/.test(l));
    expect(header).toBeDefined();
    expect(firstRow.split('|').length).toBe(header.split('|').length);
  });

  it('omits the database columns and says why when none is configured', () => {
    const md = render(makeData({ dbCpuSeries: [], dbMemSeries: [], hasDbConfig: false }));
    const timeline = md.slice(md.indexOf('## Incident Timeline'), md.indexOf('## 1. Dependency'));
    expect(timeline).not.toContain('DB CPU max%');
    expect(timeline).toMatch(/No database server columns/);
  });
});

// ── Prompt ────────────────────────────────────────────────────────────────────

describe('buildRcaPrompt', () => {
  const prompt = () => buildRcaPrompt(render(makeData()));

  it('strips the raw time-series dump', () => {
    expect(prompt()).not.toContain('## Raw Time Series');
  });

  // The timeline section used to be stripped along with the raw series, which is
  // what forced the model to invent its 5-minute table.
  it('keeps the deterministic timeline the timeline section must cite', () => {
    expect(prompt()).toContain('## Incident Timeline (deterministic)');
  });

  it('asks for the plain-English Quick Summary first, then the retitled report', () => {
    const p = prompt();
    expect(p).toContain('## Quick Summary');
    expect(p).toContain('# Root Cause Analysis Report');
    expect(p).not.toContain('Incident Solution Plan');
    expect(p.indexOf('## Quick Summary')).toBeLessThan(p.indexOf('# Root Cause Analysis Report'));
  });

  // The summary is printed first but must be DERIVED from section 2, otherwise the
  // model writes it before it has decided on a cause and the two can disagree.
  it('scopes the Quick Summary to section 2 primary cause + contributing factors', () => {
    const p = prompt();
    const instructions = p.slice(0, p.indexOf('## TELEMETRY REPORT'));
    expect(instructions).toMatch(/PRIMARY CAUSE and CONTRIBUTING FACTORS/);
    expect(instructions).toMatch(/section 2 FIRST/);
    expect(instructions).toMatch(/Never contradict section 2/i);
    expect(instructions).toMatch(/contributing-factors list/);
    // No contributing factors is a valid finding, not a reason to invent some.
    expect(instructions).toMatch(/OMIT THIS ROW ENTIRELY/);
    expect(instructions).toMatch(/do not write "none"/i);
  });

  // The summary leads with the answer: a verdict line, then a facts table.
  it('requires a verdict line and a two-column facts table in the Quick Summary', () => {
    const instructions = prompt().slice(0, prompt().indexOf('## TELEMETRY REPORT'));
    expect(instructions).toMatch(/verdict line/i);
    expect(instructions).toMatch(/\*\*Cause:\*\*/);
    expect(instructions).toMatch(/two-column table/);
    for (const row of ['Root cause', 'Started', 'Duration', 'User impact', 'Made it worse', 'Ruled out', 'Recovery']) {
      expect(instructions).toContain(row);
    }
    // Formatting stays minimal so the callout and the Teams paste both render it.
    expect(instructions).toMatch(/No headings, no bullet lists, no code spans/);
  });

  it('bans identifiers, not just jargon words, from the Quick Summary', () => {
    const p = prompt();
    expect(p).toMatch(/no identifiers/i);
    expect(p).toMatch(/exception type names, result codes, endpoint paths, instance names/i);
  });

  it('forbids UTC and unlabelled times', () => {
    expect(prompt()).toMatch(/never emit an ISO-8601/i);
  });

  it('requires the differential diagnosis and confidence', () => {
    const p = prompt();
    expect(p).toContain('differential diagnosis');
    expect(p).toMatch(/UNASSESSED/);
    expect(p).toMatch(/Confidence/);
  });

  it('asks for 8 report sections, ending at data gaps', () => {
    const p = prompt();
    // Scoped to the instructions: the telemetry appended below has its own
    // "## 9. Availability" / "## 10. Error Intelligence" categories.
    const instructions = p.slice(0, p.indexOf('## TELEMETRY REPORT'));
    // Verification checklist and follow-up were dropped — the report analyses the
    // incident, it does not track the remediation work.
    expect(instructions).not.toMatch(/Verification Checklist/i);
    expect(instructions).not.toMatch(/Follow-Up/i);
    expect(instructions).toContain('## 8. Analysis Confidence & Data Gaps');
    expect(instructions).not.toMatch(/^## (9|10)\. /m);
  });

  // The engineering layout is the default: the RCA dialog's report is untouched by
  // the card section's business-format option.
  it('defaults to the engineering layout, never the business one', () => {
    for (const p of [prompt(), buildRcaPrompt(render(makeData()), '', {}), buildRcaPrompt(render(makeData()), '', { format: 'engineering' })]) {
      expect(p).toContain('# Root Cause Analysis Report');
      expect(p).not.toContain('# RCA Report:');
      expect(p).not.toContain('**Incident number:**');
    }
  });

  // Analyst notes are optional context typed in the RCA dialog. Absent, the prompt
  // must not carry an empty section or hint at notes that were never supplied.
  it('omits the analyst-notes section when no notes are given', () => {
    for (const p of [prompt(), buildRcaPrompt(render(makeData()), ''), buildRcaPrompt(render(makeData()), '   \n ')]) {
      expect(p).not.toMatch(/ANALYST INVESTIGATION NOTES/);
      expect(p).not.toMatch(/analyst investigation notes/);
    }
  });

  it('includes analyst notes as reference evidence, above the telemetry', () => {
    const p = buildRcaPrompt(render(makeData()), 'Release 1.16.0 deployed 14:05 SGT; new EF query lacks AsNoTracking.');
    expect(p).toContain('## ANALYST INVESTIGATION NOTES');
    expect(p).toContain('Release 1.16.0 deployed 14:05 SGT');
    expect(p.indexOf('## ANALYST INVESTIGATION NOTES')).toBeLessThan(p.indexOf('## TELEMETRY REPORT'));
    // Notes are weighed against the metrics — never a source of numbers, and a
    // contradiction has to be surfaced rather than quietly resolved either way.
    expect(p).toMatch(/REFERENCE, not telemetry/);
    expect(p).toMatch(/never let them override a measured value/);
    expect(p).toMatch(/CONTRADICT the telemetry/);
    expect(p).toMatch(/no figure may originate from them/);
    expect(p).toMatch(/include that candidate in the differential diagnosis/);
  });
});

// The card's RCA section renders the report as a form, so it asks for the formal
// seven-section incident report rather than the engineering layout.
describe('buildRcaPrompt - business format', () => {
  const bizPrompt = (notes = '', meta = {}) =>
    buildRcaPrompt(render(makeData()), notes, { format: 'business', ...meta });
  const bizInstructions = () => bizPrompt().split('## TELEMETRY REPORT')[0];

  it('produces the RCA Report title and the metadata header block', () => {
    const p = bizPrompt('', { incidentNumber: 'INC-202607-004' });
    expect(p).toContain('# RCA Report:');
    expect(p).toContain('## Root Cause Analysis (RCA)');
    for (const field of ['**Incident number:**', '**Incident:**', '**Services Affected:**', '**Incident Period:**', '**Severity:**']) {
      expect(p).toContain(field);
    }
    expect(p).toContain('INC-202607-004');
    expect(p).toMatch(/do not invent, renumber, or reformat it/);
    // Without one the prompt still has to tell the model how to shape it.
    expect(bizPrompt()).toMatch(/INC-<YYYYMM of the incident start, SGT>-001/);
  });

  it('asks for the 7 sections, ending at current status', () => {
    const instructions = bizInstructions();
    for (const heading of [
      '## 1. Background', '## 2. Impact', '## 3. Root Cause', '## 4. Resolution',
      '## 5. Lessons Learned', '## 6. Preventive Actions', '## 7. Current Status',
    ]) {
      expect(instructions).toContain(heading);
    }
    expect(instructions).not.toMatch(/^## 8\. /m);
    expect(instructions).not.toMatch(/## 1\. Executive Summary/);
    expect(instructions).not.toMatch(/evidence matrix/);
  });

  // The Quick Summary is derived from the root-cause section, numbered 3 in this
  // layout and 2 in the engineering one.
  it('points the Quick Summary at section 3', () => {
    const instructions = bizInstructions();
    expect(instructions).toMatch(/section 3 FIRST/);
    expect(instructions).toMatch(/Never contradict section 3/i);
    expect(instructions).not.toMatch(/section 2 FIRST/);
  });

  // The business layout closes with the Tracker, not section 7. Naming section 7 as the
  // last line told the model to stop early and the Tracker never appeared.
  it('ends the business report at the Tracker, and the engineering one at section 8', () => {
    expect(bizInstructions()).toMatch(/final line of the Tracker section/);
    expect(bizInstructions()).not.toMatch(/final line of section 7/);
    expect(buildRcaPrompt(render(makeData()), '')).toMatch(/final line of section 8/);
  });

  // Human events (a user report, when the team started looking) are not in the
  // telemetry - the background narrative must not manufacture them.
  it('bars invented human events from the background narrative', () => {
    const instructions = bizInstructions();
    expect(instructions).toMatch(/chronological narrative/);
    expect(instructions).toMatch(/never invent them/);
  });

  // A business figure is cited or left out — never estimated, and never turned into
  // a list of follow-up work at the end of the impact section.
  it('bars estimated business figures and a follow-up list', () => {
    const instructions = bizInstructions();
    expect(instructions).not.toMatch(/Following actions/);
    expect(instructions).toMatch(/never estimate one/i);
    expect(instructions).toMatch(/never end with work still to be done/);
  });

  // Impact is the section a manager reads first: the worst-hit page with its real
  // numbers, then everyone else, in a few sentences.
  it('keeps impact short, specific and free of other sections\' material', () => {
    const instructions = bizInstructions();
    const impact = instructions.slice(instructions.indexOf('## 2. Impact'), instructions.indexOf('## 3. Root Cause'));
    expect(impact).toMatch(/Two to four sentences/);
    expect(impact).toMatch(/no headings, no table, no list/);
    expect(impact).toMatch(/failure rate and attempt count/);
    expect(impact).toMatch(/the wider front-end user population/);
    expect(impact).toMatch(/No background, no causes, no timeline narration, no remediation/);
  });

  // The cause, then how it played out, then at most three contributing factors. The
  // differential belongs to the engineering layout, not this one.
  it('keeps root cause brief and drops the ruled-out write-up', () => {
    const instructions = bizInstructions();
    const cause = instructions.slice(instructions.indexOf('## 3. Root Cause'), instructions.indexOf('## 4. Resolution'));
    expect(cause).toMatch(/single \*\*primary cause\*\*/);
    expect(cause).toMatch(/Two to four sentences, no more/i);
    expect(cause).toMatch(/No preamble, no method, no restating the impact/);
    expect(cause).toMatch(/at most three/);
    expect(cause).toMatch(/No explanation beyond the line itself/);
    // The elimination reasoning is a decision aid, explicitly not output.
    expect(cause).toMatch(/Do not list the candidates you considered and eliminated/);
    expect(cause).toMatch(/publish only the conclusion/);
    expect(cause).not.toMatch(/name the candidates you \*\*ruled out\*\*/);
  });

  // Nothing in the summary may promise a differential this layout never writes.
  it('drops the Quick Summary Ruled out row', () => {
    expect(bizInstructions()).not.toMatch(/\| Ruled out \|/);
    // The engineering layout keeps both.
    const eng = buildRcaPrompt(render(makeData())).split('## TELEMETRY REPORT')[0];
    expect(eng).toMatch(/\| Ruled out \|/);
    expect(eng).toContain('differential diagnosis');
  });

  it('asks for preventive actions as a hyphen-bulleted list', () => {
    const instructions = bizInstructions();
    const preventive = instructions.slice(instructions.indexOf('## 6. Preventive Actions'), instructions.indexOf('## 7. Current Status'));
    expect(preventive).toMatch(/A bulleted list/);
    expect(preventive).toMatch(/beginning with a hyphen and a space/);
    expect(preventive).toMatch(/No introductory sentence before the list/);
  });

  // Sections must not repeat each other, and short beats exhaustive.
  it('confines each section to its own material and rewards brevity', () => {
    const instructions = bizInstructions();
    expect(instructions).toMatch(/Every section answers only its own question/);
    expect(instructions).toMatch(/A fact belongs to exactly one section/);
    expect(instructions).toMatch(/Concise beats complete/);
    expect(instructions).toMatch(/Every number appears once/);
  });

  // The engineer names the incident in the card, and the report has to be about that
  // incident rather than whatever else the window contains.
  it('makes the named incident the subject of the analysis', () => {
    const p = bizPrompt('', { incidentName: 'MEDU Downtime' });
    expect(p).toContain('## THE INCIDENT UNDER ANALYSIS');
    expect(p).toContain('This report analyses one specific incident: **MEDU Downtime**');
    expect(p).toContain('**Incident:** MEDU Downtime');
    expect(p).toMatch(/Use that incident name exactly as given/);
    // Every part of the report speaks to the named symptom, anchored to the period.
    expect(p).toMatch(/must all speak to that same symptom/);
    expect(p).toMatch(/Anchor the analysis to the incident period/);
    // Unrelated anomalies are set aside, not written up as this incident.
    expect(p).toMatch(/do not belong in this report/);
    // No evidence of the named symptom is a finding, not a licence to substitute one.
    expect(p).toMatch(/Insufficient data rather than substituting a different incident/);
    // It is read before the report layout.
    expect(p.indexOf('## THE INCIDENT UNDER ANALYSIS')).toBeLessThan(p.indexOf('# RCA Report:'));
  });

  it('omits the subject block when no incident is named', () => {
    const p = bizPrompt();
    expect(p).not.toContain('THE INCIDENT UNDER ANALYSIS');
    expect(p).toContain('**Incident:** <the same incident name as the title>');
  });

  // The card measures the outage window from UptimeRobot downtime and configures the
  // platform's name and URLs, so the model reproduces them rather than deriving a
  // wider window or guessing a name.
  it('carries the measured period, services and title verbatim when given', () => {
    const p = bizPrompt('', {
      incidentPeriod: '2026-07-29 16:00 SGT \u2192 2026-07-29 17:23 SGT',
      servicesAffected: 'https://mims-cpd.com',
      reportTitle: 'MIMS CPD Downtime',
    });
    expect(p).toContain('**Incident Period:** 2026-07-29 16:00 SGT \u2192 2026-07-29 17:23 SGT');
    expect(p).toMatch(/MEASURED outage/);
    expect(p).toMatch(/Do not recompute or round it/);
    expect(p).toContain('**Services Affected:** https://mims-cpd.com');
    expect(p).toContain('Use this exact title: "MIMS CPD Downtime"');
  });

  // Without them the prompt still has to keep the period off the whole window.
  it('falls back to the confirmed downtime intervals, not the telemetry window', () => {
    const p = bizPrompt();
    expect(p).toMatch(/confirmed downtime intervals in the telemetry, not the whole window/);
    expect(p).toMatch(/names the incident in business terms/);
    expect(p).not.toMatch(/Use this exact title/);
  });
});

// The Tracker is the record that closes the business report. It used to be the engineer's
// alone; the generated run now drafts it, so the prompt has to ask for it — and has to say
// that anything the engineer already wrote is reproduced rather than rewritten.
describe('buildRcaPrompt - tracker section', () => {
  const biz = (notes = '') => buildRcaPrompt(render(makeData()), notes, { format: 'business' });

  it('asks for the Tracker heading and all five labelled fields', () => {
    const p = biz();
    expect(p).toContain('## Tracker');
    for (const label of [
      'Detection / Symptoms', 'Root Cause Identified', 'Corrective Action Taken',
      'Preventive / Improvement Action', 'Measurable Outcome',
    ]) {
      expect(p).toContain(label);
    }
  });

  it('forbids the tracker introducing anything the report did not establish', () => {
    expect(biz()).toMatch(/must not introduce a cause, an action or a figure that appears nowhere above it/);
    expect(biz()).toMatch(/not established/);
  });

  it('tells the model to reproduce the analyst\'s own tracker wording', () => {
    expect(biz()).toMatch(/reproduce their wording for that field and do not rewrite it/);
  });

  it('does not ask the engineering layout for a tracker', () => {
    expect(buildRcaPrompt(render(makeData()), '')).not.toContain('## Tracker');
  });
});

describe('reportFilename', () => {
  const start = Date.UTC(2026, 10, 6, 5, 0); // 13:00 SGT
  const end = Date.UTC(2026, 10, 6, 7, 0);   // 15:00 SGT

  it('defaults to the rca- prefix', () => {
    expect(handler._reportFilename(undefined, 'prdmeduapp', start, end, 'md')).toBe('rca-prdmeduapp-202611061300-202611061500.md');
  });

  it('keeps an investigation report apart from the RCA for the same window', () => {
    expect(handler._reportFilename('investigation', 'prdmeduapp', start, end, 'pdf')).toBe('investigation-prdmeduapp-202611061300-202611061500.pdf');
  });

  it('names an RCA by its incident number and the app\'s configured suffix', () => {
    const name = (n) => handler._reportFilename('rca', 'prdmeduapp', start, end, 'pdf', n);
    expect(name({ incidentNumber: 'INC-202611-004', suffix: 'MIMS-CPD' })).toBe('INC-202611-004 (MIMS-CPD).pdf');
    expect(name({ incidentNumber: 'INC-202611-004', suffix: '  ' })).toBe('INC-202611-004.pdf');
    expect(handler._reportFilename(undefined, 'a', start, end, 'doc', { incidentNumber: 'INC-1', suffix: 'MIMS-MSP' })).toBe('INC-1 (MIMS-MSP).doc');
  });

  it('falls back to the window-based name when there is no incident number, and never renames an investigation report', () => {
    expect(handler._reportFilename('rca', 'prdmeduapp', start, end, 'md', { incidentNumber: '', suffix: 'MIMS-CPD' })).toBe('rca-prdmeduapp-202611061300-202611061500.md');
    expect(handler._reportFilename('rca', 'prdmeduapp', start, end, 'md', { incidentNumber: '—', suffix: 'X' })).toBe('rca-prdmeduapp-202611061300-202611061500.md');
    expect(handler._reportFilename('investigation', 'prdmeduapp', start, end, 'md', { incidentNumber: 'INC-1', suffix: 'MIMS-CPD' })).toBe('investigation-prdmeduapp-202611061300-202611061500.md');
  });

  it('never lets the incident number or suffix steer the path', () => {
    const name = handler._reportFilename('rca', 'a', start, end, 'pdf', { incidentNumber: '..\\..\\evil/INC-9', suffix: '../x)(' });
    expect(name).not.toMatch(/[\\/]/);
    expect(name.startsWith('.')).toBe(false);
    expect(name).toBe('evilINC-9 (x).pdf');
  });

  it('never lets kind or appName steer the path', () => {
    expect(handler._reportFilename('../../x', 'a', start, end, 'md')).toMatch(/^rca-a-/);
    const name = handler._reportFilename('rca', '..\\..\\evil/../x', start, end, 'md');
    expect(name).not.toMatch(/[\\/]/);
    expect(name.startsWith('rca-.')).toBe(false);
  });
});

describe('rcaReportMarkdown', () => {
  const stages = [];
  const stage = (s) => stages.push(s);

  it('uses a report App Investigation already collected, without touching Azure', async () => {
    stages.length = 0;
    const collect = () => { throw new Error('must not collect'); };
    const md = await handler._rcaReportMarkdown({ reportMarkdown: '## Already here' }, stage, collect);
    expect(md).toBe('## Already here');
    expect(stages.join(' ')).not.toMatch(/Authenticating/);
  });

  it('collects as before when no report is supplied', async () => {
    stages.length = 0;
    let called = 0;
    const collect = async () => { called++; return { data: {}, anomaly: null, hasAppInsights: false, apiData: null, apiName: null }; };
    const md = await handler._rcaReportMarkdown({ appName: 'a', resourceGroup: 'rg', startMs: 0, endMs: 3600000, reportMarkdown: '   ' }, stage, collect).catch(e => e);
    expect(called).toBe(1);
    expect(stages[0]).toMatch(/Authenticating/);
    void md;
  });

  it('uses the episodes the page charts instead of the report\'s own', async () => {
    const data = makeData();
    data.episodes = [{ startT: '2026-11-10T09:05:00Z', endT: '2026-11-10T09:05:00Z', peakSeverity: 'Warning', bucketCount: 1, metricsInvolved: ['API 5xx'], peakValues: { 'API 5xx': 0.1 }, incidentType: 'noise' }];
    const collect = async () => ({ data, anomaly: computeAnomalyScore(data), hasAppInsights: true, apiData: null, apiName: null });
    const md = await handler._rcaReportMarkdown({
      appName: 'a', resourceGroup: 'rg', startMs: Date.parse('2026-11-10T11:00:00Z'), endMs: Date.parse('2026-11-10T13:00:00Z'),
      episodes: [{ startT: '2026-11-10T12:00:00Z', endT: '2026-11-10T12:20:00Z', peakSeverity: 'Critical', bucketCount: 21, metricsInvolved: ['CPU', 'API 5xx'], peakValues: { CPU: 99, 'API 5xx': 13.6 }, incidentType: 'API errors under app CPU pressure' }],
    }, () => {}, collect);
    expect(md).toContain('| 2026-11-10 20:00 SGT | 2026-11-10 20:20 SGT | Critical | 21 | CPU 99.0%, API 5xx 13.6% |');
    expect(md).not.toContain('noise');
  });
});

describe('SNAT ports section', () => {
  const pt = (t, count) => ({ t, count });
  const snat = (failed) => ({
    charts: [
      { title: 'SNAT port usage for TCP protocol', series: [
        { name: 'wn0a (TCP_Used)', series: [pt('2026-11-01T06:00:00Z', 30), pt('2026-11-01T06:05:00Z', 120)] },
        { name: 'wn0a (TCP_Allocated)', series: [pt('2026-11-01T06:00:00Z', 128)] },
      ] },
      { title: 'Pending SNAT connections', series: [{ name: 'wn0a', series: [pt('2026-11-01T06:05:00Z', 4)] }] },
      { title: 'Failed SNAT connections', series: [{ name: 'wn0a', series: failed }] },
      { title: 'New SNAT connections established', series: [] },
    ],
  });

  it('flags failed SNAT connections with the first-seen time and per-instance peaks', () => {
    const md = siteSnatSection({ snat: snat([pt('2026-11-01T06:05:00Z', 3), pt('2026-11-01T06:10:00Z', 9)]) }, 'Frontend');
    expect(md).toContain('### Frontend');
    expect(md).toContain('| wn0a | 120 | 128 |');
    expect(md).toContain('Failed SNAT connections | 12 | 9 |');
    expect(md).toContain('12 failed SNAT connections with port use at 94% of the allocation: outbound ports were close to exhausted.');
  });

  // 10 Nov, medu: 2 failed at 136 of 256 ports. "Ports ran out" there sent the agent the wrong way.
  it('does not call failures at low port use exhaustion', () => {
    const low = snat([pt('2026-11-01T06:10:00Z', 2)]);
    low.charts[0].series[0].series = [pt('2026-11-01T06:05:00Z', 136)];
    low.charts[0].series[1].series = [pt('2026-11-01T06:05:00Z', 256)];
    const md = siteSnatSection({ snat: low }, 'Frontend');
    expect(md).toContain('2 failed SNAT connections, but port use peaked at only 53% of the allocation, so this is not port exhaustion');
    expect(md).not.toMatch(/exhausted/);
  });

  it('says none when nothing failed, and warns when usage neared the allocation', () => {
    const md = siteSnatSection({ snat: snat([pt('2026-11-01T06:05:00Z', 0)]) }, 'API');
    expect(md).toContain('No failed SNAT connections in the window, but port use reached 94% of the allocation on an instance');
    expect(md).not.toMatch(/exhaust/);
  });

  it('prints a shared plan\'s SNAT pool once, telling the reader not to add the API\'s copy', () => {
    const ev = { snat: snat([pt('2026-11-01T06:05:00Z', 1)]) };
    const shared = siteSnatReport({ fe: ev, api: ev, sharedPlan: true });
    expect(shared.match(/\| wn0a \| 120 \| 128 \|/g)).toHaveLength(1);
    expect(shared).toContain('### API\n\nSame App Service plan as the frontend');
    const separate = siteSnatReport({ fe: ev, api: ev, sharedPlan: false });
    expect(separate.match(/\| wn0a \| 120 \| 128 \|/g)).toHaveLength(2);
  });

  it('is unknown, not none, without detector data, and empty when the site was not fetched', () => {
    expect(siteSnatSection({ snat: null }, 'API')).toContain('unknown (not "none")');
    expect(siteSnatSection(null, 'API')).toBe('');
  });
});

describe('baseline comparison', () => {
  const H = 3600_000, D = 24 * H;
  const start = Date.parse('2026-11-10T11:00:00Z');

  it('compares with a day and a week earlier only when they cannot overlap the window', () => {
    expect(baselinePeriods(start, start + 2 * H).map(p => p.key)).toEqual(['now', 'day', 'week']);
    expect(baselinePeriods(start, start + 2 * D).map(p => p.key)).toEqual(['now', 'week']);
    expect(baselinePeriods(start, start + 8 * D).map(p => p.key)).toEqual(['now']);
    expect(baselinePeriods(start, start + 2 * H)[1]).toMatchObject({ startMs: start - D, endMs: start + 2 * H - D });
  });

  it('shows each metric against the same clock time earlier, with how many times higher now is', () => {
    const md = baselineSection([
      { key: 'now', label: 'This window', startMs: start, requests: 120000, fiveXx: 4407, p95: 1200, exceptions: 4482, depFailed: 900 },
      { key: 'day', label: 'Day before', startMs: start - D, requests: 100000, fiveXx: 20, p95: 300, exceptions: 0, depFailed: 900 },
    ]);
    expect(md).toContain('## Compared With Normal');
    expect(md).toContain('| Metric | This window (2026-11-10 19:00 SGT) | Day before (2026-11-09 19:00 SGT) |');
    expect(md).toContain('| Requests | 120,000 | 100,000 (now ×1.2) |');
    expect(md).toContain('| 5xx | 4,407 (3.67%) | 20 (0.02%) (now ×220) |');
    expect(md).toContain('| Exceptions | 4,482 | 0 (new) |');
    expect(md).toContain('| Failed dependency calls | 900 | 900 (same) |');
  });

  it('is empty without a baseline, and marks an unknown figure instead of zero', () => {
    expect(baselineSection(null)).toBe('');
    expect(baselineSection([{ key: 'now', label: 'This window', startMs: start, requests: 1, fiveXx: 0, p95: null, exceptions: null, depFailed: null }])).toBe('');
    const md = baselineSection([
      { key: 'now', label: 'This window', startMs: start, requests: 10, fiveXx: 0, p95: null, exceptions: null, depFailed: 3 },
      { key: 'week', label: 'Week before', startMs: start - 7 * D, requests: 10, fiveXx: 0, p95: null, exceptions: null, depFailed: 1 },
    ]);
    expect(md).toContain('| Exceptions | — | — |');
    expect(md).toContain('| Failed dependency calls | 3 | 1 (now ×3.0) |');
  });
});

describe('anomaly episodes section', () => {
  it('lists each episode with its peaks and likely type, and says none when there are none', () => {
    const md = anomalyEpisodesSection([{
      startT: '2026-11-10T12:00:00Z', endT: '2026-11-10T12:10:00Z', peakSeverity: 'Critical', bucketCount: 3,
      metricsInvolved: ['CPU', 'API 5xx'], peakValues: { CPU: 99, 'API 5xx': 13.6 }, incidentType: 'API errors under app CPU pressure',
    }]);
    expect(md).toContain('## Anomaly Episodes');
    expect(md).toContain('| 2026-11-10 20:00 SGT | 2026-11-10 20:10 SGT | Critical | 3 | CPU 99.0%, API 5xx 13.6% | API errors under app CPU pressure |');
    expect(anomalyEpisodesSection([])).toContain('No Warning or Critical episode in this window.');
    expect(anomalyEpisodesSection(undefined)).toBe('');
  });
});
