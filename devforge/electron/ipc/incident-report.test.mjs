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
} = handler;

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
