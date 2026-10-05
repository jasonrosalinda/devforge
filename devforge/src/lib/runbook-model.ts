// Editable model of the runbook tables in a Confluence storage body.
//
// Each runbook table becomes a section: one EditRow per activity, one EditCell
// per column. A slot covered by a rowspan from above is `sameAsAbove` — the
// Date / Time merges Confluence authors use for parallel activities — so the
// merges survive editing instead of being guessed again. Untouched cells keep
// their original XHTML and opening tag, and an unedited document serializes
// back to the identical storage body.

import { colKey, type ColKey } from '@/lib/parse-runbook';
import {
  findTables, serializeRow, spliceTables, cellText, type RawCell, type RawRow, type RawTable,
} from '@/lib/runbook-storage';

export interface EditCell {
  tag: 'td' | 'th';
  open: string | null;  // original opening tag; null for a cell devForge created
  inner: string;        // storage XHTML
  sameAsAbove: boolean; // covered by the cell above (rowspan)
}

export interface EditRow {
  key: string;          // stable React key
  raw: RawRow | null;   // the original row, for its <tr> tag and spacing
  cells: EditCell[];    // one per column
}

export interface EditColumn {
  label: string;
  kind: ColKey;
}

export interface EditSection {
  heading: string;
  columns: EditColumn[];
  table: RawTable;      // the original table (head, header row, tail)
  rows: EditRow[];
  editable: boolean;    // false when cells span columns or rows are ragged
}

export interface EditDoc {
  storage: string;      // the body the sections were read from
  sections: EditSection[];
}

let keySeq = 0;
const nextKey = () => `row-${++keySeq}`;

export const emptyCell = (): EditCell => ({ tag: 'td', open: null, inner: '<p />', sameAsAbove: false });

/** The status a new activity starts with: a grey TODO lozenge. */
export const TODO_STATUS_XML =
  '<p><ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">TODO</ac:parameter><ac:parameter ac:name="colour">Grey</ac:parameter></ac:structured-macro></p>';

// Copied content must not reuse Confluence's ids: duplicates confuse its editor.
export function stripIds(xml: string): string {
  return xml.replace(/\s(?:ac:|ri:)?(?:local-id|macro-id)="[^"]*"/g, '');
}

function toGrid(table: RawTable, width: number): { rows: EditRow[]; editable: boolean } {
  const rows: EditRow[] = [];
  const pending = new Array<number>(width).fill(0); // remaining rowspan per column
  let editable = true;
  for (const raw of table.rows.slice(1)) {
    const cells: EditCell[] = [];
    let next = 0;
    for (let c = 0; c < width; c++) {
      if (pending[c]! > 0) {
        pending[c]!--;
        cells.push({ tag: 'td', open: null, inner: '', sameAsAbove: true });
        continue;
      }
      const rc: RawCell | undefined = raw.cells[next++];
      if (!rc) { editable = false; cells.push(emptyCell()); continue; }
      if (rc.colspan > 1) editable = false;
      if (rc.rowspan > 1) pending[c] = rc.rowspan - 1;
      cells.push({ tag: rc.tag, open: rc.open, inner: rc.inner, sameAsAbove: false });
    }
    if (next !== raw.cells.length) editable = false;
    rows.push({ key: nextKey(), raw, cells });
  }
  return { rows, editable };
}

/** Reads every runbook table (one with Time and Activity columns) into an editable section. */
export function parseRunbookStorage(storage: string): EditDoc {
  const sections: EditSection[] = [];
  for (const table of findTables(storage)) {
    const header = table.rows[0];
    if (!header) continue;
    const columns = header.cells.map(c => {
      const label = cellText(c.inner);
      return { label, kind: colKey(label) };
    });
    if (!columns.some(c => c.kind === 'time') || !columns.some(c => c.kind === 'activity')) continue;
    const width = header.cells.reduce((n, c) => n + c.colspan, 0);
    const grid = header.cells.some(c => c.colspan > 1) ? { rows: [], editable: false } : toGrid(table, width);
    sections.push({ heading: table.heading, columns, table, rows: grid.rows, editable: grid.editable });
  }
  return { storage, sections };
}

export function colIndex(section: EditSection, kind: ColKey): number {
  return section.columns.findIndex(c => c.kind === kind);
}

/** The row whose cell holds row r's value in column c (r itself unless merged from above). */
export function ownerRow(section: EditSection, r: number, c: number): number {
  let i = r;
  while (i > 0 && section.rows[i]!.cells[c]!.sameAsAbove) i--;
  return i;
}

/** The cell that actually holds row r's value in column c (walks up through merges). */
export function effectiveCell(section: EditSection, r: number, c: number): EditCell {
  let i = r;
  while (i > 0 && section.rows[i]!.cells[c]!.sameAsAbove) i--;
  return section.rows[i]!.cells[c]!;
}

// Sets the rowspan in place, so an unchanged span leaves the tag byte-identical.
function withRowspan(open: string, span: number): string {
  const attr = /(\s+)rowspan\s*=\s*["']?\d+["']?/i;
  if (span <= 1) return open.replace(attr, '');
  if (attr.test(open)) return open.replace(attr, `$1rowspan="${span}"`);
  return open.replace(/^<(td|th)\b/i, m => `${m} rowspan="${span}"`);
}

function sectionTableXml(section: EditSection): string {
  const { table, rows } = section;
  const out: RawRow[] = [table.rows[0]!];
  rows.forEach((row, r) => {
    const cells: RawCell[] = [];
    row.cells.forEach((cell, c) => {
      if (cell.sameAsAbove && r > 0) return;
      let span = 1;
      while (r + span < rows.length && rows[r + span]!.cells[c]!.sameAsAbove) span++;
      const tag = cell.tag;
      const open = withRowspan(cell.open ?? `<${tag}>`, span);
      cells.push({ tag, open, inner: cell.inner, close: `</${tag}>`, rowspan: span, colspan: 1 });
    });
    const sameShape = row.raw && row.raw.cells.length === cells.length;
    out.push({
      open: row.raw?.open ?? '<tr>',
      cells,
      gaps: sameShape ? row.raw!.gaps : new Array(cells.length + 1).fill(''),
      close: row.raw?.close ?? '</tr>',
    });
  });
  let xml = table.head;
  out.forEach((r, i) => { xml += (i > 0 ? (table.rowGaps[i - 1] ?? '') : '') + serializeRow(r); });
  return xml + table.tail;
}

/** The storage body with every editable section written back; other content untouched. */
export function serializeRunbookDoc(doc: EditDoc): string {
  const edits = doc.sections
    .filter(s => s.editable)
    .map(s => ({ start: s.table.start, end: s.table.end, xml: sectionTableXml(s) }));
  return spliceTables(doc.storage, edits);
}

// ── Row operations (each returns a new section) ────────────────────────────────

const cloneRows = (s: EditSection) => s.rows.map(r => ({ ...r, cells: r.cells.map(c => ({ ...c })) }));

// Gives row r its own copy of every merged value, so it can move or go away
// without changing what the rows around it show.
function materialize(section: EditSection, rows: EditRow[], r: number) {
  rows[r]!.cells.forEach((cell, c) => {
    if (!cell.sameAsAbove) return;
    const src = effectiveCell({ ...section, rows }, r, c);
    rows[r]!.cells[c] = { tag: src.tag, open: src.open ? stripIds(src.open) : null, inner: stripIds(src.inner), sameAsAbove: false };
  });
}

export function deleteRow(section: EditSection, r: number): EditSection {
  const rows = cloneRows(section);
  const below = rows[r + 1];
  if (below) {
    // The row below inherits any value this row was the source of.
    below.cells.forEach((cell, c) => {
      if (cell.sameAsAbove && !rows[r]!.cells[c]!.sameAsAbove) below.cells[c] = { ...rows[r]!.cells[c]! };
    });
  }
  rows.splice(r, 1);
  return { ...section, rows };
}

/** Inserts an empty row after row r (r = -1 inserts at the top). */
export function insertRow(section: EditSection, r: number): EditSection {
  const rows = cloneRows(section);
  const dateCol = colIndex(section, 'date');
  const statusCol = colIndex(section, 'status');
  const cells = section.columns.map((_, c) => {
    const inBlock = r >= 0 && rows[r + 1]?.cells[c]?.sameAsAbove === true;
    // Same day as the row above by default; inside a merged block, join it.
    if (r >= 0 && (inBlock || c === dateCol)) return { tag: 'td' as const, open: null, inner: '', sameAsAbove: true };
    if (c === statusCol) return { ...emptyCell(), inner: TODO_STATUS_XML };
    return emptyCell();
  });
  if (r < 0 && rows[0]) {
    // The old first row can no longer inherit from above.
    materialize(section, rows, 0);
  }
  rows.splice(r + 1, 0, { key: nextKey(), raw: null, cells });
  return { ...section, rows };
}

export function duplicateRow(section: EditSection, r: number): EditSection {
  const rows = cloneRows(section);
  const copy: EditRow = { key: nextKey(), raw: null, cells: rows[r]!.cells.map(c => ({ ...c })) };
  rows.splice(r + 1, 0, copy);
  materialize(section, rows, r + 1);
  copy.cells = copy.cells.map(c => ({ ...c, open: c.open ? stripIds(c.open) : null, inner: stripIds(c.inner) }));
  // A row that inherited from the original now inherits from the copy — same value.
  return { ...section, rows };
}

/** Moves row `from` to index `to`. Both rows (and the neighbours they leave) keep their values. */
export function moveRow(section: EditSection, from: number, to: number): EditSection {
  if (from === to || to < 0 || to >= section.rows.length) return section;
  const rows = cloneRows(section);
  materialize(section, rows, from);
  if (rows[from + 1]) materialize(section, rows, from + 1);
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row!);
  if (rows[to + 1]) materialize(section, rows, to + 1);
  return { ...section, rows };
}

/** Replaces one cell's content (and makes it its own cell). */
export function setCell(section: EditSection, r: number, c: number, inner: string): EditSection {
  const rows = cloneRows(section);
  const cell = rows[r]!.cells[c]!;
  if (cell.sameAsAbove) {
    // Editing a merged value splits this row (and the rows under it) off the block.
    materialize(section, rows, r);
    for (let i = r + 1; i < rows.length && rows[i]!.cells[c]!.sameAsAbove; i++) {
      rows[i]!.cells[c] = { ...rows[i]!.cells[c]!, sameAsAbove: true };
    }
  }
  rows[r]!.cells[c] = { ...rows[r]!.cells[c]!, inner, sameAsAbove: false };
  return { ...section, rows };
}

/** Joins row r's cell in column c to the value above (or splits it off with a copy). */
export function setSameAsAbove(section: EditSection, r: number, c: number, same: boolean): EditSection {
  if (r === 0 || section.rows[r]!.cells[c]!.sameAsAbove === same) return section;
  const rows = cloneRows(section);
  if (same) rows[r]!.cells[c] = { tag: 'td', open: null, inner: '', sameAsAbove: true };
  else materialize(section, rows, r);
  return { ...section, rows };
}
