// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { findTables, serializeTable, spliceTables, replaceFirstTime, cellText } from './runbook-storage';
import { RUNBOOK_STORAGE } from './runbook-storage.fixture';

describe('findTables', () => {
  it('finds the top-level runbook tables with the heading above each', () => {
    const tables = findTables(RUNBOOK_STORAGE);
    expect(tables.map(t => t.heading)).toEqual(['Pre-Prod To Do List', 'Prod To Do List', 'Rollback plan']);
  });

  it('keeps a table nested inside a cell as that cell\'s content', () => {
    const prod = findTables(RUNBOOK_STORAGE)[1]!;
    // Header + 3 activities; the key/value table inside "App Configuration" adds no rows.
    expect(prod.rows.length).toBe(4);
    const config = prod.rows[2]!.cells.find(c => c.inner.includes('VERIFIED_BADGE_COUNTRIES'))!;
    expect(config.inner).toContain('<table><tbody><tr><th><p>Key</p></th>');
  });

  it('reads rowspans and the cell tag', () => {
    const pre = findTables(RUNBOOK_STORAGE)[0]!;
    expect(pre.rows[0]!.cells.every(c => c.tag === 'th')).toBe(true);
    expect(pre.rows[1]!.cells.slice(0, 2).map(c => c.rowspan)).toEqual([2, 2]);
    expect(pre.rows[2]!.cells.length).toBe(7);
  });
});

describe('serializeTable / spliceTables', () => {
  it('puts every table back byte-for-byte when nothing changed', () => {
    const tables = findTables(RUNBOOK_STORAGE);
    const out = spliceTables(RUNBOOK_STORAGE, tables.map(t => ({ start: t.start, end: t.end, xml: serializeTable(t) })));
    expect(out).toBe(RUNBOOK_STORAGE);
  });

  it('replaces only the spliced table and leaves the rest of the page alone', () => {
    const [pre] = findTables(RUNBOOK_STORAGE);
    const out = spliceTables(RUNBOOK_STORAGE, [{ start: pre!.start, end: pre!.end, xml: '<table><tbody /></table>' }]);
    expect(out.startsWith('<h2 local-id="h1">Pre-Prod To Do List</h2><table><tbody /></table><p local-id="gap">')).toBe(true);
    expect(out.endsWith(RUNBOOK_STORAGE.slice(pre!.end))).toBe(true);
  });

});

describe('cell helpers', () => {
  it('reads a cell as plain text, decoding entities', () => {
    expect(cellText('<p local-id="a">&lt; 5m</p>')).toBe('< 5m');
    expect(cellText('<p>8:50 PM</p><p>(2hrs from start of Testing)</p>')).toBe('8:50 PM (2hrs from start of Testing)');
  });

  it('leaves out macro internals: task ids and states, status colours', () => {
    expect(cellText(
      '<p>Trigger GitHub actions for:</p><ac:task-list><ac:task><ac:task-id>169</ac:task-id><ac:task-uuid>a5625c6c</ac:task-uuid>' +
      '<ac:task-status>incomplete</ac:task-status><ac:task-body>MSP APP : TBU</ac:task-body></ac:task>' +
      '<ac:task><ac:task-id>170</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>MEDU</ac:task-body></ac:task></ac:task-list>',
    )).toBe('Trigger GitHub actions for: ☐ MSP APP : TBU ☑ MEDU');
    expect(cellText(
      '<p>Restore of: <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">PRDMSPAPP</ac:parameter><ac:parameter ac:name="colour">Red</ac:parameter></ac:structured-macro></p>',
    )).toBe('Restore of: PRDMSPAPP');
  });

  it('replaces the first time in the text and keeps the note and markup', () => {
    expect(replaceFirstTime('<p local-id="t">8:50 PM</p><p>(2hrs from start of Testing)</p>', '9:20 PM'))
      .toBe('<p local-id="t">9:20 PM</p><p>(2hrs from start of Testing)</p>');
  });

  it('never touches times inside tag attributes', () => {
    expect(replaceFirstTime('<p data-x="1:00 PM">6:00 PM</p>', '7:00 PM')).toBe('<p data-x="1:00 PM">7:00 PM</p>');
  });

  it('writes the time into an empty cell', () => {
    expect(replaceFirstTime('<p local-id="e" />', '6:03 PM')).toBe('<p>6:03 PM</p>');
    expect(replaceFirstTime('', '6:03 PM')).toBe('<p>6:03 PM</p>');
  });
});
