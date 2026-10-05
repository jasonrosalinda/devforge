// Reading and writing the typed runbook cells in storage XHTML: status
// lozenges, PIC mentions, plain-text activity cells, and the template reset.

import { colIndex, TODO_STATUS_XML, type EditDoc } from '@/lib/runbook-model';
import { cellText, stripMacroInternals } from '@/lib/runbook-storage';

export type StatusColour = 'Grey' | 'Blue' | 'Green' | 'Red' | 'Yellow' | 'Purple';

export const STATUS_OPTIONS: { text: string; colour: StatusColour }[] = [
  { text: 'TODO', colour: 'Grey' },
  { text: 'IN PROGRESS', colour: 'Blue' },
  { text: 'DONE', colour: 'Green' },
  { text: 'FAILED', colour: 'Red' },
  { text: 'TBC', colour: 'Yellow' },
];

const colourFor = (text: string): StatusColour =>
  STATUS_OPTIONS.find(o => o.text === text.toUpperCase())?.colour ?? 'Grey';

const STATUS_MACRO_RE = /<ac:structured-macro\b[^>]*ac:name="status"[^>]*>[\s\S]*?<\/ac:structured-macro>/;
const param = (macro: string, name: string) =>
  macro.match(new RegExp(`<ac:parameter ac:name="${name}">([^<]*)</ac:parameter>`))?.[1];

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getStatus(inner: string): { text: string; colour: StatusColour } | null {
  const macro = inner.match(STATUS_MACRO_RE)?.[0];
  if (!macro) return null;
  const text = cellText(param(macro, 'title') ?? '');
  if (!text) return null;
  return { text, colour: (param(macro, 'colour') as StatusColour | undefined) ?? colourFor(text) };
}

/** Sets the lozenge (title + matching colour) in place; null clears the cell. */
export function setStatus(inner: string, text: string | null): string {
  if (!text) return '<p />';
  const colour = colourFor(text);
  const macro = inner.match(STATUS_MACRO_RE)?.[0];
  if (!macro) {
    return `<p><ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">${escapeXml(text)}</ac:parameter><ac:parameter ac:name="colour">${colour}</ac:parameter></ac:structured-macro></p>`;
  }
  let next = macro.replace(/(<ac:parameter ac:name="title">)[^<]*(<\/ac:parameter>)/, `$1${escapeXml(text)}$2`);
  next = /<ac:parameter ac:name="colour">/.test(next)
    ? next.replace(/(<ac:parameter ac:name="colour">)[^<]*(<\/ac:parameter>)/, `$1${colour}$2`)
    : next.replace(/<\/ac:structured-macro>$/, `<ac:parameter ac:name="colour">${colour}</ac:parameter></ac:structured-macro>`);
  return inner.replace(macro, next);
}

export type Pic = { accountId: string } | { name: string };

const MENTION_RE = /<ac:link\b[^>]*>\s*<ri:user\b[^>]*ri:account-id="([^"]+)"[^>]*\/>\s*<\/ac:link>/g;

/** People in a PIC(s) cell, in order: mentions by account id, typed names as text. */
export function picsOf(inner: string): Pic[] {
  const out: Pic[] = [];
  const addNames = (xml: string) => {
    cellText(xml).split(/\s*[/,]\s*/).map(s => s.trim()).filter(Boolean).forEach(name => out.push({ name }));
  };
  let cursor = 0;
  for (const m of inner.matchAll(MENTION_RE)) {
    addNames(inner.slice(cursor, m.index));
    out.push({ accountId: m[1]! });
    cursor = m.index! + m[0].length;
  }
  addNames(inner.slice(cursor));
  return out;
}

export function buildPics(pics: Pic[]): string {
  if (!pics.length) return '<p />';
  const parts = pics.map(p => ('accountId' in p
    ? `<ac:link><ri:user ri:account-id="${escapeXml(p.accountId)}" /></ac:link>`
    : escapeXml(p.name)));
  return `<p>${parts.join(' / ')}</p>`;
}

const linkify = (escaped: string) =>
  escaped.replace(/https?:\/\/[^\s<]+/g, url => `<a href="${url}">${url}</a>`);

/** Plain text → storage: each line a paragraph, "- " lines a bullet list, URLs linked. */
export function textToCell(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim());
  if (!lines.length) return '<p />';
  let out = '';
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-•*]\s+(.*)$/);
    if (bullet && !inList) { out += '<ul>'; inList = true; }
    if (!bullet && inList) { out += '</ul>'; inList = false; }
    const body = linkify(escapeXml(bullet ? bullet[1]! : line.trim()));
    out += bullet ? `<li><p>${body}</p></li>` : `<p>${body}</p>`;
  }
  return inList ? `${out}</ul>` : out;
}

/** A simple cell as editable text — the inverse of textToCell. */
export function cellToText(inner: string): string {
  const flat = stripMacroInternals(inner)
    .replace(/<\/?ac:task>/g, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/p>|<br\s*\/?>|<p\b[^>]*\/>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  const decoded = new DOMParser().parseFromString(`<!doctype html><body>${flat}`, 'text/html').body.textContent ?? flat;
  return decoded.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(l => l && l !== '-').join('\n');
}

const EXPAND_TITLE_RE = /<ac:structured-macro\b[^>]*ac:name="expand"[^>]*>\s*<ac:parameter ac:name="title">([^<]*)<\/ac:parameter>/g;

/** For a new runbook from a template: statuses back to TODO, logbooks emptied
 *  (check-time drawers kept, empty, for the monitoring entries). */
export function resetForTemplate(doc: EditDoc): EditDoc {
  const out: EditDoc = structuredClone(doc);
  for (const section of out.sections) {
    if (!section.editable) continue;
    const statusCol = colIndex(section, 'status');
    const logCol = colIndex(section, 'logbook');
    for (const row of section.rows) {
      const status = statusCol >= 0 ? row.cells[statusCol]! : null;
      if (status && !status.sameAsAbove && getStatus(status.inner)) status.inner = setStatus(status.inner, 'TODO');
      const log = logCol >= 0 ? row.cells[logCol]! : null;
      if (log && !log.sameAsAbove) {
        const titles = [...log.inner.matchAll(EXPAND_TITLE_RE)].map(m => m[1]!);
        log.inner = titles.length
          ? titles.map(t => `<ac:structured-macro ac:name="expand" ac:schema-version="1"><ac:parameter ac:name="title">${t}</ac:parameter><ac:rich-text-body><p /></ac:rich-text-body></ac:structured-macro>`).join('')
          : '<p />';
      }
    }
  }
  return out;
}

const BLANK_COLUMNS = [
  'Date', 'Time (SGT)', 'Activity', 'Duration', 'Planned Start Time (SGT)', 'Planned End Time (SGT)', 'Status', 'PIC(s)', 'Logbook (screenshots)',
];
const BLANK_SECTIONS = ['Pre-Prod To Do List', 'Prod To Do List', 'Post-Prod To do List', 'Rollback plan'];

/** Storage body for a new runbook: the standard four sections, one empty row each (status TODO). */
export function blankRunbookStorage(ymd: string): string {
  const header = `<tr>${BLANK_COLUMNS.map(c => `<th><p><strong>${escapeXml(c)}</strong></p></th>`).join('')}</tr>`;
  const row = `<tr><td><p><time datetime="${ymd}" /></p></td>${BLANK_COLUMNS.slice(1)
    .map(c => `<td>${c === 'Status' ? TODO_STATUS_XML : '<p />'}</td>`).join('')}</tr>`;
  return BLANK_SECTIONS
    .map(h => `<h2>${escapeXml(h)}</h2><table data-layout="full-width"><tbody>${header}${row}</tbody></table>`)
    .join('<p />');
}
