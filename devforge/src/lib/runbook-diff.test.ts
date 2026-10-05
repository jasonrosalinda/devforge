// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { diffRunbook } from './runbook-diff';
import { parseRunbookStorage, insertRow, deleteRow, setCell, colIndex } from './runbook-model';
import { applySchedule } from './runbook-schedule';
import { textToCell } from './runbook-cells';
import { RUNBOOK_STORAGE } from './runbook-storage.fixture';

const doc = () => parseRunbookStorage(RUNBOOK_STORAGE);

describe('diffRunbook', () => {
  it('reports nothing for an unedited runbook', () => {
    const d = doc();
    expect(diffRunbook(d, d)).toEqual([]);
  });

  it('lists each changed cell with its row\'s activity', () => {
    const before = doc();
    const after = applySchedule(before).doc;
    expect(diffRunbook(before, after)).toEqual([
      { section: 'Prod To Do List', kind: 'changed', row: 3, activity: 'Rollback Confirmation→ After QC verification', column: 'Planned End Time (SGT)', before: '8:05 PM', after: '9:05 PM' },
      { section: 'Rollback plan', kind: 'changed', row: 3, activity: 'Release Closure', column: 'Start Time (SGT)', before: '1:40 PM', after: '1:40 AM' },
    ]);
  });

  it('lists added and removed rows once each, not cell by cell', () => {
    const before = doc();
    let pre = insertRow(before.sections[0]!, 1);
    pre = setCell(pre, 2, colIndex(pre, 'activity'), textToCell('Pre-PROD release stats'));
    const prod = deleteRow(before.sections[1]!, 1);
    const after = { ...before, sections: [pre, prod, before.sections[2]!] };

    expect(diffRunbook(before, after)).toEqual([
      { section: 'Pre-Prod To Do List', kind: 'added', row: 3, activity: 'Pre-PROD release stats' },
      { section: 'Prod To Do List', kind: 'removed', row: 2, activity: 'MSP App Configuration → adding key-value Key Value VERIFIED_BADGE_COUNTRIES HK,SG,MY' },
    ]);
  });

  it('shows a date change as the date, not the markup', () => {
    const before = doc();
    const pre = setCell(before.sections[0]!, 0, 0, '<p><time datetime="2026-11-02" /></p>');
    const out = diffRunbook(before, { ...before, sections: [pre, ...before.sections.slice(1)] });
    expect(out).toEqual([
      { section: 'Pre-Prod To Do List', kind: 'changed', row: 1, activity: 'GA Real-Time Traffic Monitoring', column: 'Date', before: '2026-10-26', after: '2026-11-02' },
    ]);
  });
});

describe('changes the text does not show', () => {
  it('lists a cell whose screenshots or formatting changed while its text stayed the same', () => {
    const before = doc();
    const pre = before.sections[0]!;
    const c = colIndex(pre, 'activity');
    const withShot = setCell(pre, 0, c, '<p>GA Real-Time Traffic Monitoring</p><ac:image><ri:attachment ri:filename="devforge-20261005-221800-1.png" /></ac:image>');
    expect(diffRunbook(before, { ...before, sections: [withShot, ...before.sections.slice(1)] })).toEqual([
      { section: 'Pre-Prod To Do List', kind: 'changed', row: 1, activity: 'GA Real-Time Traffic Monitoring', column: 'Activity', before: 'GA Real-Time Traffic Monitoring', after: 'GA Real-Time Traffic Monitoring (+1 screenshot)' },
    ]);
  });
});
