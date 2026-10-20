import { describe, expect, it } from 'vitest';
import type { PageSpeedInsightResult, PageSpeedOpportunity } from '@shared/types/pageSpeedInsight.types';
import { consolidateInsights, diffInsights, insightAmount, type InsightSet } from './pagespeed-insight-diff';

const opp = (auditKey: string, displayValue = '', score: number | null = 0.3): PageSpeedOpportunity =>
    ({ type: 'opportunity', auditKey, title: auditKey, displayValue, score });
const set = (...opportunities: PageSpeedOpportunity[]): InsightSet => ({ opportunities });
const LABELS = { before: 'v3.15.0', after: 'v3.16.0' };

describe('insightAmount', () => {
    it('reads time, size and count findings', () => {
        expect(insightAmount(opp('a', 'Est savings of 420 ms'))).toEqual({ value: 420, unit: 'ms' });
        expect(insightAmount(opp('a', 'Est savings of 1.2 s'))).toEqual({ value: 1200, unit: 'ms' });
        expect(insightAmount(opp('a', 'Est savings of 423 KiB'))).toEqual({ value: 423 * 1024, unit: 'bytes' });
        expect(insightAmount(opp('a', 'Est savings of 1,024 KiB'))).toEqual({ value: 1024 * 1024, unit: 'bytes' });
        expect(insightAmount(opp('a', '5 layout shifts found'))).toEqual({ value: 5, unit: 'count' });
    });

    it('is undefined without a number', () => {
        expect(insightAmount(opp('a', ''))).toBeUndefined();
        expect(insightAmount(opp('a', 'Avoid chaining critical requests'))).toBeUndefined();
    });
});

describe('diffInsights', () => {
    it('marks a finding After has but Before did not as NEW', () => {
        const d = diffInsights(set(opp('unused-css')), set(opp('unused-css'), opp('render-blocking')), LABELS);
        expect(d.after['render-blocking']).toEqual({ status: 'new', detail: 'New: not flagged in v3.15.0.' });
        expect(d.after['unused-css']).toBeUndefined();
    });

    it('counts a finding that was passing in Before as NEW once it fails', () => {
        const d = diffInsights(set(opp('lcp', '', 0.95)), set(opp('lcp', '', 0.4)), LABELS);
        expect(d.after.lcp?.status).toBe('new');
    });

    it('marks a clearly bigger saving as WORSE, but not run-to-run wobble', () => {
        const worse = diffInsights(set(opp('rb', 'Est savings of 180 ms')), set(opp('rb', 'Est savings of 420 ms')), LABELS);
        expect(worse.after.rb).toEqual({ status: 'worse', detail: 'Worse: Est savings of 420 ms (was Est savings of 180 ms in v3.15.0).' });
        const wobble = diffInsights(set(opp('rb', 'Est savings of 400 ms')), set(opp('rb', 'Est savings of 420 ms')), LABELS);
        expect(wobble.after.rb).toBeUndefined();
        const tiny = diffInsights(set(opp('js', 'Est savings of 3 KiB')), set(opp('js', 'Est savings of 5 KiB')), LABELS);
        expect(tiny.after.js).toBeUndefined();
    });

    it('marks more layout shifts as WORSE', () => {
        const d = diffInsights(set(opp('cls', '2 layout shifts found')), set(opp('cls', '5 layout shifts found')), LABELS);
        expect(d.after.cls?.status).toBe('worse');
    });

    it('falls back to the Lighthouse score when there is no amount', () => {
        const d = diffInsights(set(opp('tree', '', 0.5)), set(opp('tree', '', 0.2)), LABELS);
        expect(d.after.tree).toEqual({ status: 'worse', detail: 'Worse: Lighthouse score 20 (was 50 in v3.15.0).' });
    });

    it('marks a finding flagged in far more runs as WORSE', () => {
        const before: InsightSet = { opportunities: [opp('img')], occurrences: { img: { runs: [1, 2], total: 7 } } };
        const after: InsightSet = { opportunities: [opp('img')], occurrences: { img: { runs: [1, 2, 3, 4, 5, 6, 7], total: 7 } } };
        expect(diffInsights(before, after, LABELS).after.img?.detail).toBe('Worse: flagged in 7 of 7 runs (was 2 of 7 in v3.15.0).');
    });

    it('marks a Before finding After no longer has as FIXED', () => {
        const d = diffInsights(set(opp('legacy-js'), opp('unused-css')), set(opp('unused-css'), opp('legacy-js', '', 0.95)), LABELS);
        expect(d.before['legacy-js']).toEqual({ status: 'fixed', detail: 'Fixed: no longer flagged in v3.16.0.' });
        expect(d.before['unused-css']).toBeUndefined();
    });
});

describe('consolidateInsights', () => {
    const run = (...opportunities: PageSpeedOpportunity[]): PageSpeedInsightResult => ({ opportunities } as PageSpeedInsightResult);

    it('keeps the worst run per audit and counts the runs that flagged it', () => {
        const c = consolidateInsights([run(opp('a', '', 0.5)), run(opp('a', '', 0.2), opp('b')), run()]);
        expect(c.opportunities.map(o => [o.auditKey, o.score])).toEqual([['a', 0.2], ['b', 0.3]]);
        expect(c.occurrences).toEqual({ a: { runs: [1, 2], total: 3 }, b: { runs: [2], total: 3 } });
    });

    it('ignores diagnostics', () => {
        const diag = { ...opp('d'), type: 'diagnostic' as const };
        expect(consolidateInsights([run(diag)]).opportunities).toEqual([]);
    });
});
