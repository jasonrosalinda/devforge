// Shared pieces of "Copy for Teams": the two-line header and the page labels.
// Inline styles only — Teams drops most CSS on paste. Pure: no React, no clipboard.

import type { PageSpeedConfiguration } from '@shared/types/pageSpeedInsight.types';

const FONT = 'font-family:Segoe UI,Arial,sans-serif';

const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Paths only when every URL shares one origin — the host is shown once, in the header. */
export function urlLabels(urls: string[]): { host?: string | undefined; labels: string[] } {
    const parsed = urls.map(u => { try { return new URL(u); } catch { return undefined; } });
    const origins = new Set(parsed.map(p => p?.origin));
    if (parsed.length && origins.size === 1 && parsed[0]) {
        return { host: parsed[0].host, labels: parsed.map(p => `${p!.pathname}${p!.search}` || '/') };
    }
    return { labels: urls };
}

export interface TeamsCopyHeaderOptions {
    /** Before and After both shown. */
    comparison: boolean;
    /** The side a single-column copy shows; empty for a plain (non-comparison) audit. */
    soloLabel: string;
    beforeLabel: string;
    afterLabel: string;
    runs: number;
    aggregation: PageSpeedConfiguration['aggregation'];
    host?: string | undefined;
    /** e.g. "Desktop" for a per-strategy copy. */
    strategy?: string | undefined;
}

/**
 * "PageSpeed: v3.15.0 → v3.16.0" over "Average of 7 runs per URL · www.example.com".
 */
export function teamsCopyHeader(o: TeamsCopyHeaderOptions): { html: string; plain: string; title: string; subtitle: string } {
    const title = o.comparison
        ? `PageSpeed: ${o.beforeLabel} → ${o.afterLabel}`
        : `PageSpeed${o.soloLabel ? `: ${o.soloLabel}` : ''}`;
    const runs = o.runs > 1
        ? `${o.aggregation === 'median' ? 'Median' : 'Average'} of ${o.runs} runs per URL`
        : 'Single run per URL';
    const subtitle = [o.strategy, runs, o.host].filter(Boolean).join(' · ');
    return {
        title,
        subtitle,
        html: `<p style="${FONT};margin:0;font-size:15px;font-weight:700">${esc(title)}</p>`
            + `<p style="${FONT};margin:2px 0 8px;font-size:11px;color:#6b7280">${esc(subtitle)}</p>`,
        plain: `${title}\n${subtitle}`,
    };
}
