import { describe, it, expect } from 'vitest';
import type { PageSpeedInsightResult, PageSpeedMetrics } from '@shared/types/pageSpeedInsight.types';
import {
    buildEvidenceDiff,
    buildEvidenceDiffSection,
    collectAudits,
    diffAuditItems,
    normalizeResourceUrl,
    rankAuditDiff,
    representativeRun,
} from './pagespeedEvidenceDiff';

const metric = (numericValue: number, displayValue = ''): PageSpeedMetrics => ({
    displayValue, numericValue, numericUnit: 'millisecond',
});

const result = (over: Partial<PageSpeedInsightResult> = {}): PageSpeedInsightResult => ({
    url: 'https://example.com/',
    speedIndex: metric(1000),
    largestContentfulPaint: metric(3300, '3.3 s'),
    cumulativeLayoutShift: metric(0.1),
    totalBlockingTime: metric(200),
    firstContentfulPaint: metric(900),
    ...over,
});

describe('normalizeResourceUrl', () => {
    it('collapses webpack-style content hashes', () => {
        const a = normalizeResourceUrl('https://example.com/css/theme.9f2ab1a0.css');
        const b = normalizeResourceUrl('https://example.com/css/theme.7c04de11.css');
        expect(a.key).toBe(b.key);
        expect(a.fingerprinted).toBe(true);
    });

    it('collapses dash-separated and vite-style hashes', () => {
        expect(normalizeResourceUrl('https://x.test/main-4f3a2b1c.js').key)
            .toBe(normalizeResourceUrl('https://x.test/main-99887766.js').key);
        expect(normalizeResourceUrl('https://x.test/index.DkX9_2aA.js').key)
            .toBe(normalizeResourceUrl('https://x.test/index.Bq7z_1Pk.js').key);
    });

    it('collapses the next.js build id', () => {
        expect(normalizeResourceUrl('https://x.test/_next/static/aBcDeFgHiJkLmNoPq/page.js').key)
            .toBe('/_next/static/<build>/page.js');
    });

    it('drops query cache-busters and flags them', () => {
        const n = normalizeResourceUrl('https://example.com/app.js?v=12345');
        expect(n.key).toBe('/app.js');
        expect(n.fingerprinted).toBe(true);
    });

    it('keys third-party resources by host so they stay distinguishable', () => {
        const n = normalizeResourceUrl('https://googletagmanager.com/gtm.js', 'https://example.com');
        expect(n.thirdParty).toBe(true);
        expect(n.key).toBe('googletagmanager.com/gtm.js');
    });

    it('drops the origin for first-party so staging vs www still matches', () => {
        const staging = normalizeResourceUrl('https://sit.example.com/app.css', 'https://sit.example.com');
        const prod = normalizeResourceUrl('https://www.example.com/app.css', 'https://www.example.com');
        expect(staging.key).toBe(prod.key);
    });

    it('survives malformed input', () => {
        const n = normalizeResourceUrl('inline-script-1');
        expect(n.key).toBe('inline-script-1');
        expect(n.thirdParty).toBe(false);
    });
});

describe('collectAudits', () => {
    it('merges failing opportunities and passing audits into one universe', () => {
        const r = result({
            opportunities: [{ type: 'opportunity', auditKey: 'unused-javascript', title: 'Reduce unused JS', score: 0.2, metricSavings: { LCP: 300, TBT: 40 } }],
            passedAudits: [{ auditKey: 'uses-text-compression', title: 'Enable text compression', score: 1 }],
        });
        const map = collectAudits(r);
        expect(map.get('unused-javascript')?.passed).toBe(false);
        expect(map.get('uses-text-compression')?.passed).toBe(true);
        expect(map.size).toBe(2);
    });

    it('prefers overallSavingsMs over metricSavings for the savings figure', () => {
        const r = result({
            opportunities: [{
                type: 'opportunity', auditKey: 'render-blocking-resources', title: 'Eliminate render-blocking resources',
                score: 0.3, metricSavings: { FCP: 100 }, details: { type: 'opportunity', overallSavingsMs: 640 },
            }],
        });
        expect(collectAudits(r).get('render-blocking-resources')?.savingsMs).toBe(640);
    });
});

describe('representativeRun', () => {
    it('picks the run closest to the aggregate, not the last one', () => {
        const near = result({ largestContentfulPaint: metric(3250), fetchTime: 'near' });
        const far = result({ largestContentfulPaint: metric(9000), fetchTime: 'far' });
        const agg = result({ largestContentfulPaint: metric(3300), runHistory: [near, far] });
        expect(representativeRun(agg)?.fetchTime).toBe('near');
    });

    it('returns the result itself when there is no run history', () => {
        const r = result();
        expect(representativeRun(r)).toBe(r);
    });

    it('returns undefined for a missing result', () => {
        expect(representativeRun(undefined)).toBeUndefined();
    });
});

describe('diffAuditItems', () => {
    const details = (items: Record<string, unknown>[]) => ({ type: 'opportunity', items });

    it('reports added, removed and changed resources', () => {
        const rows = diffAuditItems(
            'render-blocking-resources',
            details([{ url: 'https://example.com/css/theme.aaaaaaaa.css', totalBytes: 42_000, wastedMs: 310 }]),
            details([
                { url: 'https://example.com/css/theme.bbbbbbbb.css', totalBytes: 42_000, wastedMs: 310 },
                { url: 'https://googletagmanager.com/gtm.js', totalBytes: 86_000, wastedMs: 330 },
            ]),
            { pageOrigin: 'https://example.com' },
        );
        const added = rows.find(r => r.key === 'googletagmanager.com/gtm.js');
        expect(added?.status).toBe('added');
        expect(added?.afterBytes).toBe(86_000);
        // The rebuilt stylesheet is the same resource and did not move — filtered out.
        expect(rows.find(r => r.key === '/css/theme.css')).toBeUndefined();
    });

    it('drops sub-threshold movement as noise', () => {
        const rows = diffAuditItems(
            'unused-javascript',
            details([{ url: 'https://example.com/a.js', wastedBytes: 100_000 }]),
            details([{ url: 'https://example.com/a.js', wastedBytes: 100_500 }]),
        );
        expect(rows).toHaveLength(0);
    });

    it('reads third-party entities in both the string and object shapes', () => {
        const older = diffAuditItems('third-party-summary', details([]), details([{ entity: 'Google Tag Manager', transferSize: 96_000, mainThreadTime: 375 }]));
        const newer = diffAuditItems('third-party-summary', details([]), details([{ entity: { type: 'link', text: 'Google Tag Manager' }, transferSize: 96_000, mainThreadTime: 375 }]));
        expect(older[0]?.key).toBe('Google Tag Manager');
        expect(newer[0]?.key).toBe('Google Tag Manager');
    });

    it('returns nothing for an audit with no reader', () => {
        expect(diffAuditItems('some-unknown-audit', details([{ url: 'https://x.test/a.js' }]), details([]))).toHaveLength(0);
    });
});

describe('rankAuditDiff', () => {
    const base = {
        auditKey: 'x', title: 'X', status: 'worsened' as const,
        affectedMetrics: ['LCP'], resources: [],
    };

    it('ranks an audit touching a regressed metric above one that does not', () => {
        const hot = rankAuditDiff(base, { regressedMetrics: ['LCP'] });
        const cold = rankAuditDiff(base, { regressedMetrics: ['CLS'] });
        expect(hot).toBeGreaterThan(cold);
    });

    it('ranks appeared above worsened above improved', () => {
        const at = (status: 'appeared' | 'worsened' | 'improved') => rankAuditDiff({ ...base, status });
        expect(at('appeared')).toBeGreaterThan(at('worsened'));
        expect(at('worsened')).toBeGreaterThan(at('improved'));
    });
});

describe('buildEvidenceDiff', () => {
    const before = result({
        opportunities: [
            { type: 'opportunity', auditKey: 'render-blocking-resources', title: 'Eliminate render-blocking resources', score: 0.5, metricSavings: { FCP: 310, LCP: 310 }, details: { type: 'opportunity', overallSavingsMs: 310, items: [{ url: 'https://example.com/css/theme.aaaaaaaa.css', totalBytes: 42_000, wastedMs: 310 }] } },
            { type: 'opportunity', auditKey: 'uses-text-compression', title: 'Enable text compression', score: 0.4, metricSavings: { LCP: 240 } },
        ],
        passedAudits: [{ auditKey: 'modern-image-formats', title: 'Serve images in next-gen formats', score: 1 }],
    });
    const after = result({
        largestContentfulPaint: metric(4100, '4.1 s'),
        opportunities: [
            { type: 'opportunity', auditKey: 'render-blocking-resources', title: 'Eliminate render-blocking resources', score: 0.2, metricSavings: { FCP: 640, LCP: 640 }, details: { type: 'opportunity', overallSavingsMs: 640, items: [{ url: 'https://example.com/css/theme.bbbbbbbb.css', totalBytes: 42_000, wastedMs: 310 }, { url: 'https://googletagmanager.com/gtm.js', totalBytes: 86_000, wastedMs: 330 }] } },
            { type: 'opportunity', auditKey: 'largest-contentful-paint-image-not-preloaded', title: 'Preload the LCP image', score: 0, metricSavings: { LCP: 690 } },
        ],
        passedAudits: [
            { auditKey: 'modern-image-formats', title: 'Serve images in next-gen formats', score: 1 },
            { auditKey: 'uses-text-compression', title: 'Enable text compression', score: 1 },
        ],
    });

    it('classifies appeared, worsened and resolved', () => {
        const diff = buildEvidenceDiff(before, after, { pageOrigin: 'https://example.com' });
        const byKey = Object.fromEntries(diff.audits.map(d => [d.auditKey, d.status]));
        expect(byKey['largest-contentful-paint-image-not-preloaded']).toBe('appeared');
        expect(byKey['render-blocking-resources']).toBe('worsened');
        expect(byKey['uses-text-compression']).toBe('resolved');
        // Passing on both sides with no resource churn — not worth the tokens.
        expect(byKey['modern-image-formats']).toBeUndefined();
    });

    it('puts the newly added third-party script under the worsened audit', () => {
        const diff = buildEvidenceDiff(before, after, { pageOrigin: 'https://example.com' });
        const blocking = diff.audits.find(d => d.auditKey === 'render-blocking-resources');
        expect(blocking?.resources.map(r => r.key)).toContain('googletagmanager.com/gtm.js');
        expect(blocking?.savingsDeltaMs).toBe(330);
    });

    it('ranks the LCP-regression evidence first when LCP is the regressed metric', () => {
        const diff = buildEvidenceDiff(before, after, { regressedMetrics: ['LCP'], pageOrigin: 'https://example.com' });
        expect(diff.audits[0]?.auditKey).toBe('largest-contentful-paint-image-not-preloaded');
    });

    it('flags a before result captured before passing audits were recorded', () => {
        const legacy = result({ opportunities: before.opportunities });
        expect(buildEvidenceDiff(legacy, after).legacyBefore).toBe(true);
        expect(buildEvidenceDiff(before, after).legacyBefore).toBe(false);
    });

    it('is order-stable for identical input', () => {
        const a = buildEvidenceDiff(before, after, { pageOrigin: 'https://example.com' });
        const b = buildEvidenceDiff(before, after, { pageOrigin: 'https://example.com' });
        expect(a.audits.map(d => d.auditKey)).toEqual(b.audits.map(d => d.auditKey));
    });

    it('detects an LCP element change', () => {
        const withLcp = (selector: string, label: string) => ({
            type: 'diagnostic' as const, auditKey: 'largest-contentful-paint-element',
            title: 'Largest Contentful Paint element', score: null,
            details: { type: 'table', items: [{ node: { selector, nodeLabel: label } }] },
        });
        const diff = buildEvidenceDiff(
            result({ opportunities: [withLcp('h1.headline', 'Trusted drug information')] }),
            result({ opportunities: [withLcp('img.hero-banner', 'hero')] }),
        );
        expect(diff.lcpElement?.changed).toBe(true);
        expect(diff.lcpElement?.afterSelector).toBe('img.hero-banner');
    });
});

describe('buildEvidenceDiffSection', () => {
    it('returns empty string when a side is missing', () => {
        expect(buildEvidenceDiffSection(undefined, result(), { before: 'A', after: 'B' })).toBe('');
        expect(buildEvidenceDiffSection(result(), undefined, { before: 'A', after: 'B' })).toBe('');
    });

    it('returns empty string when nothing changed', () => {
        const same = result({ passedAudits: [{ auditKey: 'uses-text-compression', title: 'Enable text compression', score: 1 }] });
        expect(buildEvidenceDiffSection(same, same, { before: 'A', after: 'B' })).toBe('');
    });

    it('respects the character budget', () => {
        const many = (n: number, size: number) => result({
            opportunities: Array.from({ length: n }, (_, i) => ({
                type: 'opportunity' as const, auditKey: `audit-${i}`, title: `Audit number ${i}`,
                score: 0.1, metricSavings: { LCP: size + i },
                details: { type: 'opportunity', items: Array.from({ length: 20 }, (_, j) => ({ url: `https://example.com/very/long/path/to/asset-${i}-${j}.js`, wastedBytes: 90_000 + j })) },
            })),
            passedAudits: [],
        });
        const section = buildEvidenceDiffSection(many(30, 100), many(30, 5000), { before: 'v1', after: 'v2' }, { maxChars: 3000 });
        expect(section.length).toBeLessThan(4200); // budget + the omitted-footer line
        expect(section).toContain('omitted');
    });
});
