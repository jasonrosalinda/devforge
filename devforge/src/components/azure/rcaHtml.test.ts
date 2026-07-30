import { describe, it, expect } from 'vitest';
import {
  splitQuickSummary, buildRcaPrintHtml, formatSgt, formatSgtRange,
  buildQuickSummaryTeamsHtml, buildQuickSummaryTeamsText,
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
