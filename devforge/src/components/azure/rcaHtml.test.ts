import { describe, it, expect } from 'vitest';
import {
  splitQuickSummary, buildRcaPrintHtml, formatSgt, formatSgtRange,
  buildQuickSummaryTeamsHtml, buildQuickSummaryTeamsText,
  parseRcaFields, composeRcaMarkdown, isRcaFieldsEmpty, EMPTY_RCA_FIELDS,
  stripMarkdown, buildRcaWordHtml, htmlToPlainText, plainTextToHtml, isHtmlEmpty,
  composeTrackerMarkdown, isTrackerEmpty, parseTrackerFields, EMPTY_TRACKER_FIELDS,
  type RcaTrackerFields,
} from './rcaHtml';

// The RCA prompt asks for the Quick Summary as the FIRST section, ahead of the
// report title, so it can be lifted into a callout. If this split breaks, the
// summary either vanishes or gets duplicated inside the body.
describe('splitQuickSummary', () => {
  const doc = [
    '## Quick Summary',
    '',
    'Between 14:05 and 14:40 SGT the site stopped answering about one request in three.',
    'The cause was the database.',
    '',
    '# Root Cause Analysis Report',
    '',
    '**App:** app-prod · **Window:** 2026-07-30 00:00 SGT → 2026-07-30 23:59 SGT',
    '',
    '## 1. Executive Summary',
    '',
    'Anomaly score 85/100.',
  ].join('\n');

  it('extracts the summary paragraph', () => {
    const { summary } = splitQuickSummary(doc);
    expect(summary).toContain('Between 14:05 and 14:40 SGT');
    expect(summary).toContain('The cause was the database.');
  });

  it('removes the summary from the body exactly once', () => {
    const { body } = splitQuickSummary(doc);
    expect(body).not.toContain('Quick Summary');
    expect(body).not.toContain('stopped answering about one request in three');
    expect(body).toContain('# Root Cause Analysis Report');
    expect(body).toContain('## 1. Executive Summary');
  });

  it('stops at the report title and does not swallow later sections', () => {
    const { summary } = splitQuickSummary(doc);
    expect(summary).not.toContain('Root Cause Analysis Report');
    expect(summary).not.toContain('Anomaly score');
  });

  it('passes markdown through untouched when the section is absent', () => {
    const plain = '# Root Cause Analysis Report\n\n## 1. Executive Summary\n\nText.';
    expect(splitQuickSummary(plain)).toEqual({ summary: '', body: plain });
  });

  it('treats an empty Quick Summary as absent rather than blanking the body', () => {
    const empty = '## Quick Summary\n\n# Root Cause Analysis Report\n\nBody text.';
    const { summary, body } = splitQuickSummary(empty);
    expect(summary).toBe('');
    expect(body).toBe(empty);
  });

  // A partial stream can end mid-summary with no following heading.
  it('handles a summary with no trailing heading', () => {
    const partial = '## Quick Summary\n\nThe site was down from 09:00 SGT.';
    const { summary, body } = splitQuickSummary(partial);
    expect(summary).toBe('The site was down from 09:00 SGT.');
    expect(body.trim()).toBe('');
  });

  it('tolerates CRLF line endings', () => {
    const crlf = '## Quick Summary\r\n\r\nDowntime at 10:00 SGT.\r\n\r\n# Root Cause Analysis Report\r\n';
    expect(splitQuickSummary(crlf).summary).toBe('Downtime at 10:00 SGT.');
  });

  it('does not match a Quick Summary heading nested at a deeper level', () => {
    const nested = '# Root Cause Analysis Report\n\n### Quick Summary\n\nNope.';
    expect(splitQuickSummary(nested).summary).toBe('');
  });
});

describe('formatSgt', () => {
  // Azure returns UTC; every rendered time must be SGT (UTC+8) and labelled.
  it('shifts UTC by +8 hours and labels SGT', () => {
    expect(formatSgt(Date.parse('2026-07-30T06:05:00Z'))).toBe('2026-07-30 14:05 SGT');
  });

  it('rolls the date forward across the UTC midnight boundary', () => {
    expect(formatSgt(Date.parse('2026-07-30T17:30:00Z'))).toBe('2026-07-31 01:30 SGT');
  });

  it('formats a range with both ends in SGT', () => {
    const r = formatSgtRange(Date.parse('2026-07-29T16:00:00Z'), Date.parse('2026-07-30T15:59:00Z'));
    expect(r).toBe('2026-07-30 00:00 SGT → 2026-07-30 23:59 SGT');
  });
});

// Teams strips <style> blocks and class attributes from pasted HTML, so the
// formatting has to survive as inline styles or it arrives as unstyled text.
describe('buildQuickSummaryTeamsHtml', () => {
  const meta = { appName: 'app-prod', window: '2026-07-30 00:00 SGT → 2026-07-30 23:59 SGT' };
  const summary = 'Between 17:00 and 17:23 SGT the enrolment page stopped working. The database was at its limit.';

  it('styles inline only — no classes and no stylesheet', () => {
    const html = buildQuickSummaryTeamsHtml(summary, meta);
    expect(html).toContain('style="');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('class=');
  });

  it('includes the app name, window, and the summary text', () => {
    const html = buildQuickSummaryTeamsHtml(summary, meta);
    expect(html).toContain('RCA Quick Summary — app-prod');
    expect(html).toContain('2026-07-30 00:00 SGT');
    expect(html).toContain('the enrolment page stopped working');
  });

  it('keeps genuine paragraph breaks as separate paragraphs', () => {
    const two = 'First paragraph.\n\nSecond paragraph.';
    const html = buildQuickSummaryTeamsHtml(two, meta);
    expect(html.match(/<p style="margin:0 0 8px 0;font-size:14px/g)).toHaveLength(2);
  });

  // The summary now leads with a verdict line and a facts table, so markdown is
  // rendered rather than escaped — escaping would paste literal pipe characters.
  it('renders a markdown table as a real table with inline styles', () => {
    const withTable = [
      '**Cause:** The database reached its limit, so requests failed.',
      '',
      '| What | Detail |',
      '|---|---|',
      '| Root cause | The database was at its limit |',
      '| Duration | 23 minutes |',
    ].join('\n');
    const html = buildQuickSummaryTeamsHtml(withTable, meta);
    expect(html).toContain('<table style="border-collapse:collapse');
    expect(html).toContain('<th style="border:1px solid');
    expect(html).toContain('<td style="border:1px solid');
    expect(html).toContain('23 minutes');
    expect(html).not.toContain('| Root cause |');   // not left as literal markdown
  });

  it('renders the bold verdict label', () => {
    const html = buildQuickSummaryTeamsHtml('**Cause:** Database at its limit.', meta);
    expect(html).toContain('<strong style="font-weight:700;">Cause:</strong>');
  });

  it('drops tags outside the whitelist but keeps their text', () => {
    const html = buildQuickSummaryTeamsHtml('Failure in <b>module</b> and <span>more</span>.', meta);
    expect(html).not.toMatch(/<\/?b>/);
    expect(html).not.toContain('<span');
    expect(html).toContain('module');
    expect(html).toContain('more');
  });

  it('strips script and image tags from model output', () => {
    const html = buildQuickSummaryTeamsHtml('Down 23 minutes.\n\n<script>alert(1)</script><img src=x onerror=y>', meta);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror');
  });

  it('escapes HTML in the app name', () => {
    const html = buildQuickSummaryTeamsHtml('Down.', { ...meta, appName: 'a<script>b' });
    expect(html).toContain('a&lt;script&gt;b');
    expect(html).not.toContain('<script>');
  });
});

describe('buildQuickSummaryTeamsText', () => {
  const meta = { appName: 'app-prod', window: '2026-07-30 00:00 SGT → 2026-07-30 23:59 SGT' };

  it('provides a readable plain-text fallback with no markup', () => {
    const text = buildQuickSummaryTeamsText('Site down 23 minutes.', meta);
    expect(text).toBe('RCA Quick Summary — app-prod\n2026-07-30 00:00 SGT → 2026-07-30 23:59 SGT\n\nSite down 23 minutes.');
    expect(text).not.toMatch(/[<>]/);
  });

  // A pipe table is still legible as plain text; collapsing its newlines (as the
  // prose-only version did) would flatten it into one unreadable line.
  it('preserves table line breaks in the plain-text form', () => {
    const withTable = '**Cause:** DB at limit.\n\n| What | Detail |\n|---|---|\n| Duration | 23 minutes |';
    const text = buildQuickSummaryTeamsText(withTable, meta);
    expect(text).toContain('| Duration | 23 minutes |');
    expect(text.split('\n').length).toBeGreaterThan(4);
  });
});

describe('buildRcaPrintHtml', () => {
  const meta = { appName: 'app-prod', window: '2026-07-30 00:00 SGT → 2026-07-30 23:59 SGT', generated: '2026-07-30 14:20 SGT' };

  it('produces a self-contained document with inlined CSS', () => {
    const html = buildRcaPrintHtml('## Quick Summary\n\nAll fine.\n\n# Root Cause Analysis Report\n\n## 1. Executive Summary\n\nNominal.', meta);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    // A strict no-external-requests rule: nothing may be fetched at print time.
    expect(html).not.toMatch(/<link[^>]+href=|<script[^>]+src=/);
  });

  // The PDF is the formal report; the Quick Summary is the shareable blurb and is
  // copied to Teams from the dialog instead.
  it('excludes the Quick Summary entirely', () => {
    const html = buildRcaPrintHtml('## Quick Summary\n\nSite down 30 minutes.\n\n# Root Cause Analysis Report\n\n## 1. Executive Summary\n\nDetail.', meta);
    expect(html).not.toContain('Site down 30 minutes.');
    expect(html).not.toContain('Quick Summary');
    expect(html).toContain('Executive Summary');
  });

  it('renders normally when there is no summary to strip', () => {
    const html = buildRcaPrintHtml('# Root Cause Analysis Report\n\n## 1. Executive Summary\n\nDetail.', meta);
    expect(html).toContain('Executive Summary');
    expect(html).toContain('Detail.');
  });

  // The wrapper used to print its own title above the report's, so the PDF opened
  // with "Root Cause Analysis Report" twice.
  it('prints the report title once, from the markdown itself', () => {
    const html = buildRcaPrintHtml('# Root Cause Analysis Report\n\n**App:** app-prod\n\n## 1. Executive Summary\n\nDetail.', meta);
    const rendered = html.slice(html.indexOf('<body>'));
    expect(rendered.match(/Root Cause Analysis Report/g)!.length).toBe(1);
    expect(rendered.match(/<h1[\s>]/g)!.length).toBe(1);
    expect(html).not.toContain('doc-header');
  });

  // A truncated stream can arrive without the title; the PDF must not be headerless.
  it('falls back to a wrapper header when the markdown has no h1', () => {
    const html = buildRcaPrintHtml('## 1. Executive Summary\n\nDetail.', meta);
    expect(html).toContain('<h1>Root Cause Analysis Report</h1>');
    expect(html).toContain(meta.window);
  });

  it('keeps the generation timestamp in the footer', () => {
    const html = buildRcaPrintHtml('# Root Cause Analysis Report', meta);
    expect(html).toContain('2026-07-30 14:20 SGT');
    expect(html).toMatch(/class="footer"[\s\S]*2026-07-30 14:20 SGT/);
  });

  it('escapes the app name in the title and header', () => {
    const html = buildRcaPrintHtml('# Root Cause Analysis Report', { ...meta, appName: 'a<script>b' });
    expect(html).not.toContain('a<script>b');
    expect(html).toContain('a&lt;script&gt;b');
  });

  // Long tables must repeat headers and avoid splitting rows across pages.
  it('carries the print rules the PDF depends on', () => {
    const html = buildRcaPrintHtml('# Root Cause Analysis Report', meta);
    expect(html).toContain('@page');
    expect(html).toContain('display: table-header-group');
    expect(html).toContain('print-color-adjust: exact');
  });
});

// The card's RCA section is an editable form: a generated report is parsed back
// into fields, and the fields are composed back into the report's own layout.
describe('parseRcaFields', () => {
  const report = [
    '## Quick Summary',
    '',
    '**Cause:** Login was blocked at the edge.',
    '',
    '# RCA Report: MIMS CPD Login Issue',
    '',
    '## Root Cause Analysis (RCA)',
    '',
    '**Incident number:** INC-202607-001',
    '**Incident:** MIMS CPD Login Issue',
    '**Services Affected:** mims-cpd.com',
    '**Incident Period:** 27 June 2026 – 01 Jul 2026',
    '**Severity:** High',
    '',
    '## 1. Background',
    '',
    'a. 29 June at 7:30 PM SGT - reported by a user.',
    '',
    '## 2. Impact',
    '',
    'Enrolments dropped by about 90%.',
    '',
    '## 3. Root Cause',
    '',
    'Cloudflare challenged the authentication request.',
    '',
    '## 7. Current Status',
    '',
    'Resolved and retested.',
  ].join('\n');

  it('pulls the title and every metadata field', () => {
    const f = parseRcaFields(report);
    expect(f.title).toBe('MIMS CPD Login Issue');
    expect(f.incidentNumber).toBe('INC-202607-001');
    expect(f.services).toBe('mims-cpd.com');
    expect(f.period).toBe('27 June 2026 – 01 Jul 2026');
    expect(f.severity).toBe('High');
  });

  it('maps numbered sections onto their fields', () => {
    const f = parseRcaFields(report);
    expect(f.background).toContain('29 June at 7:30 PM SGT');
    expect(f.impact).toBe('Enrolments dropped by about 90%.');
    expect(f.rootCause).toBe('Cloudflare challenged the authentication request.');
    expect(f.status).toBe('Resolved and retested.');
  });

  // A missing section must stay empty rather than absorb the next one's text.
  it('leaves absent sections undefined', () => {
    const f = parseRcaFields(report);
    expect(f.resolution).toBeUndefined();
    expect(f.lessons).toBeUndefined();
    expect(f.preventive).toBeUndefined();
  });

  it('tolerates CRLF and unbolded metadata labels', () => {
    const f = parseRcaFields('# RCA Report: X\r\n\r\nIncident number: INC-202607-009\r\n');
    expect(f.incidentNumber).toBe('INC-202607-009');
  });

  it('returns nothing for empty input', () => {
    expect(parseRcaFields('')).toEqual({});
  });
});

describe('composeRcaMarkdown', () => {
  const fields = {
    ...EMPTY_RCA_FIELDS,
    title: 'MIMS CPD Login Issue',
    incidentNumber: 'INC-202607-001',
    severity: 'High',
    background: 'a. 29 June at 7:30 PM SGT - reported by a user.',
    rootCause: 'Cloudflare challenged the authentication request.',
  };

  it('emits the title, metadata block and only the filled sections', () => {
    const md = composeRcaMarkdown(fields);
    expect(md).toContain('# RCA Report: MIMS CPD Login Issue');
    expect(md).toContain('## Root Cause Analysis (RCA)');
    expect(md).toContain('**Incident number:** INC-202607-001');
    expect(md).toContain('## 1. Background');
    expect(md).toContain('## 3. Root Cause');
    // Empty fields would print as bare headings, which reads as missing analysis.
    expect(md).not.toContain('## 2. Impact');
    expect(md).not.toContain('## 7. Current Status');
    expect(md).not.toContain('**Incident:**');
  });

  it('puts the Quick Summary ahead of the title so the split still finds it', () => {
    const md = composeRcaMarkdown(fields, 'Login was blocked at the edge.');
    expect(md.indexOf('## Quick Summary')).toBeLessThan(md.indexOf('# RCA Report:'));
    const { summary, body } = splitQuickSummary(md);
    expect(summary).toBe('Login was blocked at the edge.');
    expect(body).toContain('# RCA Report: MIMS CPD Login Issue');
  });

  it('falls back to the incident name, then a placeholder, for the title', () => {
    expect(composeRcaMarkdown({ ...EMPTY_RCA_FIELDS, incident: 'Login Issue' }))
      .toContain('# RCA Report: Login Issue');
    expect(composeRcaMarkdown(EMPTY_RCA_FIELDS)).toContain('# RCA Report: Untitled Incident');
  });

  it('round-trips a composed report back through the parser', () => {
    const parsed = parseRcaFields(composeRcaMarkdown(fields));
    expect(parsed.title).toBe(fields.title);
    expect(parsed.incidentNumber).toBe(fields.incidentNumber);
    expect(parsed.background).toBe(fields.background);
    expect(parsed.rootCause).toBe(fields.rootCause);
  });

  it('reports an untouched form as empty', () => {
    expect(isRcaFieldsEmpty(EMPTY_RCA_FIELDS)).toBe(true);
    expect(isRcaFieldsEmpty({ ...EMPTY_RCA_FIELDS, impact: '  ' })).toBe(true);
    expect(isRcaFieldsEmpty(fields)).toBe(false);
  });
});

// The RCA form is plain-text and the document is Word/PDF, so generated markdown is
// stripped before it fills a field — otherwise the reader sees the markup.
describe('stripMarkdown', () => {
  it('drops emphasis, code spans and heading markers', () => {
    expect(stripMarkdown('## 3. Root Cause')).toBe('3. Root Cause');
    expect(stripMarkdown('**Primary cause:** the database was at its limit'))
      .toBe('Primary cause: the database was at its limit');
    expect(stripMarkdown('run `az webapp restart` to recover')).toBe('run az webapp restart to recover');
    expect(stripMarkdown('*emphasis* and __strong__ text')).toBe('emphasis and strong text');
  });

  it('turns bullets into a plain bullet character and keeps lettered items', () => {
    expect(stripMarkdown('- first\n- second')).toBe('• first\n• second');
    expect(stripMarkdown('a. 29 June at 7:30 PM SGT — reported by a user.'))
      .toBe('a. 29 June at 7:30 PM SGT — reported by a user.');
  });

  it('flattens a pipe table into readable lines and drops the separator row', () => {
    const table = [
      '| What | Detail |',
      '|---|---|',
      '| Root cause | The database was at its limit |',
      '| Duration | 23 minutes |',
    ].join('\n');
    expect(stripMarkdown(table)).toBe([
      'What: Detail',
      'Root cause: The database was at its limit',
      'Duration: 23 minutes',
    ].join('\n'));
  });

  it('keeps link text with its target and drops rules', () => {
    expect(stripMarkdown('see [the portal](https://portal.azure.com)'))
      .toBe('see the portal (https://portal.azure.com)');
    expect(stripMarkdown('before\n\n---\n\nafter')).toBe('before\n\nafter');
  });

  it('leaves fenced code content alone and collapses blank runs', () => {
    expect(stripMarkdown('```\nkeep **this**\n```')).toBe('keep **this**');
    expect(stripMarkdown('one\n\n\n\ntwo')).toBe('one\n\ntwo');
    expect(stripMarkdown('')).toBe('');
  });
});

describe('buildRcaWordHtml', () => {
  const meta = {
    appName: 'app-prod',
    window: '2026-07-30 00:00 SGT → 2026-07-30 23:59 SGT',
    generated: '2026-07-30 14:20 SGT',
  };

  it('emits a Word-flavoured document with the report body', () => {
    const html = buildRcaWordHtml('# RCA Report: MEDU Downtime\n\n## 1. Background\n\nDetail.', meta);
    expect(html).toContain('xmlns:w="urn:schemas-microsoft-com:office:word"');
    expect(html).toContain('<w:WordDocument>');
    expect(html).toContain('RCA Report: MEDU Downtime');
    expect(html).toContain('1. Background');
  });

  // Same rule as the PDF: the summary is the shareable blurb, not part of the report.
  it('excludes the Quick Summary', () => {
    const html = buildRcaWordHtml('## Quick Summary\n\nDown 30 minutes.\n\n# RCA Report: X\n\nDetail.', meta);
    expect(html).not.toContain('Quick Summary');
    expect(html).not.toContain('Down 30 minutes');
  });

  it('falls back to a title only when the markdown carries none', () => {
    expect(buildRcaWordHtml('Body only.', meta)).toContain('<h1>RCA Report</h1>');
    const titled = buildRcaWordHtml('# RCA Report: X\n\nDetail.', meta);
    expect(titled.match(/<h1/g)).toHaveLength(1);
  });

  it('escapes the app name and keeps the generation footer', () => {
    const html = buildRcaWordHtml('# RCA Report: X', { ...meta, appName: 'a<script>b' });
    expect(html).not.toContain('a<script>b');
    expect(html).toContain('a&lt;script&gt;b');
    expect(html).toContain('2026-07-30 14:20 SGT');
  });
});

// The seven section fields are rich text (lists, attached screenshots), so they hold
// HTML. These conversions are what keeps the prompt clean and the exports whole.
describe('htmlToPlainText', () => {
  it('flattens paragraphs and lists to readable lines', () => {
    expect(htmlToPlainText('<p>First.</p><p>Second.</p>')).toBe('First.\nSecond.');
    expect(htmlToPlainText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
    expect(htmlToPlainText('line<br>break')).toBe('line\nbreak');
  });

  it('replaces an image with a named marker, never its payload', () => {
    const html = '<p>Before</p><img src="data:image/png;base64,AAAA" alt="waf-rule.png"><p>After</p>';
    const text = htmlToPlainText(html);
    expect(text).toContain('[image: waf-rule.png]');
    expect(text).not.toContain('base64');
    expect(text).toContain('Before');
    expect(text).toContain('After');
  });

  it('unescapes entities and drops script content', () => {
    expect(htmlToPlainText('<p>a &amp; b &lt;c&gt;</p>')).toBe('a & b <c>');
    expect(htmlToPlainText('<script>alert(1)</script><p>text</p>')).toBe('text');
  });
});

describe('plainTextToHtml', () => {
  it('makes paragraphs, and a list from bullet lines', () => {
    expect(plainTextToHtml('First.\n\nSecond.')).toBe('<p>First.</p><p>Second.</p>');
    expect(plainTextToHtml('• one\n• two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  // The Background chronology is lettered; an <ol> would renumber and lose the letters.
  it('keeps lettered items as paragraphs', () => {
    expect(plainTextToHtml('a. first\nb. second')).toBe('<p>a. first</p><p>b. second</p>');
  });

  it('escapes markup and returns nothing for blank input', () => {
    expect(plainTextToHtml('<script>x</script>')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(plainTextToHtml('   ')).toBe('');
  });
});

describe('isHtmlEmpty', () => {
  it('treats an untouched or whitespace-only editor as empty', () => {
    expect(isHtmlEmpty('')).toBe(true);
    expect(isHtmlEmpty('<br>')).toBe(true);
    expect(isHtmlEmpty('<p><br></p>')).toBe(true);
    expect(isHtmlEmpty('<p>&nbsp;</p>')).toBe(true);
  });

  it('counts an attached image as content even with no text', () => {
    expect(isHtmlEmpty('<img src="data:image/png;base64,AAAA">')).toBe(false);
    expect(isHtmlEmpty('<p>Detail.</p>')).toBe(false);
  });

  // hasContent drives the export buttons, so an image-only section must enable them.
  it('drives isRcaFieldsEmpty for the HTML sections', () => {
    expect(isRcaFieldsEmpty({ ...EMPTY_RCA_FIELDS, impact: '<p><br></p>' })).toBe(true);
    expect(isRcaFieldsEmpty({ ...EMPTY_RCA_FIELDS, impact: '<img src="data:image/png;base64,AAAA">' })).toBe(false);
  });
});

describe('composeRcaMarkdown with rich-text sections', () => {
  it('keeps section HTML verbatim so images reach the PDF and Word file', () => {
    const md = composeRcaMarkdown({
      ...EMPTY_RCA_FIELDS,
      title: 'MEDU Downtime',
      rootCause: '<p>Cloudflare challenged the login request.</p><img src="data:image/png;base64,AAAA" alt="rule.png">',
    });
    expect(md).toContain('## 3. Root Cause');
    expect(md).toContain('<img src="data:image/png;base64,AAAA" alt="rule.png">');
  });

  it('omits a section whose editor holds only an empty paragraph', () => {
    const md = composeRcaMarkdown({ ...EMPTY_RCA_FIELDS, title: 'X', impact: '<p><br></p>' });
    expect(md).not.toContain('## 2. Impact');
  });
});

// The tracker is the engineer's record, drafted by the AI where they left it blank, and rides at
// the end of the report, after section 7.
describe('composeTrackerMarkdown', () => {
  const tracker = (fields: Partial<RcaTrackerFields> = {}) => ({ ...EMPTY_TRACKER_FIELDS, ...fields });

  it('prints one labelled line per filled field, in report order', () => {
    const md = composeTrackerMarkdown(tracker({
      detection: 'Login stuck on a spinner, reported by a user.',
      rootCauseIdentified: 'A firewall rule challenged the login request.',
      outcome: '0 login failures since 14:20 SGT.',
    }));
    expect(md).toContain('## Tracker');
    expect(md).toContain('**Detection / Symptoms:** Login stuck on a spinner, reported by a user.');
    expect(md).toContain('**Root Cause Identified:** A firewall rule challenged the login request.');
    expect(md).toContain('**Measurable Outcome:** 0 login failures since 14:20 SGT.');
    expect(md.indexOf('Detection / Symptoms')).toBeLessThan(md.indexOf('Root Cause Identified'));
    expect(md.indexOf('Root Cause Identified')).toBeLessThan(md.indexOf('Measurable Outcome'));
  });

  // A blank field is left out rather than printed as an empty label.
  it('omits blank fields', () => {
    const md = composeTrackerMarkdown(tracker({ detection: 'Seen in the login flow.' }));
    expect(md).toContain('**Detection / Symptoms:**');
    expect(md).not.toContain('**Corrective Action Taken:**');
    expect(md).not.toContain('**Measurable Outcome:**');
  });

  it('returns nothing when the tracker is untouched', () => {
    expect(composeTrackerMarkdown(tracker())).toBe('');
    expect(composeTrackerMarkdown(tracker({ outcome: '   ' }))).toBe('');
  });

  it('reports emptiness from the fields alone', () => {
    expect(isTrackerEmpty(tracker())).toBe(true);
    expect(isTrackerEmpty(tracker({ correctiveAction: '  ' }))).toBe(true);
    expect(isTrackerEmpty(tracker({ correctiveAction: 'Removed the rule.' }))).toBe(false);
  });
});

describe('composeRcaMarkdown with a tracker', () => {
  const fields = { ...EMPTY_RCA_FIELDS, title: 'MEDU Downtime', status: '<p>Resolved.</p>' };

  it('appends the tracker after the last section', () => {
    const md = composeRcaMarkdown(fields, '', { ...EMPTY_TRACKER_FIELDS, detection: 'Reported by a user.' });
    expect(md).toContain('## Tracker');
    expect(md.indexOf('## 7. Current Status')).toBeLessThan(md.indexOf('## Tracker'));
  });

  it('omits the tracker heading when nothing is tracked', () => {
    expect(composeRcaMarkdown(fields, '', { ...EMPTY_TRACKER_FIELDS })).not.toContain('Tracker');
    expect(composeRcaMarkdown(fields)).not.toContain('Tracker');
  });
});

// A generated report now closes with a Tracker block, and its five lines have to come back
// into the form. Parsed on its own rather than through parseRcaFields: the heading carries
// no section number, so scanning the whole document would also match a label the engineer
// happened to quote inside a section.
describe('parseTrackerFields', () => {
  const report = [
    '## 7. Current Status', 'Resolved and being watched.', '',
    '## Tracker', '',
    '**Detection / Symptoms:** Login stuck on a spinner, reported by a user.  ',
    '**Root Cause Identified:** Bot Fight Mode challenged the auth request.  ',
    '**Corrective Action Taken:** Rule disabled at 14:20 SGT.  ',
    '**Preventive / Improvement Action:** Exempt /auth from the challenge.  ',
    '**Measurable Outcome:** 0 login failures since 14:20 SGT.  ',
  ].join('\n');

  it('pulls every field out of the Tracker block', () => {
    expect(parseTrackerFields(report)).toEqual({
      detection: 'Login stuck on a spinner, reported by a user.',
      rootCauseIdentified: 'Bot Fight Mode challenged the auth request.',
      correctiveAction: 'Rule disabled at 14:20 SGT.',
      preventiveAction: 'Exempt /auth from the challenge.',
      outcome: '0 login failures since 14:20 SGT.',
    });
  });

  it('round-trips what composeTrackerMarkdown writes', () => {
    const fields = { ...EMPTY_TRACKER_FIELDS, detection: 'Seen in the login flow.', outcome: 'Back to 400/day.' };
    expect(parseTrackerFields(composeTrackerMarkdown(fields))).toEqual({
      detection: 'Seen in the login flow.',
      outcome: 'Back to 400/day.',
    });
  });

  it('reads the labels without bold markers', () => {
    expect(parseTrackerFields('## Tracker\n\nDetection / Symptoms: Reported by a user.').detection)
      .toBe('Reported by a user.');
  });

  it('ignores a label quoted outside the Tracker block', () => {
    const md = '## 1. Background\n**Measurable Outcome:** not a tracker line.\n\n## Tracker\n\n**Detection / Symptoms:** Real one.';
    const out = parseTrackerFields(md);
    expect(out.detection).toBe('Real one.');
    expect(out.outcome).toBeUndefined();
  });

  it('stops at the next heading rather than swallowing it', () => {
    const md = '## Tracker\n\n**Detection / Symptoms:** First.\n\n## Appendix\n\n**Measurable Outcome:** Later.';
    expect(parseTrackerFields(md).outcome).toBeUndefined();
  });

  it('returns nothing for a report with no Tracker block, or no report at all', () => {
    expect(parseTrackerFields('## 7. Current Status\nResolved.')).toEqual({});
    expect(parseTrackerFields('')).toEqual({});
  });
});
