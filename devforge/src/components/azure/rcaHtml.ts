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

/* ── Editable RCA form ──────────────────────────────────────────────────────────
 * The card shows the report as a form before anything is generated, so an engineer
 * can write the parts only they know (who reported it, what was changed) and hand
 * those to the model as evidence. The same shape is used to parse a generated
 * report back into the form and to compose the form back into markdown. */

export interface RcaFields {
  title: string;
  incidentNumber: string;
  incident: string;
  services: string;
  period: string;
  severity: string;
  background: string;
  impact: string;
  rootCause: string;
  resolution: string;
  lessons: string;
  preventive: string;
  status: string;
}

export const EMPTY_RCA_FIELDS: RcaFields = {
  title: '', incidentNumber: '', incident: '', services: '', period: '', severity: '',
  background: '', impact: '', rootCause: '', resolution: '', lessons: '', preventive: '', status: '',
};

/** The seven numbered sections, in report order. `key` indexes RcaFields. */
export const RCA_SECTIONS = [
  { n: 1, key: 'background', label: 'Background',        hint: 'Chronological account — a. 29 Jun, 7:30 PM SGT: issue first reported by a user via email…' },
  { n: 2, key: 'impact',     label: 'Impact',            hint: 'Worst-hit page or action first, with its numbers — e.g. users enrolling in webinar 222 failed 97.95% of 731 attempts; other front-end users saw slow or unreachable pages.' },
  { n: 3, key: 'rootCause',  label: 'Root Cause',        hint: 'The cause in one line, then how it played out — e.g. Cloudflare Super Bot Fight Mode challenged the login request, so authentication never completed.' },
  { n: 4, key: 'resolution', label: 'Resolution',        hint: 'What ended it, when, and how that was confirmed.' },
  { n: 5, key: 'lessons',    label: 'Lessons Learned',   hint: 'What this incident taught the team — a limit nobody knew about, an assumption that was wrong, a change that went out unchecked.' },
  { n: 6, key: 'preventive', label: 'Preventive Actions', hint: 'One bullet per action, most urgent first — what to change, where, and what it prevents.' },
  { n: 7, key: 'status',     label: 'Current Status',    hint: 'Where things stand now, what has been verified, what remains open.' },
] as const satisfies ReadonlyArray<{ n: number; key: keyof RcaFields; label: string; hint: string }>;

const META_FIELDS = [
  { key: 'incidentNumber', label: 'Incident number', mdLabel: 'Incident number' },
  { key: 'incident',       label: 'Incident',        mdLabel: 'Incident' },
  { key: 'services',       label: 'Services Affected', mdLabel: 'Services Affected' },
  { key: 'period',         label: 'Incident Period', mdLabel: 'Incident Period' },
  { key: 'severity',       label: 'Severity',        mdLabel: 'Severity' },
] as const satisfies ReadonlyArray<{ key: keyof RcaFields; label: string; mdLabel: string }>;

export const RCA_META_FIELDS = META_FIELDS;

/**
 * The tracker: the QA-style record appended after section 7 — what was seen, what it
 * turned out to be, what was done and what proved it worked.
 *
 * The engineer owns it, but the AI drafts it: a generated run fills any field left empty,
 * working from the same telemetry as the report and from whatever the engineer has already
 * typed into the form. Anything already written is never overwritten.
 */
export interface RcaTrackerFields {
  detection: string;
  rootCauseIdentified: string;
  correctiveAction: string;
  preventiveAction: string;
  outcome: string;
}

export const TRACKER_FIELDS = [
  { key: 'detection',           label: 'Detection / Symptoms',            hint: 'How it surfaced and what was seen — login stuck on a loading spinner, reported by a user.' },
  { key: 'rootCauseIdentified', label: 'Root Cause Identified',           hint: 'The cause in one line, as confirmed.' },
  { key: 'correctiveAction',    label: 'Corrective Action Taken',         hint: 'What was changed to end it, and when.' },
  { key: 'preventiveAction',    label: 'Preventive / Improvement Action', hint: 'What stops it recurring, or shortens the next one.' },
  { key: 'outcome',             label: 'Measurable Outcome',              hint: 'The number that proves it worked — enrolments back to ~400/day, 0 login failures since 14:20 SGT.' },
] as const satisfies ReadonlyArray<{ key: keyof RcaTrackerFields; label: string; hint: string }>;

export const EMPTY_TRACKER_FIELDS: RcaTrackerFields = {
  detection: '', rootCauseIdentified: '', correctiveAction: '', preventiveAction: '', outcome: '',
};

/** True when no tracker field carries anything. */
export function isTrackerEmpty(tracker: RcaTrackerFields): boolean {
  return TRACKER_FIELDS.every(f => !(tracker?.[f.key] ?? '').trim());
}

/** The tracker as markdown — one labelled line per filled field. '' when untouched. */
export function composeTrackerMarkdown(tracker: RcaTrackerFields): string {
  if (isTrackerEmpty(tracker)) return '';
  const lines = TRACKER_FIELDS
    .filter(f => (tracker[f.key] ?? '').trim())
    .map(f => `**${f.label}:** ${(tracker[f.key] ?? '').trim()}`);
  return `## Tracker\n\n${lines.join('  \n')}`;
}

/**
 * Pulls a generated report apart into form fields. Tolerant by design: a heading
 * the model numbered or worded differently simply leaves that field empty rather
 * than swallowing the next section's text.
 */
export function parseRcaFields(markdown: string): Partial<RcaFields> {
  if (!markdown) return {};
  const md = markdown.replace(/\r\n/g, '\n');
  const out: Partial<RcaFields> = {};

  const title = md.match(/^#[ \t]+RCA Report:[ \t]*(.+)$/m);
  if (title?.[1]) out.title = title[1].trim();

  for (const f of META_FIELDS) {
    // `**Label:** value`, with or without the bold markers.
    const m = md.match(new RegExp(`^[ \\t]*\\*{0,2}${f.mdLabel}:?\\*{0,2}[ \\t]*:?[ \\t]*(.+)$`, 'im'));
    if (m?.[1]) out[f.key] = m[1].replace(/\*\*/g, '').trim();
  }

  for (const s of RCA_SECTIONS) {
    const m = md.match(new RegExp(
      // Heading for this section number, then everything up to the next heading.
      `^#{1,3}[ \\t]*${s.n}\\.[ \\t]*[^\\n]*\\n([\\s\\S]*?)(?=\\n#{1,3}[ \\t]|(?![\\s\\S]))`,
      'm',
    ));
    if (m?.[1]?.trim()) out[s.key] = m[1].trim();
  }

  return out;
}

/**
 * Pulls the Tracker block out of a generated report.
 *
 * Its own parser rather than folding the labels into parseRcaFields: the tracker lines sit
 * under a heading with no section number, and scanning the whole document for
 * `**Detection / Symptoms:**` would also match the engineer's own text if they quoted a
 * label inside section 1.
 */
export function parseTrackerFields(markdown: string): Partial<RcaTrackerFields> {
  if (!markdown) return {};
  const md = markdown.replace(/\r\n/g, '\n');
  const block = md.match(/^#{1,3}[ \t]*Tracker[ \t]*\n([\s\S]*?)(?=\n#{1,3}[ \t]|(?![\s\S]))/m);
  if (!block?.[1]) return {};

  const body = block[1];
  const out: Partial<RcaTrackerFields> = {};
  for (const f of TRACKER_FIELDS) {
    // The labels carry '/' and spaces, so the literal is escaped rather than interpolated raw.
    const label = f.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = body.match(new RegExp(`^[ \\t]*\\*{0,2}${label}:?\\*{0,2}[ \\t]*:?[ \\t]*(.+)$`, 'im'));
    if (m?.[1]) out[f.key] = m[1].replace(/\*\*/g, '').trim();
  }
  return out;
}

/**
 * The form back to markdown, in the report's own layout. Empty sections are left
 * out rather than printed as bare headings — a heading with nothing under it reads
 * as missing analysis instead of an unanswered field.
 */
export function composeRcaMarkdown(fields: RcaFields, summary = '', tracker?: RcaTrackerFields): string {
  const parts: string[] = [];
  const s = (v: string) => (v ?? '').trim();

  if (s(summary)) parts.push(`## Quick Summary\n\n${s(summary)}`);

  const title = s(fields.title) || s(fields.incident);
  parts.push(`# RCA Report: ${title || 'Untitled Incident'}`);

  const meta = META_FIELDS
    .filter(f => s(fields[f.key]))
    .map(f => `**${f.mdLabel}:** ${s(fields[f.key])}`);
  if (meta.length) parts.push(`## Root Cause Analysis (RCA)\n\n${meta.join('  \n')}`);

  for (const sec of RCA_SECTIONS) {
    // Section bodies are HTML from the rich-text field. `marked` passes HTML through
    // untouched, so attached images survive into the PDF and the Word file.
    if (!isHtmlEmpty(fields[sec.key])) parts.push(`## ${sec.n}. ${sec.label}\n\n${s(fields[sec.key])}`);
  }

  const trackerMd = tracker ? composeTrackerMarkdown(tracker) : '';
  if (trackerMd) parts.push(trackerMd);

  return parts.join('\n\n') + '\n';
}

/**
 * The seven section fields hold HTML — they are edited in a rich-text field that
 * carries lists and attached images — so "empty" means no text and no image, not an
 * empty string: a contentEditable that has been focused once holds `<br>`.
 */
export function isHtmlEmpty(html: string): boolean {
  if (!html) return true;
  if (/<img[\s>]/i.test(html)) return false;
  return htmlToPlainText(html) === '';
}

/** HTML → the plain text that goes into the prompt. Images become a named marker so
 *  the model knows a screenshot is attached without receiving the base64 payload. */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, (_m, alt) => `[image: ${alt || 'attachment'}]`)
    .replace(/<img[^>]*>/gi, '[image attached]')
    // The opening <li> supplies the line break, so </li> must not add a second one.
    .replace(/<\/li>/gi, '')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain text → the minimal HTML the rich-text field edits: paragraphs, and a list
 *  wherever the text used bullet or lettered lines. */
export function plainTextToHtml(text: string): string {
  const clean = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (!clean) return '';
  const esc = (s: string) => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));

  return clean.split(/\n{2,}/).map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const bullets = lines.every(l => /^([-•*]\s+)/.test(l));
    if (bullets && lines.length > 0) {
      return `<ul>${lines.map(l => `<li>${esc(l.replace(/^([-•*]\s+)/, ''))}</li>`).join('')}</ul>`;
    }
    // Lettered items (a. b. c.) stay as separate paragraphs — renumbering them into
    // an <ol> would lose the letters the report's Background section uses.
    return lines.map(l => `<p>${esc(l)}</p>`).join('');
  }).join('');
}

/** True when nothing has been written or generated yet. */
export function isRcaFieldsEmpty(fields: RcaFields): boolean {
  const sectionKeys = RCA_SECTIONS.map(s => s.key) as Array<keyof RcaFields>;
  return Object.entries(fields).every(([k, v]) =>
    sectionKeys.includes(k as keyof RcaFields) ? isHtmlEmpty(v ?? '') : !(v ?? '').trim()
  );
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
  /* The report's own "# Root Cause Analysis Report" title is the document header —
     it carries the app, window, severity and confidence line beneath it, so the
     wrapper no longer prints a second title of its own. */
  h1 { font-size: 19px; font-weight: 700; margin: 20px 0 8px; }
  .doc > h1:first-child { margin-top: 0; padding-bottom: 10px; border-bottom: 2px solid #1f2328; }
  .fallback-meta { font-size: 11px; color: #57606a; margin: 0 0 16px; }
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
  /* Screenshots attached to a section: fit the page, never split across one. */
  img { max-width: 100%; height: auto; display: block; margin: 8px 0; page-break-inside: avoid; break-inside: avoid; }
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
 *
 * The report supplies its own `# Root Cause Analysis Report` title and metadata
 * line, so no wrapper title is printed — that produced two stacked headers. The
 * fallback header below only appears if the markdown carries no `<h1>` at all
 * (a truncated stream), so the PDF is never headerless.
 */
export function buildRcaPrintHtml(markdown: string, meta: RcaPrintMeta): string {
  const { body } = splitQuickSummary(markdown);
  const bodyHtml = marked.parse(body, { async: false }) as string;
  const header = /<h1[\s>]/i.test(bodyHtml) ? '' : `<h1>Root Cause Analysis Report</h1>
  <p class="fallback-meta"><strong>${escapeHtml(meta.appName)}</strong> &middot; ${escapeHtml(meta.window)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Root Cause Analysis Report — ${escapeHtml(meta.appName)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<div class="doc">
  ${header}${bodyHtml}
  <div class="footer">
    Generated by DevForge &middot; ${escapeHtml(meta.generated)} &middot; all times SGT (UTC+8)
  </div>
</div>
</body>
</html>`;
}

/**
 * Word export. Word opens an HTML document named `.doc` as an editable document, so
 * the same rendered report becomes a Word file without an OOXML dependency. Styling
 * is literal and light-only for the same reason the PDF's is: theme variables mean
 * nothing outside the app.
 */
export function buildRcaWordHtml(markdown: string, meta: RcaPrintMeta): string {
  const { body } = splitQuickSummary(markdown);
  const bodyHtml = marked.parse(body, { async: false }) as string;
  const header = /<h1[\s>]/i.test(bodyHtml) ? '' : `<h1>RCA Report</h1>
  <p class="fallback-meta"><strong>${escapeHtml(meta.appName)}</strong> &middot; ${escapeHtml(meta.window)}</p>`;

  return `<!doctype html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="en">
<head>
<meta charset="utf-8">
<title>RCA Report — ${escapeHtml(meta.appName)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->
<style>
  @page { size: A4; margin: 20mm; }
  body { font: 11pt/1.5 "Calibri", "Segoe UI", Arial, sans-serif; color: #1f2328; }
  h1 { font-size: 17pt; margin: 0 0 6pt; }
  h2 { font-size: 13pt; margin: 16pt 0 6pt; border-bottom: 1px solid #d1d9e0; padding-bottom: 3pt; }
  h3 { font-size: 11.5pt; margin: 12pt 0 4pt; }
  p, li { font-size: 11pt; }
  ul, ol { margin: 6pt 0; padding-left: 18pt; }
  .fallback-meta { color: #57606a; font-size: 9.5pt; margin: 0 0 12pt; }
  table { border-collapse: collapse; margin: 8pt 0; width: 100%; }
  th, td { border: 1px solid #d1d9e0; padding: 4pt 6pt; text-align: left; vertical-align: top; font-size: 10pt; }
  th { background: #f6f8fa; font-weight: 600; }
  img { max-width: 100%; height: auto; display: block; margin: 6pt 0; }
  code, pre { font-family: "Consolas", monospace; font-size: 10pt; }
  pre { background: #f6f8fa; padding: 6pt; }
  .footer { margin-top: 18pt; color: #57606a; font-size: 8.5pt; border-top: 1px solid #d1d9e0; padding-top: 6pt; }
</style>
</head>
<body>
${header}${bodyHtml}
<div class="footer">Generated by DevForge &middot; ${escapeHtml(meta.generated)} &middot; all times SGT (UTC+8)</div>
</body>
</html>`;
}

/**
 * Markdown syntax → plain reading text. The card's RCA form holds prose the engineer
 * edits and Word/PDF renders, so a generated report is stripped of its markup before
 * it lands in a textarea — otherwise the fields fill with `**bold**`, backticks and
 * pipe tables, which is what the reader would then see in the document.
 */
export function stripMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }

    // A table separator (|---|---|) carries no content once the pipes are gone.
    if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) continue;

    let s = line;
    s = s.replace(/^\s{0,3}#{1,6}\s+/, '');                 // heading marker
    s = s.replace(/^\s*>\s?/, '');                          // blockquote
    s = s.replace(/^(\s*)[-*+]\s+/, '$1• ');                // bullet
    if (/^\s*\|/.test(s)) {
      // Row of cells → "first: rest", which is how the two-column fact tables read.
      const cells = s.split('|').map(c => c.trim()).filter(c => c !== '');
      s = cells.length > 1 ? `${cells[0]}: ${cells.slice(1).join(' · ')}` : (cells[0] ?? '');
    }
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');   // link
    s = s.replace(/`([^`]+)`/g, '$1');                      // inline code
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2');        // italic, not a bullet
    s = s.replace(/__([^_]+)__/g, '$1');
    s = s.replace(/^\s*[-*_]{3,}\s*$/, '');                 // horizontal rule
    out.push(s.trimEnd());
  }

  // Collapse the blank runs the stripping leaves behind.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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
