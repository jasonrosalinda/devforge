import { marked } from 'marked';

/**
 * The RCA's Quick Summary is emitted as the first section, ahead of the
 * `# Root Cause Analysis Report` title, so it can be lifted out and rendered as a
 * callout — it is the part non-engineers actually read.
 *
 * Returns an empty summary and the markdown untouched when the section is absent,
 * so a model that skipped it (or a partial stream) still renders normally.
 */
export function splitQuickSummary(md: string): { summary: string; body: string } {
  // `(?![\s\S])` is end-of-input, not `$`: the `m` flag makes `$` match end-of-LINE,
  // which the lazy group satisfies immediately at the blank line after the heading
  // and captures nothing.
  const m = md.match(/^##[ \t]+Quick Summary[ \t]*\r?\n([\s\S]*?)(?=\r?\n#{1,2}[ \t]|(?![\s\S]))/m);
  if (!m || m.index === undefined || m[1] === undefined) return { summary: '', body: md };
  const summary = m[1].replace(/^\s*[-*]\s+/gm, '').trim();
  if (!summary) return { summary: '', body: md };
  const body = (md.slice(0, m.index) + md.slice(m.index + m[0].length)).replace(/^\s*(?:---\s*)?\n+/, '');
  return { summary, body };
}

/**
 * Print stylesheet for the PDF export. Deliberately does NOT reuse the dialog's
 * inline CSS: that is written against `hsl(var(--foreground))` theme variables,
 * which resolve to nothing in a standalone document — and in dark mode the page
 * would print as white text on black. Colours here are literal and light-only.
 */
const PRINT_CSS = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #ffffff; color: #1f2328;
    font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc { max-width: 100%; }
  .doc-header { border-bottom: 2px solid #1f2328; padding-bottom: 10px; margin-bottom: 16px; }
  .doc-header h1 { font-size: 19px; font-weight: 700; margin: 0 0 4px; }
  .doc-header .meta { font-size: 11px; color: #57606a; }
  h1 { font-size: 18px; font-weight: 700; margin: 20px 0 8px; }
  h2 {
    font-size: 15px; font-weight: 700; margin: 18px 0 8px;
    padding-bottom: 4px; border-bottom: 1px solid #d1d9e0;
    page-break-after: avoid; break-after: avoid;
  }
  h3 { font-size: 13px; font-weight: 600; margin: 14px 0 6px; page-break-after: avoid; break-after: avoid; }
  p { margin: 7px 0; }
  ul, ol { margin: 7px 0; padding-left: 20px; }
  li { margin: 3px 0; page-break-inside: avoid; break-inside: avoid; }
  code {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    font-size: .85em; background: #f0f1f3; padding: .1em .35em; border-radius: 4px;
  }
  pre { background: #f6f8fa; padding: 10px; border-radius: 6px; overflow-x: auto; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  /* Wide tables (the evidence matrix in particular) must shrink to the page
     rather than run off the right edge, where the PDF would silently clip them. */
  table {
    width: 100%; border-collapse: collapse; margin: 8px 0;
    font-size: 10px; table-layout: auto; word-break: break-word;
  }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  th, td { border: 1px solid #d1d9e0; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f6f8fa; font-weight: 600; }
  blockquote {
    border-left: 3px solid #d1d9e0; padding: 2px 0 2px 12px; margin: 8px 0; color: #57606a;
    page-break-inside: avoid;
  }
  hr { border: none; border-top: 1px solid #d1d9e0; margin: 14px 0; }
  a { color: #0969da; }
  details { margin: 8px 0; }
  summary { font-weight: 600; cursor: default; }
  .footer { margin-top: 20px; padding-top: 8px; border-top: 1px solid #d1d9e0; font-size: 10px; color: #57606a; }
`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string
  ));
}

export interface RcaPrintMeta {
  appName: string;
  /** Analysis window, already formatted in SGT. */
  window: string;
  /** Generation timestamp, already formatted in SGT. */
  generated: string;
}

/**
 * Builds a complete, self-contained HTML document for `webContents.printToPDF`.
 *
 * The Quick Summary is deliberately excluded: the PDF is the formal report, while
 * the summary is the shareable plain-English blurb (copied to Teams from the
 * dialog). `splitQuickSummary` is still used so the section is *removed* rather
 * than left to render inline as a stray heading.
 */
export function buildRcaPrintHtml(markdown: string, meta: RcaPrintMeta): string {
  const { body } = splitQuickSummary(markdown);
  const bodyHtml = marked.parse(body, { async: false }) as string;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Root Cause Analysis Report — ${escapeHtml(meta.appName)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<div class="doc">
  <div class="doc-header">
    <h1>Root Cause Analysis Report</h1>
    <div class="meta">
      <strong>${escapeHtml(meta.appName)}</strong> &middot;
      ${escapeHtml(meta.window)} &middot;
      generated ${escapeHtml(meta.generated)}
    </div>
  </div>
  ${bodyHtml}
  <div class="footer">Generated by DevForge &middot; all times SGT (UTC+8)</div>
</div>
</body>
</html>`;
}

/**
 * Tags the Quick Summary is allowed to emit once rendered. Anything else marked
 * produced — or that the model wrote as raw HTML — is dropped, so a stray
 * `<script>` or `<img>` can never ride along on the clipboard.
 */
const TEAMS_ALLOWED_TAGS = /^\/?(p|br|strong|em|table|thead|tbody|tr|th|td)$/i;

/** Inline styles per tag. Teams discards `<style>` blocks and class attributes, so
 *  formatting only survives if it is attached to the element itself. */
const TEAMS_TAG_STYLES: Record<string, string> = {
  p: 'margin:0 0 8px 0;font-size:14px;line-height:1.5;color:#1f2328;',
  table: 'border-collapse:collapse;margin:0 0 10px 0;font-size:13px;',
  th: 'border:1px solid #d1d9e0;background:#f6f8fa;padding:4px 9px;text-align:left;font-weight:600;color:#1f2328;',
  td: 'border:1px solid #d1d9e0;padding:4px 9px;text-align:left;vertical-align:top;color:#1f2328;',
  strong: 'font-weight:700;',
};

function renderSummaryForTeams(summary: string): string {
  const html = marked.parse(summary, { async: false }) as string;
  return html
    // Whitelist first: drop any tag not on the list, keeping its text content.
    .replace(/<\/?([a-zA-Z][\w-]*)[^>]*>/g, (match, tag: string) =>
      TEAMS_ALLOWED_TAGS.test(`${match.startsWith('</') ? '/' : ''}${tag}`) ? match : '')
    // Then attach the inline styles the surviving tags need.
    .replace(/<(p|table|th|td|strong)(\s[^>]*)?>/g, (_m, tag: string, attrs: string | undefined) =>
      `<${tag}${attrs ?? ''} style="${TEAMS_TAG_STYLES[tag]}">`)
    .trim();
}

/**
 * Quick Summary formatted for pasting into Microsoft Teams.
 *
 * The summary now carries a markdown table, so it is rendered rather than escaped —
 * escaping would paste the table as literal pipe characters. Output is whitelisted
 * and inline-styled by `renderSummaryForTeams`.
 */
export function buildQuickSummaryTeamsHtml(summary: string, meta: { appName: string; window: string }): string {
  return (
    `<div style="border-left:4px solid #0969da;background:#f2f8ff;padding:10px 14px;` +
    `font-family:Segoe UI,Helvetica,Arial,sans-serif;">` +
    `<p style="margin:0 0 6px 0;font-size:13px;font-weight:700;color:#0969da;">` +
    `RCA Quick Summary — ${escapeHtml(meta.appName)}</p>` +
    `<p style="margin:0 0 8px 0;font-size:11px;color:#57606a;">${escapeHtml(meta.window)}</p>` +
    renderSummaryForTeams(summary) +
    `</div>`
  );
}

/** Plain-text fallback for the same paste — what Teams uses if HTML is rejected.
 *  Markdown is left as-is: a pipe table is still readable as plain text, and
 *  collapsing its newlines would destroy it. */
export function buildQuickSummaryTeamsText(summary: string, meta: { appName: string; window: string }): string {
  return `RCA Quick Summary — ${meta.appName}\n${meta.window}\n\n${summary.trim()}`;
}

/** Analysis window formatted in SGT — matches the report's own header format. */
export function formatSgtRange(startMs: number, endMs: number): string {
  return `${formatSgt(startMs)} → ${formatSgt(endMs)}`;
}

export function formatSgt(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} SGT`;
}
