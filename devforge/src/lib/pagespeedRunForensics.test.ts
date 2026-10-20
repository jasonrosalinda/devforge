import { describe, it, expect } from 'vitest';
import type { PageSpeedInsightResult, PageSpeedMetrics, PageSpeedOpportunity } from '@shared/types/pageSpeedInsight.types';
import { detectWarmUp, explainSpike, flaggedAfterRuns, isRunFlagged, metricVerdict, nextReauditRun, serverResponseMs } from './pagespeedRunForensics';

const m = (numericValue: number, displayValue: string): PageSpeedMetrics => ({ numericValue, displayValue, numericUnit: 'millisecond' });
const si = (sec: number) => m(sec * 1000, `${sec.toFixed(1)} s`);

const run = (sec: number, extra: Partial<PageSpeedInsightResult> = {}): PageSpeedInsightResult => ({
    url: 'https://example.com/',
    speedIndex: si(sec),
    largestContentfulPaint: m(600, '0.6 s'),
    cumulativeLayoutShift: m(0, '0'),
    totalBlockingTime: m(0, '0 ms'),
    firstContentfulPaint: m(500, '0.5 s'),
    ...extra,
});

const avg = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;
const slot = (runs: PageSpeedInsightResult[]): PageSpeedInsightResult => {
    const mean = avg(runs.map(r => r.speedIndex.numericValue)) / 1000;
    return { ...run(mean), runHistory: runs };
};
const slotOf = (...secs: number[]) => slot(secs.map(s => run(s)));

// The user's real case: SI −41.67 % driven by After #1 (3.5 s) and #2 (2.6 s).
const BEFORE = slotOf(1.2, 1.0, 1.1, 0.9, 1.1, 1.1, 2.1);
const AFTER = slotOf(3.5, 2.6, 0.9, 0.9, 1.0, 1.1, 1.9);

describe('metricVerdict', () => {
    it('calls the screenshot SI regression noise and shows the Improvement without the spikes', () => {
        const v = metricVerdict(BEFORE, AFTER, 'speedIndex', 'average');
        expect(v.verdict).toBe('noise');
        expect(v.slowerShare).toBeCloseTo(26 / 49);
        expect(v.pairs).toBe(49);
        expect(v.excluded).toEqual([0, 1]);
        // Before shows 1.2 s; the five kept After runs average 1.16 s.
        expect(v.trimmedImprovement).toBeCloseTo(((1.2 - 1.16) / 1.2) * 100);
    });

    it('calls a consistent slowdown a real regression — still worse without the flagged runs', () => {
        const v = metricVerdict(slotOf(1.0, 1.1, 1.0), slotOf(1.5, 1.6, 1.4), 'speedIndex', 'average');
        expect(v.verdict).toBe('regression');
        expect(v.slowerShare).toBe(1);
        expect(v.trimmedImprovement).toBeLessThan(0);
    });

    it('calls a consistent speed-up a real improvement', () => {
        expect(metricVerdict(slotOf(1.5, 1.6, 1.4), slotOf(1.0, 1.1, 1.0), 'speedIndex', 'average').verdict).toBe('improved');
    });

    it('needs at least 3 runs on each side', () => {
        expect(metricVerdict(slotOf(1.0, 1.1), slotOf(1.5, 1.6, 1.4), 'speedIndex', 'average').verdict).toBe('too-few');
        expect(metricVerdict(undefined, AFTER, 'speedIndex', 'average').verdict).toBe('too-few');
    });

    it('trims with the median when the row is median-aggregated (screenshot 2 LCP shape)', () => {
        const medianSlot = (secs: number[], shown: number) => ({ ...run(shown), runHistory: secs.map(v => run(v)) });
        const before = medianSlot([2.6, 16.9, 16.9, 2.9, 18.3, 6.9, 2.6], 6.9);
        const after = medianSlot([15.8, 15.8, 2.7, 16.5, 17.6, 3.0, 17.5], 15.8);
        const v = metricVerdict(before, after, 'speedIndex', 'median');
        // Four worst runs dropped; kept 2.7, 3.0, 15.8 → median 3.0 s.
        expect(v.excluded).toHaveLength(4);
        expect(v.trimmedImprovement).toBeCloseTo(((6.9 - 3.0) / 6.9) * 100);
    });

    it('leaves trimmedImprovement unset when nothing regressed', () => {
        expect(metricVerdict(slotOf(1.5, 1.6, 1.4), slotOf(1.0, 1.1, 1.0), 'speedIndex', 'average').trimmedImprovement).toBeUndefined();
    });
});

const audit = (auditKey: string, displayValue: string, details?: PageSpeedOpportunity['details']): PageSpeedOpportunity =>
    ({ type: 'diagnostic', auditKey, title: auditKey, displayValue, score: 0, ...(details ? { details } : {}) });

describe('serverResponseMs', () => {
    it('reads the root document time, with or without thousands separators', () => {
        expect(serverResponseMs(run(1, { opportunities: [audit('server-response-time', 'Root document took 1,820\u00a0ms')] }))).toBe(1820);
        expect(serverResponseMs(run(1, { passedAudits: [{ auditKey: 'server-response-time', title: 't', score: 1, displayValue: 'Root document took 120 ms' }] }))).toBe(120);
    });

    it('is undefined when the audit is missing or carries no number', () => {
        expect(serverResponseMs(run(1))).toBeUndefined();
        expect(serverResponseMs(run(1, { opportunities: [audit('server-response-time', 'n/a')] }))).toBeUndefined();
    });
});

describe('explainSpike', () => {
    const ttfb = (ms: number) => ({ passedAudits: [{ auditKey: 'server-response-time', title: 't', score: 1, displayValue: `Root document took ${ms} ms` }] });
    const machine = (benchmarkIndex: number) => ({ testEnvironment: { benchmarkIndex } });
    const kinds = (after: PageSpeedInsightResult, idx: number, flagged: number[]) => explainSpike(idx, after, flagged).map(c => c.kind);

    it('blames a slow server when the root document took far longer than usual', () => {
        const after = slot([run(3.5, ttfb(1900)), run(1.0, ttfb(300)), run(1.0, ttfb(320)), run(1.1, ttfb(310)), run(1.0, ttfb(290))]);
        expect(kinds(after, 0, [0])).toContain('slow-server');
    });

    it('does not blame the server for a small TTFB bump', () => {
        const after = slot([run(3.5, ttfb(500)), run(1.0, ttfb(300)), run(1.0, ttfb(320))]);
        expect(kinds(after, 0, [0])).not.toContain('slow-server');
    });

    it('blames the PSI machine when its benchmark is well below the others', () => {
        const after = slot([run(1.0, machine(1600)), run(1.0, machine(1650)), run(2.5, machine(900)), run(1.0, machine(1620))]);
        expect(kinds(after, 2, [2])).toEqual(['slow-machine']);
    });

    it('calls the leading block of spikes a warm-up', () => {
        expect(kinds(AFTER, 1, [0, 1])).toContain('warm-up');
        expect(kinds(AFTER, 6, [6])).not.toContain('warm-up');
    });

    it('points at the resource that made the page heavier', () => {
        const net = (items: Record<string, unknown>[]) => ({ opportunities: [audit('network-requests', '', { type: 'table', items })] });
        const base = [{ url: 'https://example.com/app.js', transferSize: 50_000 }];
        const heavy = [...base, { url: 'https://example.com/hero.jpg', transferSize: 900_000 }];
        const after = slot([run(1.0, net(base)), run(3.0, net(heavy)), run(1.0, net(base)), run(1.1, net(base))]);
        const causes = explainSpike(1, after, [1], 'https://example.com');
        expect(causes.map(c => c.kind)).toEqual(['heavier-page']);
        expect(causes[0]!.detail).toContain('/hero.jpg');
    });

    it('falls back to jitter when nothing stands out', () => {
        expect(kinds(slotOf(1.0, 1.0, 2.0, 1.1), 2, [2])).toEqual(['jitter']);
    });

    it('returns nothing for a run index that does not exist', () => {
        expect(explainSpike(9, AFTER, [9])).toEqual([]);
    });
});

describe('detectWarmUp / flaggedAfterRuns', () => {
    it('spots the screenshot pattern: runs #1–#2 slow, then steady', () => {
        expect(flaggedAfterRuns(BEFORE, AFTER, ['speedIndex'])).toEqual([0, 1]);
        expect(detectWarmUp(BEFORE, AFTER, ['speedIndex'])).toEqual({ runs: [0, 1] });
    });

    it('ignores spikes that do not start at run #1', () => {
        const later = slotOf(0.9, 1.0, 3.5, 2.6, 1.0, 1.1, 1.0);
        expect(detectWarmUp(BEFORE, later, ['speedIndex'])).toBeNull();
    });

    it('ignores a block covering more than half the runs — that is no warm-up', () => {
        const mostly = slotOf(3.5, 2.6, 2.9, 2.5, 1.0);
        expect(detectWarmUp(BEFORE, mostly, ['speedIndex'])).toBeNull();
    });

    it('returns null without flagged runs', () => {
        expect(detectWarmUp(BEFORE, slotOf(0.9, 1.0, 1.1), ['speedIndex'])).toBeNull();
    });
});

// Re-audit works through the flagged runs one at a time and must move on as soon as
// a run is no longer flagged — the bug was a cleared run still burning attempts.
describe('nextReauditRun / isRunFlagged', () => {
    const history = AFTER.runHistory!;
    const SI = ['speedIndex'] as const;

    it('starts with the first flagged run and the metrics it is flagged for', () => {
        expect(nextReauditRun(BEFORE, history, [...SI], 'average', new Set())).toEqual({ runIdx: 0, keys: ['speedIndex'] });
    });

    it('skips runs already attempted', () => {
        expect(nextReauditRun(BEFORE, history, [...SI], 'average', new Set([0]))?.runIdx).toBe(1);
        expect(nextReauditRun(BEFORE, history, [...SI], 'average', new Set([0, 1]))).toBeUndefined();
    });

    it('drops a run from the flagged set once a faster re-run replaces it', () => {
        expect(isRunFlagged(BEFORE, history, [...SI], 'average', 0)).toBe(true);
        const replaced = history.map((r, i) => (i === 0 ? run(1.0) : r));
        expect(isRunFlagged(BEFORE, replaced, [...SI], 'average', 0)).toBe(false);
    });

    it('stops once one replacement clears the whole row', () => {
        // Replacing #1 (3.5 s) with 0.9 s drops the average to 1.33 s; #2 alone is then the
        // only run still keeping it above 1.2 s.
        const replaced = history.map((r, i) => (i === 0 ? run(0.9) : r));
        expect(nextReauditRun(BEFORE, replaced, [...SI], 'average', new Set([0]))?.runIdx).toBe(1);
        const both = replaced.map((r, i) => (i === 1 ? run(0.9) : r));
        expect(nextReauditRun(BEFORE, both, [...SI], 'average', new Set([0]))).toBeUndefined();
    });

    it('has nothing to do for a single-run row', () => {
        expect(nextReauditRun(BEFORE, [run(5)], [...SI], 'average', new Set())).toBeUndefined();
    });
});
