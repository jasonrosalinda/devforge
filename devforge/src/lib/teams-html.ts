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
