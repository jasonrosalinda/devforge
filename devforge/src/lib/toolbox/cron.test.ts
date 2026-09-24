import { describe, it, expect } from 'vitest';
import { parseCron, describeCron, nextRuns } from './cron';

const parse = (expr: string, fieldCount?: 5 | 6) => {
    const result = parseCron(expr, fieldCount);
    if (!result.cron) throw new Error(`expected ${expr} to parse, got ${result.error?.message}`);
    return result.cron;
};

const iso = (dates: Date[]) => dates.map((d) => d.toISOString());

describe('parseCron', () => {
    it('reads a five-field expression as minute-first', () => {
        const cron = parse('*/5 * * * *');

        expect(cron.fieldCount).toBe(5);
        expect(cron.seconds.values).toEqual([0]);
        expect(cron.minutes.values).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
        expect(cron.hours.restricted).toBe(false);
    });

    it('reads a six-field expression as NCRONTAB seconds-first', () => {
        const cron = parse('0 */30 * * * *');

        expect(cron.fieldCount).toBe(6);
        expect(cron.seconds.values).toEqual([0]);
        expect(cron.minutes.values).toEqual([0, 30]);
    });

    it('expands ranges, lists and stepped ranges', () => {
        const cron = parse('0 9 * * 1-5');

        expect(cron.hours.values).toEqual([9]);
        expect(cron.dayOfWeek.values).toEqual([1, 2, 3, 4, 5]);
        expect(parse('0,30 * * * *').minutes.values).toEqual([0, 30]);
        expect(parse('10-20/5 * * * *').minutes.values).toEqual([10, 15, 20]);
    });

    it('accepts named months and weekdays case-insensitively', () => {
        expect(parse('0 0 1 JAN *').month.values).toEqual([1]);
        expect(parse('0 0 * * mon-fri').dayOfWeek.values).toEqual([1, 2, 3, 4, 5]);
    });

    it('normalises day-of-week 7 to Sunday', () => {
        expect(parse('0 0 * * 7').dayOfWeek.values).toEqual([0]);
    });

    it('marks a field as restricted only when it is not a wildcard', () => {
        const cron = parse('0 9 * * 1-5');

        expect(cron.hours.restricted).toBe(true);
        expect(cron.dayOfMonth.restricted).toBe(false);
        expect(cron.dayOfWeek.restricted).toBe(true);
    });

    it('reports the offending field when a value is out of range', () => {
        const result = parseCron('0 99 * * *');

        expect(result.cron).toBeNull();
        expect(result.error?.field).toBe('hours');
        expect(result.error?.message).toContain('0-23');
    });

    it('reports an error when the field count is neither five nor six', () => {
        expect(parseCron('* * *').error?.message).toContain('5 or 6');
    });

    it('reports an error for an unparseable token', () => {
        expect(parseCron('0 0 * * banana').error?.field).toBe('dayOfWeek');
    });

    it('reports an error for a zero or negative step', () => {
        expect(parseCron('*/0 * * * *').error?.field).toBe('minutes');
    });
});

describe('nextRuns', () => {
    // Fire times are computed in UTC because that is how Azure Functions and
    // WebJobs read a schedule; the UI renders the local column from these.
    const from = new Date('2026-09-23T10:02:00Z');

    it('returns the next occurrences of a stepped minute expression', () => {
        expect(iso(nextRuns(parse('*/5 * * * *'), from, 3))).toEqual([
            '2026-09-23T10:05:00.000Z',
            '2026-09-23T10:10:00.000Z',
            '2026-09-23T10:15:00.000Z',
        ]);
    });

    it('skips the weekend for a weekday-only schedule', () => {
        const saturday = new Date('2026-09-26T00:00:00Z');

        expect(iso(nextRuns(parse('0 9 * * 1-5'), saturday, 2))).toEqual([
            '2026-09-28T09:00:00.000Z',
            '2026-09-29T09:00:00.000Z',
        ]);
    });

    it('honours the seconds field of a six-field expression', () => {
        expect(iso(nextRuns(parse('15 */30 * * * *'), from, 2))).toEqual([
            '2026-09-23T10:30:15.000Z',
            '2026-09-23T11:00:15.000Z',
        ]);
    });

    it('never returns a time at or before the starting point', () => {
        const exact = new Date('2026-09-23T10:05:00Z');

        expect(iso(nextRuns(parse('*/5 * * * *'), exact, 1))).toEqual(['2026-09-23T10:10:00.000Z']);
    });

    // Classic cron semantics: when both day fields are restricted the schedule
    // fires if EITHER matches, not both.
    it('ORs day-of-month against day-of-week when both are restricted', () => {
        const runs = iso(nextRuns(parse('0 0 1 * 1'), new Date('2026-09-26T00:00:00Z'), 3));

        expect(runs).toEqual([
            '2026-09-28T00:00:00.000Z', // Monday
            '2026-10-01T00:00:00.000Z', // day 1 of the month, a Thursday
            '2026-10-05T00:00:00.000Z', // Monday
        ]);
    });

    it('ANDs the day fields against the month field', () => {
        expect(iso(nextRuns(parse('0 0 1 11 *'), from, 1))).toEqual(['2026-11-01T00:00:00.000Z']);
    });

    it('returns nothing for an unsatisfiable expression instead of hanging', () => {
        expect(nextRuns(parse('0 0 30 2 *'), from, 5)).toEqual([]);
    });

    it('keeps the UTC interval constant across a local daylight-saving change', () => {
        const beforeDst = new Date('2026-03-29T00:30:00Z');
        const runs = nextRuns(parse('0 */30 * * * *'), beforeDst, 3);

        expect(iso(runs)).toEqual([
            '2026-03-29T01:00:00.000Z',
            '2026-03-29T01:30:00.000Z',
            '2026-03-29T02:00:00.000Z',
        ]);
    });
});

describe('describeCron', () => {
    it('describes a stepped minute schedule', () => {
        expect(describeCron(parse('*/5 * * * *'))).toBe('Every 5 minutes');
    });

    it('describes a stepped seconds schedule', () => {
        expect(describeCron(parse('*/15 * * * * *'))).toBe('Every 15 seconds');
    });

    it('describes a stepped hour schedule', () => {
        expect(describeCron(parse('0 */6 * * *'))).toBe('Every 6 hours, at minute 0');
    });

    it('describes a fixed daily time', () => {
        expect(describeCron(parse('30 9 * * *'))).toBe('At 09:30');
    });

    it('appends a contiguous weekday range', () => {
        expect(describeCron(parse('0 9 * * 1-5'))).toBe('At 09:00, Monday to Friday');
    });

    it('appends a weekday list', () => {
        expect(describeCron(parse('0 9 * * 1,3'))).toBe('At 09:00, Monday and Wednesday');
    });

    it('appends the day of the month', () => {
        expect(describeCron(parse('0 0 1 * *'))).toBe('At 00:00, on day 1 of the month');
    });

    it('joins both day fields with "or" when both are restricted', () => {
        expect(describeCron(parse('0 0 1 * 1'))).toBe('At 00:00, on day 1 of the month or Monday');
    });

    it('appends the month', () => {
        expect(describeCron(parse('0 0 1 11 *'))).toBe('At 00:00, on day 1 of the month, in November');
    });

    it('runs every minute when nothing is restricted', () => {
        expect(describeCron(parse('* * * * *'))).toBe('Every minute');
    });
});
