// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  parseRunbookStorage, serializeRunbookDoc, effectiveCell, deleteRow, insertRow, moveRow, duplicateRow, colIndex, ownerRow,
} from './runbook-model';
import { cellText } from './runbook-storage';
import { RUNBOOK_STORAGE } from './runbook-storage.fixture';

const text = (doc: ReturnType<typeof parseRunbookStorage>, s: number) => {
  const sec = doc.sections[s]!;
  return sec.rows.map((_, r) => sec.columns.map((_, c) => cellText(effectiveCell(sec, r, c).inner)));
};

describe('parseRunbookStorage', () => {
  it('maps each runbook table to a section with typed columns', () => {
    const doc = parseRunbookStorage(RUNBOOK_STORAGE);
    expect(doc.sections.map(s => s.heading)).toEqual(['Pre-Prod To Do List', 'Prod To Do List', 'Rollback plan']);
    expect(doc.sections[2]!.columns.map(c => c.kind)).toEqual([
      'date', 'time', 'activity', 'duration', 'startTime', 'endTime', 'status', 'pics', 'logbook',
    ]);
    expect(doc.sections.every(s => s.editable)).toBe(true);
  });

  it('marks rowspan-covered slots as "same as above" and resolves them to the cell above', () => {
    const pre = parseRunbookStorage(RUNBOOK_STORAGE).sections[0]!;
    expect(pre.rows[1]!.cells.slice(0, 3).map(c => c.sameAsAbove)).toEqual([true, true, false]);
    expect(text(parseRunbookStorage(RUNBOOK_STORAGE), 0)[1]!.slice(1, 5)).toEqual(['5:30 PM', 'Take CLS/LCP PageSpeed insights “Before” release', '30m', '5:30 PM']);
  });

  it('serializes an unedited runbook back to the identical storage body', () => {
    expect(serializeRunbookDoc(parseRunbookStorage(RUNBOOK_STORAGE))).toBe(RUNBOOK_STORAGE);
  });

  it('leaves a table with merged columns read-only', () => {
    const html = '<table><tbody><tr><th><p>Time</p></th><th><p>Activity</p></th></tr>' +
      '<tr><td colspan="2"><p>Break</p></td></tr></tbody></table>';
    const doc = parseRunbookStorage(html);
    expect(doc.sections[0]!.editable).toBe(false);
    expect(serializeRunbookDoc(doc)).toBe(html);
  });

  it('ignores tables that are not runbooks (no Time or Activity column)', () => {
    expect(parseRunbookStorage('<table><tbody><tr><th><p>Key</p></th><th><p>Value</p></th></tr></tbody></table>').sections).toEqual([]);
  });
});

describe('row edits keep the merges consistent', () => {
  it('deleting the first row of a merged block hands its Date/Time cells to the next row', () => {
    const doc = parseRunbookStorage(RUNBOOK_STORAGE);
    const pre = deleteRow(doc.sections[0]!, 0);
    expect(pre.rows.length).toBe(1);
    expect(pre.rows[0]!.cells[0]!.sameAsAbove).toBe(false);
    expect(cellText(pre.rows[0]!.cells[1]!.inner)).toBe('5:30 PM');

    const xml = serializeRunbookDoc({ ...doc, sections: [pre, ...doc.sections.slice(1)] });
    // The surviving row now owns a single-row Date cell: rowspan dropped, content kept.
    expect(xml).toContain('<td ac:local-id="d1"><p local-id="p1"><time datetime="2026-10-26" local-id="tm1" /></p></td>');
    expect(xml).not.toContain('rowspan="2"><p local-id="p1">');
  });

  it('inserting a row inside a merged block joins it, so rows below keep their Date/Time', () => {
    const doc = parseRunbookStorage(RUNBOOK_STORAGE);
    const pre = insertRow(doc.sections[0]!, 0);
    expect(pre.rows.length).toBe(3);
    expect(pre.rows[1]!.cells[colIndex(pre, 'date')]!.sameAsAbove).toBe(true);
    expect(pre.rows[1]!.cells[colIndex(pre, 'time')]!.sameAsAbove).toBe(true);
    expect(pre.rows[1]!.cells[colIndex(pre, 'activity')]!.sameAsAbove).toBe(false);

    const xml = serializeRunbookDoc({ ...doc, sections: [pre, ...doc.sections.slice(1)] });
    expect(xml).toContain('<td rowspan="3" ac:local-id="d1">');
    expect(xml).toContain('<td rowspan="3"><p>5:30 PM</p>');
  });

  it('inserting after the last row of a block keeps the date and starts with an empty Time', () => {
    const pre = insertRow(parseRunbookStorage(RUNBOOK_STORAGE).sections[0]!, 1);
    expect(pre.rows[2]!.cells[colIndex(pre, 'date')]!.sameAsAbove).toBe(true);
    expect(pre.rows[2]!.cells[colIndex(pre, 'time')]!.sameAsAbove).toBe(false);
    expect(cellText(pre.rows[2]!.cells[colIndex(pre, 'time')]!.inner)).toBe('');
  });

  it('duplicating a row copies its content without Confluence local ids', () => {
    const prod = duplicateRow(parseRunbookStorage(RUNBOOK_STORAGE).sections[1]!, 0);
    const copy = prod.rows[1]!;
    expect(cellText(copy.cells[colIndex(prod, 'activity')]!.inner)).toContain('GA Real-Time Traffic Monitoring');
    expect(copy.cells.some(c => /local-id|macro-id/.test(c.inner + (c.open ?? '')))).toBe(false);
  });

  it('moving a row down gives both rows their own Date/Time cells', () => {
    const pre = moveRow(parseRunbookStorage(RUNBOOK_STORAGE).sections[0]!, 0, 1);
    expect(pre.rows.map(r => cellText(r.cells[2]!.inner))).toEqual([
      'Take CLS/LCP PageSpeed insights “Before” release', 'GA Real-Time Traffic Monitoring',
    ]);
    expect(pre.rows.every(r => !r.cells[0]!.sameAsAbove && !r.cells[1]!.sameAsAbove)).toBe(true);
    expect(cellText(pre.rows[0]!.cells[1]!.inner)).toBe('5:30 PM');
  });
});

describe('ownerRow', () => {
  // I7: a rich edit on a row covered by a merge must edit the merged cell itself.
  it('finds the row that holds a merged value', () => {
    const pre = parseRunbookStorage(RUNBOOK_STORAGE).sections[0]!;
    expect(ownerRow(pre, 1, colIndex(pre, 'time'))).toBe(0);
    expect(ownerRow(pre, 1, colIndex(pre, 'activity'))).toBe(1);
  });
});
