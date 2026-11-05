import { describe, it, expect } from 'vitest';
import { PAGE_SIZE, pageOf, sgtTime } from './fiveXxRequestsDialog';

const rows = Array.from({ length: 60 }, (_, i) => i);

describe('pageOf', () => {
  it('slices one page at a time', () => {
    expect(pageOf(rows, 0)).toEqual({ items: rows.slice(0, PAGE_SIZE), page: 0, pages: 3 });
    expect(pageOf(rows, 2).items).toEqual(rows.slice(50));
  });

  it('clamps an out-of-range page instead of showing an empty one', () => {
    expect(pageOf(rows, 9).page).toBe(2);
    expect(pageOf(rows, -1).page).toBe(0);
  });

  it('still has one page when there are no rows', () => {
    expect(pageOf([], 0)).toEqual({ items: [], page: 0, pages: 1 });
  });
});

describe('sgtTime', () => {
  it('shows month-day and time to the second in SGT, whatever the machine zone', () => {
    expect(sgtTime('2026-10-28T09:05:07Z')).toBe('10-28 17:05:07');
    expect(sgtTime('2026-10-28T20:00:00Z')).toBe('10-29 04:00:00');
  });
});
