// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import {
  parseDuration, parseTimeLabel, formatTimeLabel, applySchedule, shiftRunbook, defaultAnchor, rowSchedule, shiftTitleDate,
  labelToInputTime, inputTimeToLabel, retimeRow,
} from './runbook-schedule';
import { parseRunbookStorage, effectiveCell, colIndex, insertRow, type EditDoc } from './runbook-model';
import { cellText } from './runbook-storage';
import { RUNBOOK_STORAGE } from './runbook-storage.fixture';

const doc = () => parseRunbookStorage(RUNBOOK_STORAGE);

// Shown value of one column for every row of a section.
function column(d: EditDoc, s: number, kind: Parameters<typeof colIndex>[1]): string[] {
  const sec = d.sections[s]!;
  const c = colIndex(sec, kind);
  return sec.rows.map((_, r) => {
    const inner = effectiveCell(sec, r, c).inner;
    return kind === 'date' ? (inner.match(/datetime="([^"]+)"/)?.[1] ?? '') : cellText(inner);
  });
}

describe('parseDuration', () => {
  it.each([
    ['< 5m', 5], ['30m', 30], ['2h', 120], [' 3h', 180], ['1h 30m', 90], ['< 15m', 15], ['1.5h', 90],
    ['45 mins', 45], ['2 hrs', 120],
  ])('%s → %i minutes', (label, minutes) => {
    expect(parseDuration(label)).toBe(minutes);
  });

  it('gives null for text with no duration', () => {
    expect(parseDuration('TBD')).toBeNull();
    expect(parseDuration('')).toBeNull();
  });
});

describe('time labels', () => {
  it('reads the first time in a cell', () => {
    expect(parseTimeLabel('8:50 PM(2hrs from start of Testing)')).toBe(20 * 60 + 50);
    expect(parseTimeLabel('12:05 AM')).toBe(5);
    expect(parseTimeLabel('12:30 PM')).toBe(12 * 60 + 30);
    expect(parseTimeLabel('soon')).toBeNull();
  });

  it('writes minutes of the day as Confluence-style labels', () => {
    expect(formatTimeLabel(0)).toBe('12:00 AM');
    expect(formatTimeLabel(5)).toBe('12:05 AM');
    expect(formatTimeLabel(12 * 60)).toBe('12:00 PM');
    expect(formatTimeLabel(18 * 60 + 3)).toBe('6:03 PM');
    expect(formatTimeLabel(25 * 60 + 40)).toBe('1:40 AM'); // past midnight wraps
  });
});

describe('rowSchedule', () => {
  it('ends each activity at start + duration, across midnight', () => {
    const rollback = rowSchedule(doc().sections[2]!);
    expect(rollback.map(r => [r.date, r.startLabel, r.endLabel, r.endsNextDay])).toEqual([
      ['2026-10-26', '9:40 PM', '1:40 AM', true],
      ['2026-10-26', '9:40 PM', '11:40 PM', false],
      ['2026-10-27', '1:40 AM', '1:45 AM', false],
    ]);
  });

  it('flags a duration it cannot read instead of guessing an end', () => {
    const d = doc();
    const pre = d.sections[0]!;
    pre.rows[0]!.cells[colIndex(pre, 'duration')]!.inner = '<p>TBD</p>';
    const [row] = rowSchedule(pre);
    expect(row!.endLabel).toBeNull();
    expect(row!.issues).toEqual(['Duration "TBD" is not a time span (use e.g. 15m, 2h, 1h 30m).']);
  });
});

describe('applySchedule', () => {
  it('sets Planned Start to the Time and Planned End to Start + Duration, listing what changed', () => {
    const { doc: out, changes } = applySchedule(doc());

    expect(column(out, 1, 'endTime')).toEqual(['8:00 PM', '6:03 PM', '9:05 PM']);
    expect(column(out, 2, 'startTime')).toEqual(['9:40 PM', '9:40 PM', '1:40 AM']);
    // Only the two typos in the page change.
    expect(changes).toEqual([
      { section: 'Prod To Do List', row: 2, column: 'Planned End Time (SGT)', before: '8:05 PM', after: '9:05 PM' },
      { section: 'Rollback plan', row: 2, column: 'Start Time (SGT)', before: '1:40 PM', after: '1:40 AM' },
    ]);
  });

  it('is a no-op on a runbook that already follows the rules', () => {
    const once = applySchedule(doc()).doc;
    expect(applySchedule(once).changes).toEqual([]);
  });
});

describe('shiftRunbook', () => {
  it('defaults the anchor to the first Prod activity', () => {
    expect(defaultAnchor(doc())).toEqual({ section: 1, row: 0, at: '2026-10-26T18:00' });
  });

  it('moves every date, time, planned time and logbook check time by the same offset', () => {
    const out = shiftRunbook(doc(), { section: 1, row: 0 }, '2026-11-02T19:30');

    expect(column(out, 0, 'date')).toEqual(['2026-11-02', '2026-11-02']);
    expect(column(out, 0, 'time')).toEqual(['7:00 PM', '7:00 PM']);
    expect(column(out, 0, 'endTime')).toEqual(['7:05 PM', '7:30 PM']);

    expect(column(out, 1, 'time')).toEqual(['7:30 PM', '7:30 PM', '10:20 PM (2hrs from start of Testing)']);
    expect(column(out, 1, 'startTime')).toEqual(['7:30 PM', '7:30 PM', '10:20 PM']);
    expect(column(out, 1, 'endTime')).toEqual(['9:30 PM', '7:33 PM', '10:35 PM']);
    const logbook = out.sections[1]!.rows[0]!.cells[colIndex(out.sections[1]!, 'logbook')]!.inner;
    expect([...logbook.matchAll(/ac:name="title">([^<]+)</g)].map(m => m[1])).toEqual(['7:30 PM', '7:45 PM']);
    expect(logbook).toContain('ri:filename="ga-1800.png"'); // screenshot untouched

    expect(column(out, 2, 'date')).toEqual(['2026-11-02', '2026-11-02', '2026-11-03']);
    expect(column(out, 2, 'time')).toEqual(['11:10 PM', '11:10 PM', '3:10 AM']);
    expect(column(out, 2, 'endTime')).toEqual(['3:10 AM', '1:10 AM', '3:15 AM']);
  });

  it('gives a row its own date when the shift pushes it past midnight', () => {
    const out = shiftRunbook(doc(), { section: 1, row: 0 }, '2026-10-26T23:00');

    expect(column(out, 1, 'date')).toEqual(['2026-10-26', '2026-10-26', '2026-10-27']);
    expect(column(out, 1, 'time')[2]).toBe('1:50 AM (2hrs from start of Testing)');
    const prod = out.sections[1]!;
    expect(prod.rows[2]!.cells[colIndex(prod, 'date')]!.sameAsAbove).toBe(false);
    expect(column(out, 2, 'date')).toEqual(['2026-10-27', '2026-10-27', '2026-10-27']);
  });

  it('lands on the same result when applied again to the shifted page', () => {
    const once = shiftRunbook(doc(), { section: 1, row: 0 }, '2026-11-02T19:30');
    const twice = shiftRunbook(once, { section: 1, row: 0 }, '2026-11-02T19:30');
    expect(column(twice, 2, 'time')).toEqual(column(once, 2, 'time'));
    expect(column(twice, 2, 'date')).toEqual(column(once, 2, 'date'));
  });
});

describe('shiftTitleDate', () => {
  it('rewrites a leading date in the page title', () => {
    expect(shiftTitleDate('26 Oct 2026 MSP V3.16.0 Deployment Runbook', '2026-11-02'))
      .toBe('2 Nov 2026 MSP V3.16.0 Deployment Runbook');
    expect(shiftTitleDate('MSP Deployment Runbook', '2026-11-02')).toBe('MSP Deployment Runbook');
  });
});

describe('time input values', () => {
  it('converts between Confluence labels and <input type="time"> values', () => {
    expect(labelToInputTime('6:03 PM')).toBe('18:03');
    expect(labelToInputTime('12:05 AM')).toBe('00:05');
    expect(labelToInputTime('')).toBe('');
    expect(inputTimeToLabel('18:03')).toBe('6:03 PM');
    expect(inputTimeToLabel('00:05')).toBe('12:05 AM');
    expect(inputTimeToLabel('')).toBeNull();
  });
});

describe('retimeRow', () => {
  const titles = (inner: string) => [...inner.matchAll(/ac:name="title">([^<]+)</g)].map(m => m[1]);

  it('moves the row\'s logbook check times with its time, keeping the intervals', () => {
    const prod = doc().sections[1]!;
    const next = retimeRow(prod, 0, '5:00 PM');
    expect(cellText(next.rows[0]!.cells[colIndex(next, 'time')]!.inner)).toBe('5:00 PM');
    expect(titles(next.rows[0]!.cells[colIndex(next, 'logbook')]!.inner)).toEqual(['5:00 PM', '5:15 PM']);
  });

  it('also moves the check times of rows that share the time through a merge', () => {
    const d = doc();
    const pre = d.sections[0]!;
    const log = colIndex(pre, 'logbook');
    pre.rows[1]!.cells[log]!.inner = '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">5:30 PM</ac:parameter><ac:rich-text-body><p /></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">6:00 PM</ac:parameter><ac:rich-text-body><p /></ac:rich-text-body></ac:structured-macro>';
    const next = retimeRow(pre, 0, '7:00 PM');
    expect(titles(next.rows[1]!.cells[log]!.inner)).toEqual(['7:00 PM', '7:30 PM']);
  });

  it('only touches drawer titles that are times, and wraps past midnight', () => {
    const prod = doc().sections[1]!;
    const log = colIndex(prod, 'logbook');
    prod.rows[0]!.cells[log]!.inner = '<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Screenshots</ac:parameter><ac:rich-text-body><p /></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">6:15 PM</ac:parameter><ac:rich-text-body><p /></ac:rich-text-body></ac:structured-macro>';
    const next = retimeRow(prod, 0, '11:50 PM');
    expect(titles(next.rows[0]!.cells[log]!.inner)).toEqual(['Screenshots', '12:05 AM']);
  });

  it('just sets the time when the row had none before', () => {
    const pre = insertRow(doc().sections[0]!, 1);
    const next = retimeRow(pre, 2, '6:10 PM');
    expect(cellText(next.rows[2]!.cells[colIndex(next, 'time')]!.inner)).toBe('6:10 PM');
  });
});
