import { describe, it, expect } from 'vitest';
import type { PageSpeedConfiguration, PageSpeedInsightResult, PageSpeedMetrics } from '@shared/types/pageSpeedInsight.types';
import { allRunsFailed, defaultPageSpeedConfiguration, describePageSpeedTestEnvironment, baselineExcess, findBaselineRuns, findDegradingRuns, displayPageSpeedAudit, improvementPercent, resultHasError, mapUrlsToPreviousIndexes, realignIndexSet, realignIndexedRecord, realignSlots, type ComparableMetricKey } from './pageSpeedUtils';

const m = (numericValue: number, displayValue = ''): PageSpeedMetrics => ({ numericValue, displayValue, numericUnit: 'millisecond' });

const run = (over: Partial<Record<ComparableMetricKey, PageSpeedMetrics>> = {}): PageSpeedInsightResult => ({
    url: 'https://example.com/',
    speedIndex: m(2000),
    largestContentfulPaint: m(3000),
    cumulativeLayoutShift: m(0.1),
    totalBlockingTime: m(200),
    firstContentfulPaint: m(900),
    ...over,
});

describe('mapUrlsToPreviousIndexes', () => {
    it('keeps every row aligned when a middle URL is removed', () => {
        const prev = ['https://a', 'https://b', 'https://c'];
        const next = ['https://a', 'https://c'];
        expect(mapUrlsToPreviousIndexes(prev, next)).toEqual([0, 2]);
    });

    it('marks appended URLs as having no previous slot', () => {
        expect(mapUrlsToPreviousIndexes(['https://a'], ['https://a', 'https://b'])).toEqual([0, -1]);
    });

    it('follows a reorder', () => {
        expect(mapUrlsToPreviousIndexes(['https://a', 'https://b'], ['https://b', 'https://a'])).toEqual([1, 0]);
    });

    it('gives each duplicate its own previous slot, then -1', () => {
        const prev = ['https://a', 'https://a'];
        const next = ['https://a', 'https://a', 'https://a'];
        expect(mapUrlsToPreviousIndexes(prev, next)).toEqual([0, 1, -1]);
    });

    it('is identity when nothing changed', () => {
        const urls = ['https://a', 'https://b'];
        expect(mapUrlsToPreviousIndexes(urls, urls)).toEqual([0, 1]);
    });
});

describe('realignSlots', () => {
    it('carries results across a removal instead of shifting them onto the wrong URL', () => {
        const slots = ['resA', 'resB', 'resC'];
        const map = mapUrlsToPreviousIndexes(['https://a', 'https://b', 'https://c'], ['https://a', 'https://c']);
        expect(realignSlots(slots, map)).toEqual(['resA', 'resC']);
    });

    it('leaves a brand-new URL unaudited', () => {
        expect(realignSlots(['resA'], [0, -1])).toEqual(['resA', undefined]);
    });
});

describe('realignIndexedRecord', () => {
    it('re-keys per-row records to the new positions', () => {
        const analyses = { 0: 'a', 1: 'b', 2: 'c' };
        expect(realignIndexedRecord(analyses, [0, 2])).toEqual({ 0: 'a', 1: 'c' });
    });

    it('drops entries whose row is gone', () => {
        expect(realignIndexedRecord({ 1: 'b' }, [0, 2])).toEqual({});
    });
});

describe('realignIndexSet', () => {
    it('moves expanded rows to their new index', () => {
        expect([...realignIndexSet(new Set([0, 2]), [0, 2])]).toEqual([0, 1]);
    });

    it('drops expanded rows that were removed', () => {
        expect([...realignIndexSet(new Set([1]), [0, 2])]).toEqual([]);
    });
});

// The rule that decides whether a finished audit counts as a failure — it drives
// both the "Audit failed." badge and the auto-retry loop, so a change here changes
// how many times a URL is re-audited.
describe('resultHasError', () => {
    it('is false for a clean result', () => {
        expect(resultHasError(run())).toBe(false);
    });

    it('is false for the empty error response a successful parse carries', () => {
        expect(resultHasError({ ...run(), errorResponse: { code: 0, message: '' } })).toBe(false);
    });

    it('is true when a message came back', () => {
        expect(resultHasError({ ...run(), errorResponse: { code: 0, message: 'Failed to fetch' } })).toBe(true);
    });

    it('is true when only a code came back', () => {
        expect(resultHasError({ ...run(), errorResponse: { code: 500, message: '' } })).toBe(true);
    });

    it('reads an array message, ignoring empty entries', () => {
        expect(resultHasError({ ...run(), errorResponse: { code: 0, message: ['', ''] } })).toBe(false);
        expect(resultHasError({ ...run(), errorResponse: { code: 0, message: ['', 'Failed to fetch'] } })).toBe(true);
    });
});

describe('allRunsFailed', () => {
    const failed = (msg = 'Failed to fetch') => ({ ...run(), errorResponse: { code: 0, message: msg } });

    it('is false for a clean result', () => {
        expect(allRunsFailed(run())).toBe(false);
    });

    it('is true when every run in the history errored', () => {
        expect(allRunsFailed({ ...failed(), runHistory: [failed(), failed()] })).toBe(true);
    });

    it('is false when one run survived — the aggregate is still usable', () => {
        expect(allRunsFailed({ ...failed(), runHistory: [failed(), run()] })).toBe(false);
    });

    it('falls back to the aggregate when there is no run history', () => {
        expect(allRunsFailed(failed())).toBe(true);
    });
});

// The Improvement column. A CLS of 0 is the best result a page can post, so the
// distinction these cover — "measured zero" vs "never measured" — is the difference
// between reading +100% and reading a dash.
describe('improvementPercent', () => {
    const measured = (numericValue: number, displayValue: string): PageSpeedMetrics =>
        ({ numericValue, displayValue, numericUnit: 'unitless' });
    const absent: PageSpeedMetrics = { numericValue: 0, displayValue: '', numericUnit: '' };

    it('reads a drop to a measured zero as a full improvement', () => {
        expect(improvementPercent(measured(0.004, '0.004'), measured(0, '0'))).toBe(100);
    });

    it('computes the percentage from the displayed value, not the raw one', () => {
        // Displayed "1.3 s" against "1.3 s" is 0%, even though the raw ms differ.
        expect(improvementPercent(measured(1340, '1.3'), measured(1290, '1.3'))).toBe(0);
    });

    it('is negative when the metric regressed', () => {
        expect(improvementPercent(measured(2, '2'), measured(3, '3'))).toBe(-50);
    });

    it('is null when the after run never measured the metric', () => {
        expect(improvementPercent(measured(2, '2'), absent)).toBeNull();
    });

    it('is null when the before run never measured the metric', () => {
        expect(improvementPercent(absent, measured(2, '2'))).toBeNull();
    });

    it('is null when either metric is missing entirely', () => {
        expect(improvementPercent(undefined, measured(2, '2'))).toBeNull();
        expect(improvementPercent(measured(2, '2'), undefined)).toBeNull();
    });

    it('is null when the baseline is zero — there is no percentage of nothing', () => {
        expect(improvementPercent(measured(0, '0'), measured(0, '0'))).toBeNull();
    });

    it('falls back to the raw value when the displayed one is not a number', () => {
        expect(improvementPercent(measured(200, 'n/a'), measured(100, 'n/a'))).toBe(50);
    });
});

// The baseline is per metric: SI's slowest Before run and LCP's can be different runs.
describe('findBaselineRuns', () => {
    it('picks the slowest Before run for each metric independently', () => {
        const before = {
            ...run(),
            runHistory: [
                run({ speedIndex: m(2100, '2.1 s'), largestContentfulPaint: m(500, '0.5 s') }),
                run({ speedIndex: m(1000, '1.0 s'), largestContentfulPaint: m(700, '0.7 s') }),
            ],
        };
        const found = findBaselineRuns(before, ['speedIndex', 'largestContentfulPaint']);
        expect(found.speedIndex!.runIndex).toBe(0);
        expect(found.largestContentfulPaint!.runIndex).toBe(1);
    });

    it('keeps the earliest run on a tie and skips errored or unmeasured runs', () => {
        const failed = { ...run({ speedIndex: m(9000, '9.0 s') }), errorResponse: { code: 500, message: 'boom' } };
        const unmeasured = run({ speedIndex: m(0, '') });
        const before = { ...run(), runHistory: [failed, unmeasured, run({ speedIndex: m(1500, '1.5 s') }), run({ speedIndex: m(1500, '1.5 s') })] };
        expect(findBaselineRuns(before, ['speedIndex']).speedIndex!.runIndex).toBe(2);
    });

    it('returns nothing without a Before result', () => {
        expect(findBaselineRuns(undefined, ['speedIndex'])).toEqual({});
    });
});

// The After runs to blame for a negative Improvement: those slower than every Before
// run. Mirrors the screenshot case — Before SI 0.9–2.1 s, After #1 3.5 s and #2 2.6 s.
describe('findDegradingRuns', () => {
    const si = (sec: number) => m(sec * 1000, `${sec.toFixed(1)} s`);
    const runsOf = (...values: number[]) => values.map(v => run({ speedIndex: si(v) }));
    const agg = (history: PageSpeedInsightResult[], avg: number): PageSpeedInsightResult =>
        ({ ...run({ speedIndex: si(avg) }), runHistory: history });
    const before = agg(runsOf(1.2, 1.0, 1.1, 0.9, 1.1, 1.1, 2.1), 1.2);
    const SI: ComparableMetricKey[] = ['speedIndex'];

    it('flags only the After runs above the slowest Before run', () => {
        const after = agg(runsOf(3.5, 2.6, 0.9, 0.9, 1.0, 1.1, 1.9), 1.7);
        const found = findDegradingRuns(before, after, SI);
        expect([...found.speedIndex!.runs]).toEqual([0, 1]);
        expect(found.speedIndex!.baseline).toMatchObject({ runIndex: 6, metric: { displayValue: '2.1 s' } });
    });

    it('flags nothing when the metric did not regress', () => {
        const after = agg(runsOf(3.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5), 1.0);
        expect(findDegradingRuns(before, after, SI)).toEqual({});
    });

    it('flags nothing when every After run stays inside the Before range', () => {
        const after = agg(runsOf(2.0, 1.9, 1.8), 1.9);
        expect(findDegradingRuns(before, after, SI)).toEqual({});
    });

    it('does not flag a run that displays the same as the ceiling', () => {
        const after = agg([run({ speedIndex: m(2140, '2.1 s') }), ...runsOf(3.0)], 2.6);
        expect([...findDegradingRuns(before, after, SI).speedIndex!.runs]).toEqual([1]);
    });

    it('ignores errored runs on both sides', () => {
        const failed = { ...run({ speedIndex: si(9.9) }), errorResponse: { code: 500, message: 'boom' } };
        const b = agg([...runsOf(1.0, 1.2), failed], 1.1);
        const after = agg([failed, ...runsOf(1.5)], 1.5);
        const found = findDegradingRuns(b, after, SI);
        expect(found.speedIndex!.baseline.metric.displayValue).toBe('1.2 s');
        expect([...found.speedIndex!.runs]).toEqual([1]);
    });

    it('uses a single-run Before as its own ceiling', () => {
        const after = agg(runsOf(1.0, 2.0), 1.5);
        expect([...findDegradingRuns(run({ speedIndex: si(1.2) }), after, SI).speedIndex!.runs]).toEqual([1]);
    });

    it('returns nothing without a Before result or an After run history', () => {
        expect(findDegradingRuns(undefined, agg(runsOf(3.0), 3.0), SI)).toEqual({});
        expect(findDegradingRuns(before, run({ speedIndex: si(3.0) }), SI)).toEqual({});
    });

    it('treats a Lighthouse "0.6 s" and a "0.6 s" baseline as a tie', () => {
        const lcp = (ms: number, display: string) => run({ largestContentfulPaint: m(ms, display) });
        const lcpBefore = lcp(610, '0.6 s');
        const lcpAfter = { ...lcp(660, '0.7 s'), runHistory: [lcp(630, '0.6 s'), lcp(700, '0.7 s')] };
        expect([...findDegradingRuns(lcpBefore, lcpAfter, ['largestContentfulPaint']).largestContentfulPaint!.runs]).toEqual([1]);
    });

    it('compares seconds and milliseconds on the same scale', () => {
        const tbt = (ms: number, display: string) => run({ totalBlockingTime: m(ms, display) });
        const tbtBefore = tbt(1000, '1.0 s');
        const tbtAfter = { ...tbt(1100, '1,100 ms'), runHistory: [tbt(990, '990 ms'), tbt(1200, '1,200 ms')] };
        expect([...findDegradingRuns(tbtBefore, tbtAfter, ['totalBlockingTime']).totalBlockingTime!.runs]).toEqual([1]);
    });

    it('only examines the requested metrics', () => {
        const after = agg(runsOf(3.5, 2.6), 3.0);
        expect(findDegradingRuns(before, after, ['largestContentfulPaint'])).toEqual({});
    });
});

// Re-audit keeps a fresh run only when it sits closer to the baselines; 0 = within.
describe('baselineExcess', () => {
    const baselines = {
        speedIndex: { runIndex: 6, metric: m(2000, '2.0 s') },
        largestContentfulPaint: { runIndex: 1, metric: m(1000, '1.0 s') },
    };
    const keys: ComparableMetricKey[] = ['speedIndex', 'largestContentfulPaint'];

    it('is 0 for a run within baseline on every metric', () => {
        expect(baselineExcess(run({ speedIndex: m(1500, '1.5 s'), largestContentfulPaint: m(1000, '1.0 s') }), baselines, keys)).toBe(0);
    });

    it('sums the overshoot of each metric as a fraction of its baseline', () => {
        const r = run({ speedIndex: m(3000, '3.0 s'), largestContentfulPaint: m(1200, '1.2 s') });
        expect(baselineExcess(r, baselines, keys)).toBeCloseTo(0.5 + 0.2);
    });

    it('treats a value that displays the same as the baseline as within it', () => {
        expect(baselineExcess(run({ speedIndex: m(2040, '2.0 s'), largestContentfulPaint: m(900, '0.9 s') }), baselines, keys)).toBe(0);
    });

    it('treats a run CLS of "0" and a "0.000" baseline as a tie', () => {
        const clsBaseline = { cumulativeLayoutShift: { runIndex: 0, metric: m(0.0001, '0.000') } };
        expect(baselineExcess(run({ cumulativeLayoutShift: m(0.0002, '0') }), clsBaseline, ['cumulativeLayoutShift'])).toBe(0);
        expect(baselineExcess(run({ cumulativeLayoutShift: m(0.02, '0.02') }), clsBaseline, ['cumulativeLayoutShift'])).toBeGreaterThan(0);
    });

    it('ignores metrics without a baseline or that the run did not measure', () => {
        const r = run({ speedIndex: m(0, ''), largestContentfulPaint: m(900, '0.9 s'), totalBlockingTime: m(9000, '9,000 ms') });
        expect(baselineExcess(r, baselines, [...keys, 'totalBlockingTime'])).toBe(0);
    });

    it('is Infinity for an errored run', () => {
        const failed = { ...run(), errorResponse: { code: 500, message: 'boom' } };
        expect(baselineExcess(failed, baselines, keys)).toBe(Number.POSITIVE_INFINITY);
    });
});

// Which columns the results table draws. "Before only" / "After only" exist so a
// comparison run can be presented as a single column without re-running it, and the
// enum is what makes hiding BOTH sides unrepresentable.
describe('displayPageSpeedAudit', () => {
    const cfg = (over: Partial<PageSpeedConfiguration> = {}): PageSpeedConfiguration =>
        ({ ...defaultPageSpeedConfiguration('desktop'), comparisonMode: true, showImprovement: true, ...over });

    it('draws both columns and the improvement by default', () => {
        const d = displayPageSpeedAudit(cfg());
        expect([d.before, d.after, d.improvement]).toEqual([true, true, true]);
    });

    it('drops the after column when showing before only', () => {
        const d = displayPageSpeedAudit(cfg({ comparisonColumns: 'before' }));
        expect([d.before, d.after]).toEqual([true, false]);
    });

    it('drops the before column when showing after only', () => {
        const d = displayPageSpeedAudit(cfg({ comparisonColumns: 'after' }));
        expect([d.before, d.after]).toEqual([false, true]);
    });

    it('hides the improvement when a side is hidden — a delta needs a visible baseline', () => {
        expect(displayPageSpeedAudit(cfg({ comparisonColumns: 'before' })).improvement).toBe(false);
        expect(displayPageSpeedAudit(cfg({ comparisonColumns: 'after' })).improvement).toBe(false);
    });

    it('ignores the setting outside comparison mode', () => {
        const d = displayPageSpeedAudit(cfg({ comparisonMode: false, comparisonColumns: 'before' }));
        expect([d.singleResult, d.before, d.after, d.improvement]).toEqual([true, false, false, false]);
    });

    it('still honours showImprovement being off', () => {
        expect(displayPageSpeedAudit(cfg({ showImprovement: false })).improvement).toBe(false);
    });
});

// PSI calibrates the mobile CPU slowdown to each host, so the header must read it
// from finished runs rather than assume Lighthouse's 4x default.
describe('describePageSpeedTestEnvironment', () => {
    const mobileEnv = (cpuSlowdownMultiplier: number, benchmarkIndex: number) => ({
        rttMs: 150, throughputKbps: 1638.4, cpuSlowdownMultiplier, benchmarkIndex,
        screenWidth: 412, screenHeight: 823, deviceScaleFactor: 1.75,
    });

    it('falls back to the presets before any run, without guessing the mobile CPU slowdown', () => {
        const { summary } = describePageSpeedTestEnvironment('mobile', []);
        expect(summary).toBe('Emulated Moto G Power · Slow 4G (150 ms RTT, 1.6 Mbps) · CPU slowdown set per host');
        expect(describePageSpeedTestEnvironment('desktop', [null]).summary)
            .toBe('Emulated Desktop · Custom throttling (40 ms RTT, 10 Mbps) · no CPU slowdown');
    });

    it('reports the CPU slowdown and host benchmark a run actually used', () => {
        const r = { ...run(), testEnvironment: mobileEnv(1.2, 157) };
        const { summary, detail } = describePageSpeedTestEnvironment('mobile', [r]);
        expect(summary).toContain('1.2x CPU slowdown');
        expect(detail).toContain('Host CPU/memory power (unthrottled): 157');
    });

    it('keeps the presets for fields the v5 API leaves out of configSettings', () => {
        const r = { ...run(), testEnvironment: { benchmarkIndex: 157 } };
        const { summary, detail } = describePageSpeedTestEnvironment('mobile', [r]);
        expect(summary).toBe('Emulated Moto G Power · Slow 4G (150 ms RTT, 1.6 Mbps) · CPU slowdown set per host');
        expect(detail).toContain('Screen 412×823 at 1.75x DPR');
        expect(detail).toContain('Host CPU/memory power (unthrottled): 157');
        expect(detail).not.toContain('?');
    });

    it('shows a range when runs landed on different hosts', () => {
        const agg = {
            ...run(),
            runHistory: [
                { ...run(), testEnvironment: mobileEnv(1.1, 170) },
                { ...run(), testEnvironment: mobileEnv(1.3, 140) },
            ],
        };
        const { summary, detail } = describePageSpeedTestEnvironment('mobile', [agg, false]);
        expect(summary).toContain('1.1–1.3x CPU slowdown');
        expect(detail).toContain('140–170');
    });
});
