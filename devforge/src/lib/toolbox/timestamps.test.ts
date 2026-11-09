import { describe, expect, it } from 'vitest';
import { findTimestamps, friendlyInZone, shiftTimestamps, timestampValue, toZoneIso, zoneLabel, SGT_ZONE } from './timestamps';

const SGT = { zone: SGT_ZONE };

describe('shiftTimestamps', () => {
    it('restates UTC and offset timestamps in SGT, keeping each one\'s shape', () => {
        const text = [
            '"createdAt": "2026-11-09T02:23:00Z",',
            'at 2026-11-09 18:30:05.1234567+00:00 done',
            'ny: 2026-11-08T21:00-05:00',
            'log 2026-11-09 02:23:00 UTC ok',
            'Last-Modified: Mon, 09 Nov 2026 02:23:00 GMT',
        ].join('\n');
        expect(shiftTimestamps(text, SGT)).toEqual({
            count: 5,
            text: [
                '"createdAt": "2026-11-09T10:23:00+08:00",',
                'at 2026-11-10 02:30:05.1234567+08:00 done',
                'ny: 2026-11-09T10:00+08:00',
                'log 2026-11-09 10:23:00+08:00 ok',
                'Last-Modified: 2026-11-09 10:23:00+08:00',
            ].join('\n'),
        });
    });

    it('leaves zoneless times alone unless told they are UTC', () => {
        const text = 'timestamp [UTC]: 2026-11-09 02:23:00, id 1758800000';
        expect(shiftTimestamps(text, SGT)).toEqual({ text, count: 0 });
        expect(shiftTimestamps(text, { ...SGT, naiveAsUtc: true }).text).toBe('timestamp [UTC]: 2026-11-09 10:23:00+08:00, id 1758800000');
    });

    it('does not touch dates without times, versions, or impossible dates', () => {
        const text = 'date 2026-11-09, v2026-11-09T02:23:00Z1, bad 2026-02-31T10:00:00Z';
        expect(shiftTimestamps(text, { ...SGT, naiveAsUtc: true })).toEqual({ text, count: 0 });
    });

    it('can target another zone', () => {
        expect(shiftTimestamps('2026-07-01T12:00:00Z', { zone: 'America/New_York' }).text).toBe('2026-07-01T08:00:00-04:00');
        expect(shiftTimestamps('2026-07-01T12:00:00Z', { zone: 'GMT+5:30' }).text).toBe('2026-07-01T17:30:00+05:30');
    });
});

describe('helpers', () => {
    it('finds timestamps in order with their positions', () => {
        const found = findTimestamps('a 2026-11-09T02:23:00Z b Mon, 09 Nov 2026 02:23:00 GMT');
        expect(found.map(f => [f.start, f.date.toISOString()])).toEqual([
            [2, '2026-11-09T02:23:00.000Z'], [25, '2026-11-09T02:23:00.000Z'],
        ]);
    });

    it('reads a whole-string value only', () => {
        expect(timestampValue('2026-11-09T02:23:00Z')?.toISOString()).toBe('2026-11-09T02:23:00.000Z');
        expect(timestampValue('created 2026-11-09T02:23:00Z')).toBeNull();
        expect(timestampValue('2026-11-09 02:23:00')).toBeNull();
        expect(timestampValue('2026-11-09 02:23:00', { naiveAsUtc: true })).not.toBeNull();
    });

    it('labels and formats', () => {
        const d = new Date('2026-11-09T02:23:00Z');
        expect(zoneLabel(SGT_ZONE)).toBe('SGT');
        expect(zoneLabel('UTC')).toBe('UTC');
        expect(zoneLabel('GMT+5:30')).toBe('GMT+5:30');
        expect(friendlyInZone(d, SGT_ZONE)).toBe('2026-11-09 10:23:00 SGT');
        expect(toZoneIso(d, 'UTC')).toBe('2026-11-09T02:23:00+00:00');
    });
});
