import { describe, it, expect } from 'vitest';
import { parseToPageSpeedInsightResult } from './pageSpeedAuditParser';

// Lighthouse's `checklist` detail type (and friends) hand back `items` as an
// object map, not an array. Capping must not assume an array — a throw here
// kills the whole run, not just the one audit.
describe('parseToPageSpeedInsightResult details capping', () => {
    const objectItems: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) objectItems[`check-${i}`] = { label: `Check ${i}`, value: true };

    it('survives non-array details.items', () => {
        const audits = {
            'some-insight': {
                title: 'Some insight',
                score: 0,
                scoreDisplayMode: 'metricSavings',
                details: { type: 'checklist', items: objectItems as never },
            },
        };

        const result = parseToPageSpeedInsightResult('https://example.com', audits);

        const audit = result.opportunities?.find(o => o.auditKey === 'some-insight');
        expect(audit).toBeDefined();
        expect(audit?.details?.items).toBe(objectItems);
        expect(audit?.details?.itemsTruncated).toBeUndefined();
    });

    it('still caps array details.items', () => {
        const items = Array.from({ length: 50 }, (_, i) => ({ transferSize: i }));
        const audits = {
            'network-requests': {
                title: 'Network requests',
                score: null,
                scoreDisplayMode: 'informative',
                details: { type: 'table', items },
            },
        };

        const result = parseToPageSpeedInsightResult('https://example.com', audits);
        const audit = result.opportunities?.find(o => o.auditKey === 'network-requests');

        expect(audit?.details?.items).toHaveLength(40);
        expect(audit?.details?.itemsTruncated).toBe(true);
        expect(audit?.details?.itemCount).toBe(50);
    });
});
