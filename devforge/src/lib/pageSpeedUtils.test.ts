import { describe, it, expect } from 'vitest';
import type { PageSpeedConfiguration, PageSpeedInsightResult, PageSpeedMetrics } from '@shared/types/pageSpeedInsight.types';
import { absoluteChange, zeroBaseline, zeroBaselineFloor, allRunsFailed, defaultPageSpeedConfiguration, describePageSpeedTestEnvironment, aggregateValues, excessOverTargets, findDegradingRuns, displayPageSpeedAudit, improvementPercent, resultHasError, mapUrlsToPreviousIndexes, realignIndexSet, realignIndexedRecord, realignSlots, type ComparableMetricKey } from './pageSpeedUtils';

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

    it('is 0 when both runs measured zero — nothing changed', () => {
        expect(improvementPercent(measured(0, '0'), measured(0, '0.000'))).toBe(0);
    });

    it('measures a rise from a zero baseline against the "good" threshold, not against nothing', () => {
        // CLS: 0.004 is 4% of 0.1.
        expect(improvementPercent(measured(0, '0'), measured(0.004, '0.004'))).toBeCloseTo(-4);
        expect(improvementPercent(measured(0, '0.000'), measured(0.001, '0.001'))).toBeCloseTo(-1);
        // TBT: 50 ms is 25% of 200 ms; 300 ms goes past it.
        const ms = (v: number, d: string): PageSpeedMetrics => ({ numericValue: v, displayValue: d, numericUnit: 'millisecond' });
        expect(improvementPercent(ms(0, '0 ms'), ms(50, '50 ms'))).toBeCloseTo(-25);
        expect(improvementPercent(ms(0, '0 ms'), ms(300, '300 ms'))).toBeCloseTo(-150);
        expect(zeroBaselineFloor(measured(0, '0')).value).toBe(0.1);
        expect(zeroBaselineFloor(ms(0, '0 ms')).value).toBe(200);
        expect(zeroBaseline(measured(0, '0.000'), measured(0.001, '0.001'))).toBe(true);
        expect(zeroBaseline(measured(0, '0'), measured(0, '0.000'))).toBe(false);
        expect(zeroBaseline(measured(0.1, '0.1'), measured(0.2, '0.2'))).toBe(false);
    });

    it('falls back to the raw value when the displayed one is not a number', () => {
        expect(improvementPercent(measured(200, 'n/a'), measured(100, 'n/a'))).toBe(50);
    });
});

// The After runs to blame for a negative Improvement: the fewest worst runs whose
// removal brings the After score back to the Before score.
describe('findDegradingRuns', () => {
    const si = (sec: number) => m(sec * 1000, `${sec.toFixed(1)} s`);
    const lcp = (sec: number) => run({ largestContentfulPaint: m(sec * 1000, `${sec.toFixed(1)} s`) });
    const slotSI = (secs: number[], shown: number): PageSpeedInsightResult =>
        ({ ...run({ speedIndex: si(shown) }), runHistory: secs.map(v => run({ speedIndex: si(v) })) });
    const slotLCP = (secs: number[], shown: number): PageSpeedInsightResult =>
        ({ ...lcp(shown), runHistory: secs.map(lcp) });
    const SI: ComparableMetricKey[] = ['speedIndex'];
    const LCP: ComparableMetricKey[] = ['largestContentfulPaint'];

    it('flags the outlier runs behind an average regression (screenshot 1: SI 1.2 s → 1.7 s)', () => {
        const before = slotSI([1.2, 1.0, 1.1, 0.9, 1.1, 1.1, 2.1], 1.2);
        const after = slotSI([3.5, 2.6, 0.9, 0.9, 1.0, 1.1, 1.9], 1.7);
        const found = findDegradingRuns(before, after, SI);
        expect([...found.speedIndex!.runs]).toEqual([0, 1]);
        expect(found.speedIndex!.target.displayValue).toBe('1.2 s');
        expect(found.speedIndex!.without).toBeCloseTo(1160);
    });

    it('flags runs inside the Before range when more of them land slow (screenshot 2: LCP 9.6 s → 12.7 s)', () => {
        // Before: 3 of 7 runs slow (16.9–18.3 s). After: 5 of 7 slow, none slower than 18.3 s.
        const before = slotLCP([2.6, 16.9, 16.9, 2.9, 18.3, 6.9, 2.6], 9.6);
        const after = slotLCP([15.8, 15.8, 2.7, 16.5, 17.6, 3.0, 17.5], 12.7);
        const found = findDegradingRuns(before, after, LCP);
        expect([...found.largestContentfulPaint!.runs].sort()).toEqual([3, 4, 6]);
        expect(found.largestContentfulPaint!.without).toBeLessThanOrEqual(9600);
    });

    it('uses the median rule when the row is median-aggregated', () => {
        const before = slotLCP([2.6, 16.9, 16.9, 2.9, 18.3, 6.9, 2.6], 6.9);
        const after = slotLCP([15.8, 15.8, 2.7, 16.5, 17.6, 3.0, 17.5], 15.8);
        const found = findDegradingRuns(before, after, LCP, 'median');
        // Dropping 17.6, 17.5, 16.5 and one 15.8 leaves 2.7, 3.0, 15.8 → median 3.0 s.
        expect(found.largestContentfulPaint!.runs.size).toBe(4);
        expect(found.largestContentfulPaint!.without).toBe(3000);
    });

    it('flags nothing when the metric did not regress', () => {
        expect(findDegradingRuns(slotSI([1.0, 1.2], 1.1), slotSI([0.9, 1.1], 1.0), SI)).toEqual({});
    });

    it('always keeps one run, so a uniformly slower row flags all but its best run', () => {
        const found = findDegradingRuns(slotSI([1.0, 1.0, 1.0], 1.0), slotSI([2.0, 2.2, 2.1], 2.1), SI);
        expect([...found.speedIndex!.runs].sort()).toEqual([1, 2]);
    });

    it('never flags a run that is no worse than the Before score', () => {
        // Removing #2 (0.8 s) would RAISE the average, so it is never a candidate.
        const found = findDegradingRuns(slotSI([1.0, 1.0, 1.0], 1.0), slotSI([1.4, 0.8, 1.2], 1.1), SI);
        expect([...found.speedIndex!.runs].sort()).toEqual([0]);
    });

    it('ignores errored runs', () => {
        const failed = { ...run({ speedIndex: si(9.9) }), errorResponse: { code: 500, message: 'boom' } };
        const after = { ...run({ speedIndex: si(1.5) }), runHistory: [failed, run({ speedIndex: si(1.5) }), run({ speedIndex: si(1.0) })] };
        expect([...findDegradingRuns(slotSI([1.0, 1.2], 1.1), after, SI).speedIndex!.runs]).toEqual([1]);
    });

    it('treats a Lighthouse "0.6\u00a0s" run and a "0.6 s" score as a tie', () => {
        const lcpAt = (ms: number, display: string) => run({ largestContentfulPaint: m(ms, display) });
        const before = { ...lcpAt(610, '0.6 s'), runHistory: [lcpAt(610, '0.6 s')] };
        const after = { ...lcpAt(660, '0.7 s'), runHistory: [lcpAt(630, '0.6\u00a0s'), lcpAt(700, '0.7\u00a0s')] };
        expect([...findDegradingRuns(before, after, LCP).largestContentfulPaint!.runs]).toEqual([1]);
    });

    it('returns nothing without a Before result or an After run history', () => {
        expect(findDegradingRuns(undefined, slotSI([3.0], 3.0), SI)).toEqual({});
        expect(findDegradingRuns(slotSI([1.0], 1.0), run({ speedIndex: si(3.0) }), SI)).toEqual({});
    });

    it('only examines the requested metrics', () => {
        expect(findDegradingRuns(slotSI([1.0, 1.0], 1.0), slotSI([3.5, 2.6], 3.0), LCP)).toEqual({});
    });
});

describe('aggregateValues', () => {
    it('averages or takes the median, the same rule as the aggregate row', () => {
        expect(aggregateValues([1, 2, 6], 'average')).toBe(3);
        expect(aggregateValues([1, 2, 6], 'median')).toBe(2);
        expect(aggregateValues([1, 2, 3, 6], 'median')).toBe(2.5);
        expect(aggregateValues([], 'average')).toBe(0);
    });
});

// Re-audit keeps a fresh run only when it sits closer to the Before scores; 0 = no worse.
describe('excessOverTargets', () => {
    const targets = { speedIndex: m(2000, '2.0 s'), largestContentfulPaint: m(1000, '1.0 s') };
    const keys: ComparableMetricKey[] = ['speedIndex', 'largestContentfulPaint'];

    it('is 0 for a run no worse than the targets', () => {
        expect(excessOverTargets(run({ speedIndex: m(1500, '1.5 s'), largestContentfulPaint: m(1000, '1.0 s') }), targets, keys)).toBe(0);
    });

    it('sums the overshoot of each metric as a fraction of its target', () => {
        const r = run({ speedIndex: m(3000, '3.0 s'), largestContentfulPaint: m(1200, '1.2 s') });
        expect(excessOverTargets(r, targets, keys)).toBeCloseTo(0.5 + 0.2);
    });

    it('treats a value that displays the same as the target as no worse', () => {
        expect(excessOverTargets(run({ speedIndex: m(2040, '2.0 s'), largestContentfulPaint: m(900, '0.9 s') }), targets, keys)).toBe(0);
    });

    it('treats a run CLS of "0" and a "0.000" target as a tie', () => {
        const clsTarget = { cumulativeLayoutShift: m(0.0001, '0.000') };
        expect(excessOverTargets(run({ cumulativeLayoutShift: m(0.0002, '0') }), clsTarget, ['cumulativeLayoutShift'])).toBe(0);
    });

    it('ignores metrics without a target or that the run did not measure', () => {
        const r = run({ speedIndex: m(0, ''), largestContentfulPaint: m(900, '0.9 s'), totalBlockingTime: m(9000, '9,000 ms') });
        expect(excessOverTargets(r, targets, [...keys, 'totalBlockingTime'])).toBe(0);
    });

    it('is Infinity for an errored run', () => {
        const failed = { ...run(), errorResponse: { code: 500, message: 'boom' } };
        expect(excessOverTargets(failed, targets, keys)).toBe(Number.POSITIVE_INFINITY);
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

// A zero baseline has no percentage change, but the reader still needs a value.
describe('absoluteChange', () => {
    const cls = (v: number, d: string): PageSpeedMetrics => ({ numericValue: v, displayValue: d, numericUnit: 'unitless' });
    const ms = (v: number, d: string): PageSpeedMetrics => ({ numericValue: v, displayValue: d, numericUnit: 'millisecond' });

    it('reads CLS 0.000 → 0.001 as -0.001 (worse)', () => {
        expect(absoluteChange(cls(0, '0.000'), cls(0.001, '0.001'))).toEqual({ value: -0.001, text: '-0.001' });
    });

    it('uses + for better and formats timings in ms or s', () => {
        expect(absoluteChange(ms(0, '0 ms'), ms(50, '50 ms'))?.text).toBe('-50 ms');
        expect(absoluteChange(ms(1500, '1.5 s'), ms(0, '0 ms'))?.text).toBe('+1.5 s');
    });

    it('has no sign when nothing changed', () => {
        expect(absoluteChange(cls(0, '0'), cls(0, '0.000'))?.text).toBe('0.000');
    });

    it('is null when either side never measured the metric', () => {
        expect(absoluteChange(undefined, cls(0.001, '0.001'))).toBeNull();
        expect(absoluteChange(cls(0, '0'), { numericValue: 0, displayValue: '', numericUnit: '' })).toBeNull();
    });
});
