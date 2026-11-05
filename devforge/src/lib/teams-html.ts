// Helpers for HTML pasted into Teams / Outlook / Word.
//
// Those paste paths drop most CSS — `table-layout`, `colgroup` widths, `word-break` —
// so a long URL is one unbreakable word and its column stretches to fit it all,
// pushing the metric columns off-screen. What survives is plain text and legacy
// attributes, so the break points are put into the text itself.

const ZERO_WIDTH_SPACE = '\u200B';

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The URL as display text that may wrap after `/ - . ? & = _` — no visible change. */
export function breakableUrlText(url: string): string {
    return url.replace(/([/\-.?&=_])/g, `$1${ZERO_WIDTH_SPACE}`);
}

/**
 * A link whose text can wrap inside a narrow cell. `text` defaults to the URL (a page
 * path is shorter when the host is shown elsewhere); the href is always the exact URL,
 * so the zero-width spaces never reach the address a reader clicks through to.
 */
export function breakableUrlLink(url: string, text: string = url): string {
    return `<a href="${escapeHtml(url)}">${escapeHtml(breakableUrlText(text))}</a>`;
}

/** A titled table for a Teams paste. Teams drops `<style>` and classes, so every
 *  element carries its own inline style; every value is escaped. */
export interface TeamsTable {
    title: string;
    subtitle?: string | undefined;
    /** Border / title colour. */
    accent?: string | undefined;
    headers: string[];
    rows: string[][];
    /** Lines after the table, e.g. a list of new exception types. */
    footer?: string[] | undefined;
}

const CELL = 'border:1px solid #d1d9e0;padding:4px 9px;text-align:left;vertical-align:top;color:#1f2328;';

export function teamsTableHtml({ title, subtitle, accent = '#0969da', headers, rows, footer = [] }: TeamsTable): string {
    const th = headers.map(h => `<th style="${CELL}background:#f6f8fa;font-weight:600;">${escapeHtml(h)}</th>`).join('');
    const body = rows.map(r => `<tr>${r.map(c => `<td style="${CELL}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
    return (
        `<div style="border-left:4px solid ${escapeHtml(accent)};padding:10px 14px;font-family:Segoe UI,Helvetica,Arial,sans-serif;">` +
        `<p style="margin:0 0 6px 0;font-size:14px;font-weight:700;color:${escapeHtml(accent)};">${escapeHtml(title)}</p>` +
        (subtitle ? `<p style="margin:0 0 8px 0;font-size:11px;color:#57606a;">${escapeHtml(subtitle)}</p>` : '') +
        `<table style="border-collapse:collapse;font-size:13px;"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>` +
        footer.map(l => `<p style="margin:8px 0 0 0;font-size:13px;color:#1f2328;">${escapeHtml(l)}</p>`).join('') +
        `</div>`
    );
}

/** Plain-text fallback for the same paste — pipe-separated rows. */
export function teamsTableText({ title, subtitle, headers, rows, footer = [] }: TeamsTable): string {
    return [title, ...(subtitle ? [subtitle] : []), '', headers.join(' | '), ...rows.map(r => r.join(' | ')), ...(footer.length ? ['', ...footer] : [])].join('\n');
}

/** Puts HTML + plain text on the clipboard in one write, which is what Teams pastes from. */
export async function copyTeamsTable(table: TeamsTable): Promise<void> {
    await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([teamsTableHtml(table)], { type: 'text/html' }),
        'text/plain': new Blob([teamsTableText(table)], { type: 'text/plain' }),
    })]);
}
