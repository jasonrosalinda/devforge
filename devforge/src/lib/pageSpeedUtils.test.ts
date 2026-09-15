import { describe, it, expect } from 'vitest';
import type { PageSpeedInsightResult, PageSpeedMetrics } from '@shared/types/pageSpeedInsight.types';
import { compareRunToBaseline, findUnwinnableMetrics, mapUrlsToPreviousIndexes, realignIndexSet, realignIndexedRecord, realignSlots, type ComparableMetricKey } from './pageSpeedUtils';

const ALL: ComparableMetricKey[] = [
    'speedIndex', 'largestContentfulPaint', 'cumulativeLayoutShift', 'totalBlockingTime', 'firstContentfulPaint',
];

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

// The brute audit keeps re-running an After run until it beats the matching Before
// run on EVERY shown metric — this is the rule that decides when it stops.
describe('compareRunToBaseline', () => {
    it('wins only when every metric is better or equal and one is strictly better', () => {
        const baseline = run();
        const better = run({ speedIndex: m(1800), largestContentfulPaint: m(2500) });
        expect(compareRunToBaseline(better, baseline, ALL).wins).toBe(true);
    });

    it('does not win when a single metric regressed, however small', () => {
        const baseline = run();
        const mixed = run({ speedIndex: m(1000), totalBlockingTime: m(201) });
        expect(compareRunToBaseline(mixed, baseline, ALL).wins).toBe(false);
    });

    it('does not win on an exact tie — equal is not an improvement', () => {
        expect(compareRunToBaseline(run(), run(), ALL).wins).toBe(false);
    });

    it('ignores metrics the user has hidden', () => {
        const baseline = run();
        const slowerCls = run({ speedIndex: m(1500), cumulativeLayoutShift: m(0.9) });
        expect(compareRunToBaseline(slowerCls, baseline, ALL).wins).toBe(false);
        // With CLS switched off in the results columns, the same run wins.
        expect(compareRunToBaseline(slowerCls, baseline, ['speedIndex', 'largestContentfulPaint']).wins).toBe(true);
    });

    it('skips metrics the baseline never measured', () => {
        const baseline = run({ totalBlockingTime: m(0) });
        const candidate = run({ speedIndex: m(1900), totalBlockingTime: m(5000) });
        // TBT is unmeasured on the baseline, so a huge TBT cannot block the win.
        expect(compareRunToBaseline(candidate, baseline, ALL).wins).toBe(true);
    });

    it('reports no win when nothing could be compared', () => {
        const empty = run({
            speedIndex: m(0), largestContentfulPaint: m(0), cumulativeLayoutShift: m(0),
            totalBlockingTime: m(0), firstContentfulPaint: m(0),
        });
        const c = compareRunToBaseline(run(), empty, ALL);
        expect(c.wins).toBe(false);
        expect(c.ratio).toBe(Number.POSITIVE_INFINITY);
    });

    it('ranks near-misses so a losing brute still keeps its closest attempt', () => {
        const baseline = run();
        const oneBad = compareRunToBaseline(run({ speedIndex: m(2100) }), baseline, ALL);
        const threeBad = compareRunToBaseline(run({ speedIndex: m(2100), largestContentfulPaint: m(3300), totalBlockingTime: m(260) }), baseline, ALL);
        expect(oneBad.wins).toBe(false);
        expect(oneBad.notWorse).toBeGreaterThan(threeBad.notWorse);
        expect(oneBad.ratio).toBeLessThan(threeBad.ratio);
    });

    it('scores a uniformly faster run below 1 and a slower one above', () => {
        const baseline = run();
        expect(compareRunToBaseline(run({ speedIndex: m(1000), largestContentfulPaint: m(1500), cumulativeLayoutShift: m(0.05), totalBlockingTime: m(100), firstContentfulPaint: m(450) }), baseline, ALL).ratio).toBeCloseTo(0.5, 5);
        expect(compareRunToBaseline(run({ speedIndex: m(4000), largestContentfulPaint: m(6000), cumulativeLayoutShift: m(0.2), totalBlockingTime: m(400), firstContentfulPaint: m(1800) }), baseline, ALL).ratio).toBeCloseTo(2, 5);
    });
});

// Stops a brute audit from spending its whole budget proving that a genuine
// regression is genuine.
describe('findUnwinnableMetrics', () => {
    it('flags a metric that is worse and barely varies between runs', () => {
        // The real case: CLS 0.536/0.537/0.536 against a 0.484 baseline. Re-running
        // cannot close a 0.052 gap when the runs only move by 0.001.
        const baseline = run({ cumulativeLayoutShift: m(0.484) });
        const blockers = findUnwinnableMetrics({ cumulativeLayoutShift: [0.536, 0.537, 0.536] }, baseline, ALL);
        expect(blockers).toHaveLength(1);
        expect(blockers[0]?.key).toBe('cumulativeLayoutShift');
        expect(blockers[0]?.best).toBeCloseTo(0.536, 5);
        expect(blockers[0]?.spread).toBeCloseTo(0.001, 5);
    });

    it('does not flag a metric whose spread could still close the gap', () => {
        // LCP swinging 0.7 s–7.9 s is noise, not a verdict — one good run wins it.
        const baseline = run({ largestContentfulPaint: m(2000) });
        expect(findUnwinnableMetrics({ largestContentfulPaint: [2400, 7900, 2100] }, baseline, ALL)).toHaveLength(0);
    });

    it('does not flag a metric that is already beating the baseline', () => {
        const baseline = run({ speedIndex: m(2400) });
        expect(findUnwinnableMetrics({ speedIndex: [900, 1400, 1100] }, baseline, ALL)).toHaveLength(0);
    });

    it('flags a perfectly stable metric that is worse', () => {
        const baseline = run({ totalBlockingTime: m(100) });
        expect(findUnwinnableMetrics({ totalBlockingTime: [300, 300, 300] }, baseline, ALL)).toHaveLength(1);
    });

    it('withholds a verdict until there are enough samples', () => {
        const baseline = run({ cumulativeLayoutShift: m(0.484) });
        expect(findUnwinnableMetrics({ cumulativeLayoutShift: [0.536, 0.536] }, baseline, ALL)).toHaveLength(0);
    });

    it('ignores metrics the baseline never measured', () => {
        const baseline = run({ totalBlockingTime: m(0) });
        expect(findUnwinnableMetrics({ totalBlockingTime: [500, 500, 500] }, baseline, ALL)).toHaveLength(0);
    });

    it('reports every blocking metric, not just the first', () => {
        const baseline = run({ cumulativeLayoutShift: m(0.1), totalBlockingTime: m(100) });
        const blockers = findUnwinnableMetrics(
            { cumulativeLayoutShift: [0.5, 0.5, 0.5], totalBlockingTime: [400, 402, 401] },
            baseline,
            ALL,
        );
        expect(blockers.map(b => b.key).sort()).toEqual(['cumulativeLayoutShift', 'totalBlockingTime']);
    });
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
