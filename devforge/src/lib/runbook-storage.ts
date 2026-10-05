// Low-level access to the runbook tables in a Confluence storage-format body.
//
// The body is never parsed into a DOM and serialized back: an HTML parser
// mangles storage XHTML (self-closing <ri:… /> tags swallow their siblings,
// CDATA becomes comments). Instead the raw string is split at table / row /
// cell tags only, everything between those tags is kept as the original text,
// and an untouched table serializes back to exactly the same bytes.

export interface RawCell {
  tag: 'td' | 'th';
  open: string;        // the opening tag as written, e.g. <td rowspan="3" ac:local-id="…">
  inner: string;       // cell content XHTML, verbatim
  close: string;       // '</td>' / '</th>', or '' for a self-closing cell
  rowspan: number;
  colspan: number;
}

export interface RawRow {
  open: string;
  cells: RawCell[];
  gaps: string[];      // text around the cells: gaps[i] precedes cells[i]; last one precedes close
  close: string;
}

export interface RawTable {
  start: number;       // offset of '<table' in the storage body
  end: number;         // offset just past '</table>'
  heading: string;     // text of the nearest h1–h4 above the table ('' if none)
  head: string;        // '<table …><colgroup>…<tbody>' up to the first row
  rows: RawRow[];
  rowGaps: string[];   // text between consecutive rows
  tail: string;        // after the last row: '</tbody></table>'
}

const TAG_RE = /<(\/?)(table|tr|td|th)\b([^>]*?)(\/?)>/gi;
const TIME_RE = /\b(1[0-2]|0?[1-9]):([0-5]\d)\s*([AaPp][Mm])\b/;

function spanAttr(open: string, name: 'rowspan' | 'colspan'): number {
  const m = open.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, 'i'));
  const n = m ? parseInt(m[1]!, 10) : 1;
  return n > 0 ? n : 1;
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return new DOMParser().parseFromString(`<!doctype html><body>${text}`, 'text/html').body.textContent ?? text;
}

/** Drops macro internals that are not reading text: task ids / uuids, task
 *  states (shown as ☐ / ☑), and macro parameters other than a title. */
export function stripMacroInternals(inner: string): string {
  return inner
    .replace(/<ac:task-(?:id|uuid)>[\s\S]*?<\/ac:task-(?:id|uuid)>/g, '')
    .replace(/<ac:task-status>\s*complete\s*<\/ac:task-status>/g, '☑ ')
    .replace(/<ac:task-status>[\s\S]*?<\/ac:task-status>/g, '☐ ')
    .replace(/<ac:parameter ac:name="(?!title")[^"]*">[\s\S]*?<\/ac:parameter>/g, '');
}

/** Plain text of a cell, blocks separated by a space, entities decoded. */
export function cellText(inner: string): string {
  const flat = stripMacroInternals(inner)
    .replace(/<\/(p|li|h[1-6]|div|th|td|ac:task)>|<br\s*\/?>|<p\b[^>]*\/>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(flat).replace(/\s+/g, ' ').trim();
}

function headingBefore(storage: string, offset: number): string {
  const re = /<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let last = '';
  for (let m = re.exec(storage); m && m.index < offset; m = re.exec(storage)) last = m[2]!;
  return cellText(last);
}

/** The top-level tables of a storage body; tables nested in cells stay cell content. */
export function findTables(storage: string): RawTable[] {
  const tables: RawTable[] = [];
  let depth = 0;
  let table: { start: number; headEnd: number; rows: RawRow[]; rowGaps: string[]; lastRowEnd: number } | null = null;
  let row: (RawRow & { cursor: number }) | null = null;
  let cell: { tag: 'td' | 'th'; open: string; innerStart: number } | null = null;

  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(storage); m; m = TAG_RE.exec(storage)) {
    const [whole, slash, rawName, , selfClose] = m;
    const name = rawName!.toLowerCase();
    const at = m.index;
    const after = at + whole.length;

    if (name === 'table') {
      if (!slash && !selfClose) {
        if (depth === 0) table = { start: at, headEnd: -1, rows: [], rowGaps: [], lastRowEnd: -1 };
        depth++;
      } else if (slash) {
        depth--;
        if (depth === 0 && table) {
          const head = storage.slice(table.start, table.headEnd < 0 ? at : table.headEnd);
          const tailStart = table.lastRowEnd < 0 ? (table.headEnd < 0 ? at : table.headEnd) : table.lastRowEnd;
          tables.push({
            start: table.start,
            end: after,
            heading: headingBefore(storage, table.start),
            head,
            rows: table.rows,
            rowGaps: table.rowGaps,
            tail: storage.slice(tailStart, after),
          });
          table = null;
        }
      }
      continue;
    }
    if (depth !== 1 || !table) continue;

    if (name === 'tr') {
      if (!slash) {
        if (table.headEnd < 0) table.headEnd = at;
        else table.rowGaps.push(storage.slice(table.lastRowEnd, at));
        row = { open: whole, cells: [], gaps: [], close: '', cursor: after };
      } else if (row) {
        row.gaps.push(storage.slice(row.cursor, at));
        table.rows.push({ open: row.open, cells: row.cells, gaps: row.gaps, close: whole });
        table.lastRowEnd = after;
        row = null;
      }
      continue;
    }

    // td / th
    if (!row) continue;
    const tag = name as 'td' | 'th';
    if (!slash) {
      row.gaps.push(storage.slice(row.cursor, at));
      if (selfClose) {
        row.cells.push({ tag, open: whole, inner: '', close: '', rowspan: spanAttr(whole, 'rowspan'), colspan: spanAttr(whole, 'colspan') });
        row.cursor = after;
      } else {
        cell = { tag, open: whole, innerStart: after };
      }
    } else if (cell) {
      row.cells.push({
        tag: cell.tag,
        open: cell.open,
        inner: storage.slice(cell.innerStart, at),
        close: whole,
        rowspan: spanAttr(cell.open, 'rowspan'),
        colspan: spanAttr(cell.open, 'colspan'),
      });
      row.cursor = after;
      cell = null;
    }
  }
  return tables;
}

export function serializeCell(c: RawCell): string {
  return c.close ? c.open + c.inner + c.close : c.open;
}

export function serializeRow(r: RawRow): string {
  let out = r.open;
  r.cells.forEach((c, i) => { out += (r.gaps[i] ?? '') + serializeCell(c); });
  return out + (r.gaps[r.cells.length] ?? '') + r.close;
}

export function serializeTable(t: RawTable): string {
  let out = t.head;
  t.rows.forEach((r, i) => { out += (i > 0 ? (t.rowGaps[i - 1] ?? '') : '') + serializeRow(r); });
  return out + t.tail;
}

/** Replaces [start, end) ranges of the storage body with new XML; other text is untouched. */
export function spliceTables(storage: string, edits: { start: number; end: number; xml: string }[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const e of sorted) {
    out += storage.slice(cursor, e.start) + e.xml;
    cursor = e.end;
  }
  return out + storage.slice(cursor);
}

/**
 * Replaces the first "h:mm AM" in the cell's text (never inside a tag) with
 * `label`, keeping notes and markup. A cell with no time gets the label as its
 * first paragraph.
 */
export function replaceFirstTime(inner: string, label: string): string {
  const parts = inner.split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.startsWith('<') || !TIME_RE.test(part)) continue;
    parts[i] = part.replace(TIME_RE, label);
    return parts.join('');
  }
  return cellText(inner) ? `<p>${label}</p>${inner}` : `<p>${label}</p>`;
}
