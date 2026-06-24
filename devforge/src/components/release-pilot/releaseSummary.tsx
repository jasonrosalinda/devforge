// Release Pilot — Release Summary tab. Aggregates the parsed runbook sections
// into a release summary: a themed on-screen render plus a copyable plain-text
// + rich-HTML block matching the standard summary format.

import { useMemo } from 'react';
import { Copy } from 'lucide-react';
import { StatusPill } from './statusPill';
import { RICH } from './runbookTable';
import type { RunbookSection, RunbookRow, RunbookImage, StatusColor } from '@/lib/parse-runbook';

interface ReleaseSummaryProps {
  sections: RunbookSection[];
  goals?: string[];
  releaseTitle?: string | undefined;
  releaseLabel?: string | undefined;
  schedule?: { date: string; time: string } | undefined;
  onImageClick?: (img: RunbookImage) => void;
  onCopyImage?: (src: string) => void;
  closure?: boolean;
}

// ── Formatting helpers ─────────────────────────────────────────────────────────

function mapHeading(title: string): string {
  if (/post[\s-]*prod/i.test(title)) return 'Post-Deployment Runbook';
  if (/pre[\s-]*prod/i.test(title)) return 'Pre-Deployment Runbook';
  if (/prod/i.test(title)) return 'Deployment Runbook';
  return title;
}

function firstNames(pics: string[]): string {
  return pics.map(p => p.split(' ')[0]).filter(Boolean).join('/');
}

// Some runbooks put responsible people in the Status column, so they surface as
// a "/"-separated name pill (e.g. "SHANDY WIBAWA / CAREN CONRADO"). Reduce each
// multi-word name to its first name. Real statuses ("Done", "In Progress") have
// no "/" and pass through untouched.
function shortenNames(text: string): string {
  if (!text.includes('/')) return text;
  return text
    .split('/')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => (p.includes(' ') ? p.split(/\s+/)[0] : p))
    .join(' / ');
}

// A real status is a short keyword (rendered UPPERCASE by convention). Anything
// else in the status slot is a person/PIC name → keep its original Confluence
// casing instead of uppercasing it.
const STATUS_KEYWORD_RE = /^(done|complete[d]?|success|pass(ed)?|ok|deployed|fail(ed)?|error|blocked|cancel(led)?|reject(ed)?|pending|in[\s-]?progress|wip|to[\s-]?do|on[\s-]?hold|hold|wait(ing)?|n\/?a|yes|no)$/i;
function isStatusName(text: string): boolean {
  return !STATUS_KEYWORD_RE.test(text.trim());
}

function normTime(t: string): string {
  return t.toLowerCase().replace(/\s*(am|pm)/g, '$1').trim();
}

function normDate(d: string): string {
  const parsed = new Date(d);
  if (!d || isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// "Deployment release notice: MEDU v6.21.1 (Hotfix Release) - 02 Jun 2026 (5:00 pm SGT onwards)"
// Head comes from the plan's "High-level Schedule" label ("MEDU v6.21.1 - Hotfix Release",
// reformatted to "MEDU v6.21.1 (Hotfix Release)"); date from the runbook title; time from
// the deployment (Prod) section's first activity.
function buildNotice(
  title: string | undefined,
  sections: RunbookSection[],
  releaseLabel?: string,
  schedule?: { date: string; time: string },
): string {
  // Head: prefer the plan label, reformatting "X - Y" → "X (Y)".
  let head = '';
  if (releaseLabel) {
    const m = releaseLabel.match(/^(.*?)\s*-\s*(.*)$/);
    head = m && m[1] && m[2] ? `${m[1].trim()} (${m[2].trim()})` : releaseLabel.trim();
  } else if (title) {
    const product = (title.match(/\b(MEDU|MSP)\b/i)?.[1] || '').toUpperCase();
    const verMatch = title.match(/\bv\d+(?:\.\d+)+/i);
    const version = verMatch ? verMatch[0].replace(/^v/i, 'V') : '';
    const type = /hotfix/i.test(title) ? 'Hotfix Release' : 'Scheduled Release';
    const base = [product, version].filter(Boolean).join(' ');
    head = base ? `${base} (${type})` : '';
  }
  if (!head) return '';

  // Date/time: prefer the plan's PROD Deployment schedule (Actual → Original).
  let date = schedule?.date ? normDate(schedule.date) : '';
  if (!date) {
    const dateMatch = (title || '').match(/\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b/);
    date = dateMatch ? normDate(dateMatch[0]) : '';
  }
  let time = schedule?.time ? schedule.time.trim().toLowerCase() : '';
  if (!time) {
    const prod = sections.find(s => /prod/i.test(s.title) && !/pre|post/i.test(s.title)) || sections[0];
    const rawTime = prod?.typedRows?.[0]?.time || '';
    time = rawTime ? rawTime.split('-')[0]?.trim().toLowerCase() ?? '' : '';
  }

  const tail = date ? ` - ${date}${time ? ` (${time} SGT onwards)` : ''}` : '';
  return `Deployment release notice: ${head}${tail}`;
}

// First meaningful line of the activity, dropping app-name lozenges & sub-bullets.
function activityTitle(row: RunbookRow): string {
  const doc = new DOMParser().parseFromString(row.activityHtml || '', 'text/html');
  doc.body.querySelectorAll('.aui-lozenge, .status-macro, ul, ol').forEach(n => n.remove());
  doc.body.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  doc.body.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6').forEach(b => b.append('\n'));
  const lines = (doc.body.textContent || '')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return lines[0] || row.activity.split('\n')[0]?.trim() || '';
}

// ── Model ──────────────────────────────────────────────────────────────────────

interface SummaryItem {
  title: string;
  pics: string[];
  status: { text: string; color: StatusColor } | null;
}
interface TimeGroup { time: string; items: SummaryItem[] }
interface DateGroup { date: string; timeGroups: TimeGroup[] }
interface SummarySection { heading: string; dates: DateGroup[] }

// Testing-activity matchers. SANITY anchored to "IT Internal Testing" so phrases
// like "…during internal testing/sanity check" elsewhere don't match.
const SANITY_RE = /\bit\s+internal\s+testing\b/i;
const QC_RE = /start[:\s]+qc\s*testing/i;
// Monitoring rows — GA real-time + PSM checking/monitoring — whose 15-min
// screenshots feed this section. Postproduction monitoring is explicitly
// excluded. (QC_RE / SANITY_RE never contain "monitor", no overlap.)
const GA_RE = /^(?!.*postproduction).*\bmonitor/i;

interface LogEntry {
  html: string;             // logbook cell HTML (drawers + images preserved)
  images: RunbookImage[];
  notes: string[];
  time: string;             // the row's Time column (fallback when log has no time)
}
function collectLogs(sections: RunbookSection[], re: RegExp): LogEntry[] {
  const out: LogEntry[] = [];
  for (const s of sections) for (const row of s.typedRows) {
    if (!re.test(row.activity)) continue;
    out.push({ html: row.logbook.html, images: row.logbook.images, notes: row.logbook.notes, time: row.time });
  }
  return out;
}

// GA Monitoring: each drawer is "time → screenshot(+log)". Returns per-drawer
// time + log text + images, plus loose images/notes outside drawers.
interface GaDrawer { time: string; notes: string[]; images: RunbookImage[] }
interface GaContent { drawers: GaDrawer[]; looseImages: RunbookImage[]; looseNotes: string[] }

// Bullet/line text of an element (li bullets, else block lines), preserving structure.
function bodyLines(el: Element): string[] {
  const lis = Array.from(el.querySelectorAll('li')).map(li => clean(li.textContent || '')).filter(Boolean);
  if (lis.length) return lis;
  const c = el.cloneNode(true) as HTMLElement;
  c.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
  c.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6').forEach(b => b.append('\n'));
  return (c.textContent || '').split('\n').map(l => clean(l)).filter(Boolean);
}

// Unify drawer + loose content into blocks of "screenshot(s) then notes".
interface GaBlock { time: string; images: RunbookImage[]; notes: string[] }
function gaBlocks(c: GaContent, fallbackTime = ''): GaBlock[] {
  if (c.drawers.length) return c.drawers.map(d => ({ time: d.time, images: d.images, notes: d.notes }));
  if (c.looseImages.length || c.looseNotes.length) return [{ time: fallbackTime, images: c.looseImages, notes: c.looseNotes }];
  return [];
}

function parseGa(html: string): GaContent {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const imgsOf = (root: ParentNode): RunbookImage[] =>
    Array.from(root.querySelectorAll('img'))
      .map(img => ({ src: img.getAttribute('src') || '', name: img.getAttribute('alt') || 'screenshot', orig: img.getAttribute('data-orig-src') || '' }))
      .filter(i => i.src);

  const drawers: GaDrawer[] = [];
  doc.querySelectorAll('details').forEach(d => {
    const time = clean(d.querySelector('summary')?.textContent || '');
    const images = imgsOf(d);
    const body = d.cloneNode(true) as HTMLElement;
    body.querySelector('summary')?.remove();
    body.querySelectorAll('img').forEach(n => n.remove());
    drawers.push({ time, notes: bodyLines(body), images });
    d.remove();
  });

  const looseImages = imgsOf(doc.body);
  const looseNotes: string[] = [];
  doc.body.querySelectorAll('li').forEach(li => {
    const t = clean(li.textContent || '');
    if (t) looseNotes.push(t);
  });
  return { drawers, looseImages, looseNotes };
}

// All image data URIs embedded in a logbook cell HTML.
function logImageSrcs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return Array.from(doc.body.querySelectorAll('img'))
    .map(img => img.getAttribute('src') || '')
    .filter(s => s.startsWith('data:'));
}

// Parse a sanity logbook cell into title→screenshot drawers (from expand
// macros → <details>) plus any loose images / notes.
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
interface SanityDrawer { title: string; images: RunbookImage[] }
interface SanityContent { drawers: SanityDrawer[]; looseImages: RunbookImage[]; looseNotes: string[] }

function parseSanityContent(html: string): SanityContent {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const imgsOf = (root: ParentNode): RunbookImage[] =>
    Array.from(root.querySelectorAll('img'))
      .map(img => ({ src: img.getAttribute('src') || '', name: img.getAttribute('alt') || 'screenshot', orig: img.getAttribute('data-orig-src') || '' }))
      .filter(i => i.src);

  const drawers: SanityDrawer[] = [];
  doc.querySelectorAll('details').forEach(d => {
    const summary = d.querySelector('summary');
    const title = clean(summary?.textContent || '') || 'Section';
    drawers.push({ title, images: imgsOf(d) });
    d.remove();
  });

  const looseImages = imgsOf(doc.body);
  const looseNotes: string[] = [];
  doc.body.querySelectorAll('li').forEach(li => {
    const t = clean(li.textContent || '');
    if (t) looseNotes.push(t);
  });

  return { drawers, looseImages, looseNotes };
}

function buildSummary(sections: RunbookSection[]): SummarySection[] {
  const out: SummarySection[] = [];

  for (const section of sections) {
    const dates: DateGroup[] = [];

    for (const row of section.typedRows) {
      const title = activityTitle(row);
      if (!title) continue;

      const date = normDate(row.date);
      const time = normTime(row.time);
      const item: SummaryItem = { title, pics: row.pics, status: row.status };

      let dateGroup = dates.find(d => d.date === date);
      if (!dateGroup) { dateGroup = { date, timeGroups: [] }; dates.push(dateGroup); }

      // Append to the last time group if it matches; else start a new one.
      const last = dateGroup.timeGroups[dateGroup.timeGroups.length - 1];
      if (last && last.time === time) last.items.push(item);
      else dateGroup.timeGroups.push({ time, items: [item] });
    }

    if (dates.length > 0) out.push({ heading: mapHeading(section.title), dates });
  }

  return out;
}

function lineFor(item: SummaryItem): string {
  const pics = firstNames(item.pics);
  const picPart = pics ? ` (${pics})` : '';
  const statusPart = item.status?.text ? ` - ${shortenNames(item.status.text)}` : '';
  return `${item.title}${picPart}${statusPart}`;
}

const GOALS_LABEL = 'What to Expect in This Release';

const PLAIN_DIVIDER = '────────────────────────────';

// Plain-text lines for a list of log entries — the logbook content as-is
// (headings, bullets, screenshots-as-placeholders), preserving line breaks.
function logsPlain(entries: LogEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const doc = new DOMParser().parseFromString(e.html || '', 'text/html');
    doc.body.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
    doc.body.querySelectorAll('img').forEach(im => im.replaceWith(`\n[screenshot: ${im.getAttribute('alt') || 'screenshot'}]\n`));
    doc.body.querySelectorAll('li').forEach(li => li.prepend('- '));
    doc.body.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6, summary').forEach(b => b.append('\n'));
    (doc.body.textContent || '')
      .split('\n')
      .map(l => l.replace(/[ \t ]+/g, ' ').trim())
      .filter(Boolean)
      .forEach(l => out.push(l));
  }
  return out;
}

// Plain-text lines for sanity entries — drawer title → screenshot placeholder.
function sanityPlain(entries: LogEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const c = parseSanityContent(e.html);
    for (const n of c.looseNotes) out.push(`- ${n}`);
    for (const d of c.drawers) out.push(`${d.title} — ${d.images.map(i => `[screenshot: ${i.name}]`).join(' ') || '(no screenshot)'}`);
    if (!c.drawers.length) for (const img of c.looseImages) out.push(`[screenshot: ${img.name}]`);
  }
  return out;
}

// Plain-text lines for GA entries — screenshot then "time" then logs.
function gaPlain(entries: LogEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    for (const b of gaBlocks(parseGa(e.html), e.time)) {
      for (const img of b.images) out.push(`[screenshot: ${img.name}]`);
      if (b.time) out.push(b.time);
      for (const n of b.notes) out.push(`- ${n}`);
    }
  }
  return out;
}

function toPlainText(model: SummarySection[], goals: string[] = [], notice = '', qc: LogEntry[] = [], sanity: LogEntry[] = [], ga: LogEntry[] = [], includeTesting = true, closure = false): string {
  const out: string[] = [];
  if (closure) { out.push('RELEASE CLOSURE'); out.push(PLAIN_DIVIDER); }
  if (notice) { out.push(notice); out.push(PLAIN_DIVIDER); }
  if (goals.length) {
    out.push(GOALS_LABEL, ...goals.map(g => `- ${g}`));
    out.push(PLAIN_DIVIDER);
  }
  for (const section of model) {
    out.push(section.heading);
    for (const dg of section.dates) {
      out.push(`----${dg.date}----`);
      for (const tg of dg.timeGroups) {
        const indent = ' '.repeat(`${tg.time} - `.length + 4);
        tg.items.forEach((item, i) => {
          if (i === 0) out.push(`${tg.time} - ${lineFor(item)}`);
          else out.push(`${indent}- ${lineFor(item)}`);
        });
      }
    }
    out.push(PLAIN_DIVIDER);
  }
  if (includeTesting && (model.length || qc.length || sanity.length || ga.length)) {
    out.push('Testing Results');
    if (qc.length) { out.push(...logsPlain(qc)); }
    if (sanity.length) { out.push('Sanity Check', ...sanityPlain(sanity)); }
    if (ga.length) { out.push('GA Monitoring', ...gaPlain(ga)); }
    if (!qc.length && !sanity.length && !ga.length) out.push('(no testing results)');
    out.push(PLAIN_DIVIDER);
  }
  return out.join('\n');
}

// ── Rich HTML output (for pasting into MS Teams / email) ───────────────────────

const STATUS_HEX: Record<StatusColor, string> = {
  green: '#16a34a', yellow: '#d97706', red: '#dc2626',
  blue: '#2563eb', purple: '#7c3aed', grey: '#6b7280',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Strip verbose Confluence markup (classes, styles, data-* except data-orig-src)
// to shrink the clipboard HTML. Keeps src/href/alt and collapses whitespace.
function stripMarkup(html: string): string {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.body.querySelectorAll('*').forEach(el => {
    for (const attr of Array.from(el.attributes)) {
      const n = attr.name.toLowerCase();
      if (n !== 'src' && n !== 'href' && n !== 'alt' && n !== 'data-orig-src') el.removeAttribute(attr.name);
    }
  });
  return doc.body.innerHTML.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}

function statusHtml(item: SummaryItem): string {
  if (!item.status?.text) return '';
  return ` - <span style="color:${STATUS_HEX[item.status.color]};font-weight:600">${esc(shortenNames(item.status.text))}</span>`;
}

function lineHtml(item: SummaryItem): string {
  const pics = firstNames(item.pics);
  const picPart = pics ? ` (${esc(pics)})` : '';
  return `${esc(item.title)}${picPart}${statusHtml(item)}`;
}

// All unique testing screenshot data URIs (QC + sanity) — pre-shrunk for clipboard.
// GA screenshots are excluded from the clipboard (too many → paste limit); only
// QC + sanity images are embedded. GA images remain on-screen and in Export.
export function testingImageSrcs(sections: RunbookSection[]): string[] {
  const set = new Set<string>();
  for (const e of [...collectLogs(sections, QC_RE), ...collectLogs(sections, SANITY_RE)]) {
    for (const s of logImageSrcs(e.html)) set.add(s);
  }
  return Array.from(set);
}

// Rich-HTML for a list of log entries — the logbook content as-is, with
// screenshots constrained and their data URIs swapped for shrunk versions.
function logsHtml(entries: LogEntry[], imgMap: Map<string, string>): string[] {
  return entries.map(e => {
    let html = stripMarkup(e.html);
    for (const [orig, small] of imgMap) html = html.split(orig).join(small);
    // Constrain thumbnail width for the paste.
    html = html.replace(/<img /g, '<img style="max-width:200px;height:auto" ');
    // Wrap each thumbnail in a link to the original full-res Confluence image.
    html = html.replace(/<img\b[^>]*?\bdata-orig-src="([^"]+)"[^>]*>/g,
      (m, orig) => `<a href="${orig}" target="_blank" rel="noopener">${m}</a>`);
    return `<div>${html}</div>`;
  });
}

// A thumbnail (shrunk data URI) linked to the full-res Confluence image so the
// clipboard stays small but clicking opens the original.
function imgTag(img: RunbookImage, mapSrc: (s: string) => string, style: string): string {
  const thumb = `<img src="${mapSrc(img.src)}" alt="${esc(img.name)}" style="${style}"/>`;
  return img.orig ? `<a href="${img.orig}" target="_blank" rel="noopener">${thumb}</a>` : thumb;
}

// Rich-HTML for sanity entries — a 3-column screenshot/title table.
function sanityHtml(entries: LogEntry[], imgMap: Map<string, string>): string[] {
  const mapSrc = (s: string) => imgMap.get(s) ?? s;
  const p: string[] = [];
  for (const e of entries) {
    const c = parseSanityContent(e.html);
    if (c.looseNotes.length) {
      p.push('<ul style="margin:2px 0">');
      for (const n of c.looseNotes) p.push(`<li>${esc(n)}</li>`);
      p.push('</ul>');
    }
    if (c.drawers.length) {
      p.push('<table style="border-collapse:collapse;table-layout:fixed;width:600px;margin:4px 0">');
      for (let i = 0; i < c.drawers.length; i += 3) {
        const chunk = c.drawers.slice(i, i + 3);
        p.push('<tr>');
        for (const d of chunk) {
          const imgs = d.images.map(im => imgTag(im, mapSrc, 'width:100%;max-width:100%;display:block;margin:0 auto')).join('') || '&mdash;';
          p.push(`<td style="border:1px solid #ddd;padding:6px;vertical-align:top;text-align:center;width:200px;word-break:break-word;font-size:12px">${imgs}<div style="font-weight:600;margin-top:4px">${esc(d.title)}</div></td>`);
        }
        for (let k = chunk.length; k < 3; k++) p.push('<td style="border:1px solid #ddd;width:200px"></td>');
        p.push('</tr>');
      }
      p.push('</table>');
    } else {
      for (const img of c.looseImages) {
        p.push(`<p style="margin:4px 0">${imgTag(img, mapSrc, 'max-width:200px;border:1px solid #ddd;border-radius:4px')}</p>`);
      }
    }
  }
  return p;
}

// Rich-HTML for GA entries — screenshot then "time - log" caption per drawer.
function gaHtml(entries: LogEntry[], imgMap: Map<string, string> = new Map(), withImages = false): string[] {
  const mapSrc = (s: string) => imgMap.get(s) ?? s;
  const blocks = entries.flatMap(e => gaBlocks(parseGa(e.html), e.time));
  if (!blocks.length) return [];
  // Copy omits GA screenshots (count → paste size); Export includes them.
  const p: string[] = ['<table style="border-collapse:collapse;table-layout:fixed;width:400px;margin:4px 0">'];
  for (let i = 0; i < blocks.length; i += 2) {
    const chunk = blocks.slice(i, i + 2);
    p.push('<tr>');
    for (const b of chunk) {
      const imgs = withImages ? b.images.map(im => imgTag(im, mapSrc, 'width:100%;max-width:100%;display:block;margin:0 0 4px')).join('') : '';
      const notes = b.notes.length ? `<ul style="margin:2px 0;padding-left:16px">${b.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
      const time = b.time ? `<div style="font-weight:600;margin:2px 0">${esc(b.time)}</div>` : '';
      p.push(`<td style="border:1px solid #ddd;padding:6px;vertical-align:top;width:200px;word-break:break-word;font-size:12px">${imgs}${time}${notes}</td>`);
    }
    for (let k = chunk.length; k < 2; k++) p.push('<td style="border:1px solid #ddd;width:200px"></td>');
    p.push('</tr>');
  }
  p.push('</table>');
  return p;
}

function toHtml(model: SummarySection[], goals: string[] = [], notice = '', qc: LogEntry[] = [], sanity: LogEntry[] = [], ga: LogEntry[] = [], imgMap: Map<string, string> = new Map(), gaImages = false, includeTesting = true, closure = false): string {
  const HR = '<hr style="border:none;border-top:1px solid #ddd;margin:12px 0"/>';
  const p: string[] = ['<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">'];
  if (closure) {
    p.push('<p style="font-size:22px;font-weight:700;color:#16a34a;margin:0 0 10px">Release Closure</p>');
  }
  if (notice) {
    p.push(`<p style="margin:2px 0"><strong>${esc(notice)}</strong></p>`);
    p.push(HR);
  }
  if (goals.length) {
    p.push(`<p style="margin:2px 0"><strong>${GOALS_LABEL}</strong></p>`);
    p.push('<ul style="margin:2px 0">');
    for (const g of goals) p.push(`<li>${esc(g)}</li>`);
    p.push('</ul>');
    p.push(HR);
  }
  for (const section of model) {
    p.push(`<p style="margin:8px 0 2px"><strong>${esc(section.heading)}</strong></p>`);
    // A 2-column table (time | activity) keeps the time column aligned when
    // pasted into Teams/Outlook — &nbsp; indentation collapses in their fonts.
    p.push('<table style="border-collapse:collapse;margin:2px 0">');
    for (const dg of section.dates) {
      p.push(`<tr><td colspan="2" style="padding:4px 0 1px;color:#6b7280">----${esc(dg.date)}----</td></tr>`);
      for (const tg of dg.timeGroups) {
        tg.items.forEach((item, i) => {
          const timeCell = i === 0 ? `<strong>${esc(tg.time)}</strong>` : '';
          p.push(
            `<tr><td style="padding:1px 14px 1px 0;vertical-align:top;white-space:nowrap">${timeCell}</td>` +
            `<td style="padding:1px 0;vertical-align:top">- ${lineHtml(item)}</td></tr>`,
          );
        });
      }
    }
    p.push('</table>');
    p.push(HR);
  }
  if (includeTesting && (model.length || qc.length || sanity.length || ga.length)) {
    p.push('<p style="margin:8px 0 2px"><strong>Testing Results</strong></p>');
    if (qc.length) {
      p.push(...logsHtml(qc, imgMap));
    }
    if (sanity.length) {
      p.push('<p style="margin:8px 0 2px"><strong>Sanity Check</strong></p>');
      p.push(...sanityHtml(sanity, imgMap));
    }
    if (ga.length) {
      p.push('<p style="margin:8px 0 2px"><strong>GA Monitoring</strong></p>');
      p.push(...gaHtml(ga, imgMap, gaImages));
    }
    if (!qc.length && !sanity.length && !ga.length) p.push('<p style="margin:2px 0;color:#6b7280">No testing results.</p>');
    p.push(HR);
  }
  p.push('</div>');
  return p.join('');
}

// Build both clipboard formats (used by the page's Copy button in the tab row).
export function summaryClipboard(sections: RunbookSection[], goals: string[] = [], releaseTitle?: string, releaseLabel?: string, schedule?: { date: string; time: string }, imgMap?: Map<string, string>, gaImages = false, closure = false): { plainText: string; html: string; empty: boolean } {
  const model = buildSummary(sections);
  const notice = buildNotice(releaseTitle, sections, releaseLabel, schedule);
  const qc = collectLogs(sections, QC_RE);
  const sanity = collectLogs(sections, SANITY_RE);
  const ga = collectLogs(sections, GA_RE);
  return {
    // Testing block (Testing Results + Sanity + GA) only when closure is on.
    plainText: toPlainText(model, goals, notice, qc, sanity, ga, closure, closure),
    html: toHtml(model, goals, notice, qc, sanity, ga, imgMap, gaImages, closure, closure),
    empty: model.length === 0 && goals.length === 0,
  };
}

// ── Per-section copy (each paste carries only its own images → fits Teams) ──────

export type CopyScope = 'summary' | 'qc' | 'sanity' | 'ga';

// Image data URIs for a single scope (to pre-shrink only what that copy needs).
export function scopeImageSrcs(scope: CopyScope, sections: RunbookSection[]): string[] {
  const re = scope === 'qc' ? QC_RE : scope === 'sanity' ? SANITY_RE : scope === 'ga' ? GA_RE : null;
  if (!re) return [];
  const set = new Set<string>();
  for (const e of collectLogs(sections, re)) for (const s of logImageSrcs(e.html)) set.add(s);
  return Array.from(set);
}

// Clipboard formats for one scope. 'summary' = notice + goals + runbook tables
// (no testing). 'qc'/'sanity'/'ga' = just that subsection's logs, full quality.
export function sectionClipboard(
  scope: CopyScope,
  sections: RunbookSection[],
  goals: string[] = [],
  releaseTitle?: string,
  releaseLabel?: string,
  schedule?: { date: string; time: string },
  imgMap: Map<string, string> = new Map(),
): { plainText: string; html: string } {
  if (scope === 'summary') {
    const model = buildSummary(sections);
    const notice = buildNotice(releaseTitle, sections, releaseLabel, schedule);
    return {
      plainText: toPlainText(model, goals, notice, [], [], [], false),
      html: toHtml(model, goals, notice, [], [], [], imgMap, false, false),
    };
  }

  const qc = scope === 'qc' ? collectLogs(sections, QC_RE) : [];
  const sanity = scope === 'sanity' ? collectLogs(sections, SANITY_RE) : [];
  const ga = scope === 'ga' ? collectLogs(sections, GA_RE) : [];

  const plain: string[] = ['Testing Results'];
  const html: string[] = ['<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px"><p style="margin:8px 0 2px"><strong>Testing Results</strong></p>'];

  if (scope === 'qc') {
    plain.push(...logsPlain(qc));
    html.push(...logsHtml(qc, imgMap));
  } else if (scope === 'sanity') {
    plain.push('Sanity Check', ...sanityPlain(sanity));
    html.push('<p style="margin:8px 0 2px"><strong>Sanity Check</strong></p>', ...sanityHtml(sanity, imgMap));
  } else {
    plain.push('GA Monitoring', ...gaPlain(ga));
    html.push('<p style="margin:8px 0 2px"><strong>GA Monitoring</strong></p>', ...gaHtml(ga, imgMap, true));
  }
  html.push('</div>');
  return { plainText: plain.join('\n'), html: html.join('') };
}

// ── Component ────────────────────────────────────────────────────────────────

// A screenshot thumbnail: click → lightbox; hover → Copy button (top-right).
function Thumb({ img, className, onImageClick, onCopyImage }: {
  img: RunbookImage;
  className?: string;
  onImageClick?: ((img: RunbookImage) => void) | undefined;
  onCopyImage?: ((src: string) => void) | undefined;
}) {
  return (
    <div className="group/thumb relative">
      <button type="button" onClick={() => onImageClick?.(img)} className="block w-full overflow-hidden rounded border border-border" title={img.name}>
        <img src={img.src} alt={img.name} className={className ?? 'h-24 w-full object-cover transition hover:opacity-80'} />
      </button>
      {onCopyImage && (
        <button
          type="button"
          onClick={() => onCopyImage(img.src)}
          title="Copy image (full resolution)"
          className="absolute right-1 top-1 z-10 rounded border border-border bg-background/80 p-1 text-muted-foreground opacity-0 shadow-sm transition hover:text-foreground group-hover/thumb:opacity-100"
        >
          <Copy className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

// Renders one testing subsection's logbook content as-is (headings, bullets,
// screenshots in place), styled to the app theme. Clicking an image zooms it.
function LogEntryList({ entries, onImageClick }: { entries: LogEntry[]; onImageClick?: ((img: RunbookImage) => void) | undefined }) {
  const handleClick = (ev: React.MouseEvent<HTMLDivElement>) => {
    const t = ev.target as HTMLElement;
    if (t.tagName === 'IMG') {
      const im = t as HTMLImageElement;
      onImageClick?.({ src: im.src, name: im.getAttribute('alt') || 'screenshot' });
    }
  };
  return (
    <>
      {entries.map((e, i) => (
        <div key={i} className={`runbook-cell ${RICH}`} onClick={handleClick} dangerouslySetInnerHTML={{ __html: e.html }} />
      ))}
    </>
  );
}

// Renders sanity entries as drawer cards (screenshot over title), wrapping.
function SanityDrawers({ entries, onImageClick, onCopyImage }: { entries: LogEntry[]; onImageClick?: ((img: RunbookImage) => void) | undefined; onCopyImage?: ((src: string) => void) | undefined }) {
  return (
    <>
      {entries.map((e, i) => {
        const c = parseSanityContent(e.html);
        return (
          <div key={i} className="flex flex-col gap-2">
            {c.looseNotes.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                {c.looseNotes.map((n, ni) => <li key={ni}>{n}</li>)}
              </ul>
            )}
            {c.drawers.length > 0 ? (
              <div className="flex flex-wrap gap-3">
                {c.drawers.map((d, di) => (
                  <div key={di} className="flex w-44 flex-col gap-1">
                    {d.images.map((img, ii) => (
                      <Thumb key={ii} img={img} onImageClick={onImageClick} onCopyImage={onCopyImage} />
                    ))}
                    <span className="text-center text-xs font-medium">{d.title}</span>
                  </div>
                ))}
              </div>
            ) : (
              c.looseImages.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {c.looseImages.map((img, ii) => (
                    <div key={ii} className="w-44">
                      <Thumb img={img} onImageClick={onImageClick} onCopyImage={onCopyImage} />
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        );
      })}
    </>
  );
}

// Renders GA entries as cards: screenshot then "time - log" caption.
function GaDrawers({ entries, onImageClick, onCopyImage }: { entries: LogEntry[]; onImageClick?: ((img: RunbookImage) => void) | undefined; onCopyImage?: ((src: string) => void) | undefined }) {
  const blocks = entries.flatMap(e => gaBlocks(parseGa(e.html), e.time));
  return (
    <div className="grid grid-cols-2 gap-3">
      {blocks.map((b, bi) => (
        <div key={bi} className="flex flex-col gap-1 rounded-md border border-border p-2">
          {b.images.map((img, ii) => (
            <div key={ii} className="w-44">
              <Thumb img={img} onImageClick={onImageClick} onCopyImage={onCopyImage} />
            </div>
          ))}
          {b.time && <span className="text-xs font-medium">{b.time}</span>}
          {b.notes.length > 0 && (
            <ul className="list-disc pl-4 text-xs text-muted-foreground space-y-0.5">
              {b.notes.map((n, ni) => <li key={ni}>{n}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export function ReleaseSummary({ sections, goals = [], releaseTitle, releaseLabel, schedule, onImageClick, onCopyImage, closure = false }: ReleaseSummaryProps) {
  const model = useMemo(() => buildSummary(sections), [sections]);
  const notice = useMemo(() => buildNotice(releaseTitle, sections, releaseLabel, schedule), [releaseTitle, sections, releaseLabel, schedule]);
  const qc = useMemo(() => collectLogs(sections, QC_RE), [sections]);
  const sanity = useMemo(() => collectLogs(sections, SANITY_RE), [sections]);
  const ga = useMemo(() => collectLogs(sections, GA_RE), [sections]);

  if (model.length === 0 && goals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/20 py-16 text-muted-foreground">
        <p className="text-sm">No runbook activities to summarize.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-border overflow-auto max-h-[calc(100vh-380px)] p-4">
        <div className="flex flex-col gap-4">
          {closure && (
            <h2 className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">Release Closure</h2>
          )}
          {notice && (
            <div className="border-b border-border pb-4">
              <p className="text-sm font-semibold">{notice}</p>
            </div>
          )}
          {goals.length > 0 && (
            <div className="flex flex-col gap-1 border-b border-border pb-4">
              <h3 className="text-sm font-semibold">{GOALS_LABEL}</h3>
              <ul className="list-disc pl-5 text-xs space-y-0.5">
                {goals.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </div>
          )}
          {model.map((section, si) => (
            <div key={si} className="flex flex-col gap-2 border-b border-border pb-4">
              <h3 className="text-sm font-semibold">{section.heading}</h3>
              {section.dates.map((dg, di) => (
                <div key={di} className="flex flex-col gap-1.5">
                  <div className="font-mono text-xs text-muted-foreground">----{dg.date}----</div>
                  {dg.timeGroups.map((tg, ti) => (
                    <div key={ti} className="flex gap-2 text-xs">
                      <div className="shrink-0 whitespace-nowrap font-medium min-w-[88px]">{tg.time}</div>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        {tg.items.map((item, ii) => (
                          <div key={ii} className="flex flex-wrap items-center gap-1.5">
                            <span>
                              <span className="text-muted-foreground">- </span>
                              {item.title}
                              {firstNames(item.pics) && <span className="text-muted-foreground"> ({firstNames(item.pics)})</span>}
                            </span>
                            {item.status && <StatusPill text={shortenNames(item.status.text)} color={item.status.color} preserveCase={isStatusName(item.status.text)} />}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}

          {closure && (model.length > 0 || qc.length > 0 || sanity.length > 0 || ga.length > 0) && (
            <div className="flex flex-col gap-3 border-b border-border pb-4">
              <h3 className="text-sm font-semibold">Testing Results</h3>
              {qc.length === 0 && sanity.length === 0 && ga.length === 0 && (
                <p className="text-xs text-muted-foreground">No testing results.</p>
              )}
              {qc.length > 0 && <LogEntryList entries={qc} onImageClick={onImageClick} />}
              {sanity.length > 0 && (
                <>
                  <h4 className="text-sm font-semibold">Sanity Check</h4>
                  <SanityDrawers entries={sanity} onImageClick={onImageClick} onCopyImage={onCopyImage} />
                </>
              )}
              {ga.length > 0 && (
                <>
                  <h4 className="text-sm font-semibold">GA Monitoring</h4>
                  <GaDrawers entries={ga} onImageClick={onImageClick} onCopyImage={onCopyImage} />
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
