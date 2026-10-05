// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  getStatus, setStatus, picsOf, buildPics, textToCell, cellToText, resetForTemplate, blankRunbookStorage,
} from './runbook-cells';
import { parseRunbookStorage, colIndex, effectiveCell, insertRow } from './runbook-model';
import { RUNBOOK_STORAGE } from './runbook-storage.fixture';

const MACRO = '<p><ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="m1"><ac:parameter ac:name="title">TODO</ac:parameter><ac:parameter ac:name="mixedCase">true</ac:parameter></ac:structured-macro>          </p>';

describe('status lozenge', () => {
  it('reads the status title and colour', () => {
    expect(getStatus(MACRO)).toEqual({ text: 'TODO', colour: 'Grey' });
    expect(getStatus('<p><ac:structured-macro ac:name="status"><ac:parameter ac:name="colour">Green</ac:parameter><ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro></p>'))
      .toEqual({ text: 'DONE', colour: 'Green' });
    expect(getStatus('<p />')).toBeNull();
  });

  it('changes the title and colour in place, keeping the macro and its other parameters', () => {
    expect(setStatus(MACRO, 'DONE')).toBe(
      '<p><ac:structured-macro ac:name="status" ac:schema-version="1" ac:macro-id="m1"><ac:parameter ac:name="title">DONE</ac:parameter><ac:parameter ac:name="mixedCase">true</ac:parameter><ac:parameter ac:name="colour">Green</ac:parameter></ac:structured-macro>          </p>',
    );
  });

  it('creates a lozenge in an empty cell, and clears one', () => {
    expect(setStatus('<p />', 'IN PROGRESS')).toBe(
      '<p><ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="title">IN PROGRESS</ac:parameter><ac:parameter ac:name="colour">Blue</ac:parameter></ac:structured-macro></p>',
    );
    expect(setStatus(MACRO, null)).toBe('<p />');
  });
});

describe('PIC(s)', () => {
  it('lists mentioned people by account id, and any typed names', () => {
    expect(picsOf('<p><ac:link><ri:user ri:account-id="a1" ri:local-id="x" /></ac:link> / <ac:link><ri:user ri:account-id="a2" /></ac:link>   </p>'))
      .toEqual([{ accountId: 'a1' }, { accountId: 'a2' }]);
    expect(picsOf('<p>Vendor team / <ac:link><ri:user ri:account-id="a3" /></ac:link></p>'))
      .toEqual([{ name: 'Vendor team' }, { accountId: 'a3' }]);
  });

  it('writes people as mentions joined by " / "', () => {
    expect(buildPics([{ accountId: 'a1' }, { name: 'Vendor & co' }, { accountId: 'a2' }])).toBe(
      '<p><ac:link><ri:user ri:account-id="a1" /></ac:link> / Vendor &amp; co / <ac:link><ri:user ri:account-id="a2" /></ac:link></p>',
    );
    expect(buildPics([])).toBe('<p />');
  });
});

describe('plain-text cells', () => {
  it('turns lines into paragraphs and "- " lines into a bullet list, escaping markup', () => {
    expect(textToCell('Clear cache in Cloudflare\n- https://www.mims.com/_content\n- <framework>')).toBe(
      '<p>Clear cache in Cloudflare</p><ul><li><p><a href="https://www.mims.com/_content">https://www.mims.com/_content</a></p></li><li><p>&lt;framework&gt;</p></li></ul>',
    );
    expect(textToCell('')).toBe('<p />');
  });

  it('reads simple cells back as the same text', () => {
    expect(cellToText('<p>Clear cache in Cloudflare</p><ul><li><p><a href="https://x">https://x</a></p></li></ul>'))
      .toBe('Clear cache in Cloudflare\n- https://x');
    expect(cellToText('<p>&lt; 5m</p>')).toBe('< 5m');
  });

});

describe('resetForTemplate', () => {
  it('sets every status to TODO and empties logbooks, keeping the check-time drawers', () => {
    const doc = resetForTemplate(parseRunbookStorage(RUNBOOK_STORAGE));
    const pre = doc.sections[0]!;
    expect(getStatus(effectiveCell(pre, 1, colIndex(pre, 'status')).inner)?.text).toBe('TODO'); // was DONE

    const prod = doc.sections[1]!;
    const log = prod.rows[0]!.cells[colIndex(prod, 'logbook')]!.inner;
    expect([...log.matchAll(/ac:name="title">([^<]+)</g)].map(m => m[1])).toEqual(['6:00 PM', '6:15 PM']);
    expect(log).not.toContain('ac:image');
    expect(log).not.toContain('Active User');

    // Rollback rows had no lozenge: they stay blank.
    const rb = doc.sections[2]!;
    expect(getStatus(effectiveCell(rb, 0, colIndex(rb, 'status')).inner)).toBeNull();
  });
});

describe('blankRunbookStorage', () => {
  it('builds the four standard sections, each with one dated row', () => {
    const doc = parseRunbookStorage(blankRunbookStorage('2026-11-02'));
    expect(doc.sections.map(s => s.heading)).toEqual(['Pre-Prod To Do List', 'Prod To Do List', 'Post-Prod To do List', 'Rollback plan']);
    expect(doc.sections.every(s => s.editable && s.rows.length === 1)).toBe(true);
    expect(doc.sections[1]!.columns.map(c => c.kind)).toEqual([
      'date', 'time', 'activity', 'duration', 'startTime', 'endTime', 'status', 'pics', 'logbook',
    ]);
    const prod = doc.sections[1]!;
    expect(effectiveCell(prod, 0, colIndex(prod, 'date')).inner).toBe('<p><time datetime="2026-11-02" /></p>');
  });
});

describe('cellToText with macros', () => {
  it('shows each task on its own line with its box, and a status by its title only', () => {
    expect(cellToText(
      '<p>Trigger GitHub actions for:</p><ac:task-list><ac:task><ac:task-id>169</ac:task-id><ac:task-status>incomplete</ac:task-status>' +
      '<ac:task-body>MSP APP : TBU</ac:task-body></ac:task></ac:task-list>' +
      '<p>of: <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">PRDMSPAPP</ac:parameter><ac:parameter ac:name="colour">Red</ac:parameter></ac:structured-macro></p>',
    )).toBe('Trigger GitHub actions for:\n☐ MSP APP : TBU\nof: PRDMSPAPP');
  });
});

describe('new rows start at TODO', () => {
  it('in a blank runbook', () => {
    const doc = parseRunbookStorage(blankRunbookStorage('2026-11-02'));
    for (const s of doc.sections) expect(getStatus(s.rows[0]!.cells[colIndex(s, 'status')]!.inner)).toEqual({ text: 'TODO', colour: 'Grey' });
  });

  it('when a row is inserted, while existing blank statuses stay blank', () => {
    const rb = parseRunbookStorage(RUNBOOK_STORAGE).sections[2]!;
    const next = insertRow(rb, 0);
    const c = colIndex(next, 'status');
    expect(getStatus(next.rows[1]!.cells[c]!.inner)).toEqual({ text: 'TODO', colour: 'Grey' });
    expect(getStatus(next.rows[0]!.cells[c]!.inner)).toBeNull();
  });
});
