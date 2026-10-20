import { describe, expect, it } from 'vitest';
import { teamsCopyHeader, urlLabels } from './pagespeed-teams-copy';

describe('urlLabels', () => {
    it('shows paths only when every URL shares one origin', () => {
        expect(urlLabels(['https://www.example.com/', 'https://www.example.com/a/b?x=1'])).toEqual({ host: 'www.example.com', labels: ['/', '/a/b?x=1'] });
    });

    it('keeps full URLs across origins or when a URL does not parse', () => {
        const mixed = ['https://a.example.com/x', 'https://b.example.com/y'];
        expect(urlLabels(mixed)).toEqual({ labels: mixed });
        expect(urlLabels(['not a url'])).toEqual({ labels: ['not a url'] });
        expect(urlLabels([])).toEqual({ labels: [] });
    });
});

describe('teamsCopyHeader', () => {
    const base = { comparison: true, soloLabel: '', beforeLabel: 'v3.15.0', afterLabel: 'v3.16.0', runs: 7, aggregation: 'average' as const, host: 'www.example.com' };

    it('names both labels and the run statistic with the host', () => {
        const h = teamsCopyHeader(base);
        expect(h.title).toBe('PageSpeed: v3.15.0 → v3.16.0');
        expect(h.subtitle).toBe('Average of 7 runs per URL · www.example.com');
        expect(h.plain).toBe('PageSpeed: v3.15.0 → v3.16.0\nAverage of 7 runs per URL · www.example.com');
    });

    it('adds the strategy for a per-strategy copy and handles median / single runs', () => {
        expect(teamsCopyHeader({ ...base, strategy: 'Desktop', aggregation: 'median' }).subtitle).toBe('Desktop · Median of 7 runs per URL · www.example.com');
        expect(teamsCopyHeader({ ...base, runs: 1, host: undefined }).subtitle).toBe('Single run per URL');
    });

    it('titles a one-side or plain audit without the arrow', () => {
        expect(teamsCopyHeader({ ...base, comparison: false, soloLabel: 'v3.16.0' }).title).toBe('PageSpeed: v3.16.0');
        expect(teamsCopyHeader({ ...base, comparison: false }).title).toBe('PageSpeed');
    });

    it('escapes labels in the HTML', () => {
        expect(teamsCopyHeader({ ...base, beforeLabel: '<b>x</b>' }).html).not.toContain('<b>x</b>');
    });
});
