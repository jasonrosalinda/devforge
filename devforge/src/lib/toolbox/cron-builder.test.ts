import { describe, it, expect } from 'vitest';
import { parseCron } from './cron';
import {
    buildAdvancedCron,
    buildFieldExpression,
    buildSimpleCron,
    compressValues,
    defaultAdvancedFields,
    defaultSimpleOptions,
    type AdvancedField,
    type SimpleCronOptions,
} from './cron-builder';

const simple = (over: Partial<SimpleCronOptions>) => buildSimpleCron({ ...defaultSimpleOptions(), ...over });

const field = (over: Partial<AdvancedField>): AdvancedField => ({
    mode: 'every', values: [], from: 0, to: 0, step: 1, start: 0, ...over,
});

describe('compressValues', () => {
    it('joins scattered values with commas', () => {
        expect(compressValues([15, 0, 30])).toBe('0,15,30');
    });

    it('turns runs of three or more into ranges and keeps shorter runs as a list', () => {
        expect(compressValues([1, 2, 3, 4, 5])).toBe('1-5');
        expect(compressValues([0, 1, 3, 4, 5, 6])).toBe('0,1,3-6');
    });

    it('drops duplicates', () => {
        expect(compressValues([2, 2, 3])).toBe('2,3');
    });
});

describe('buildSimpleCron', () => {
    it('builds every-N-minutes, with a bare * for every minute', () => {
        expect(simple({ frequency: 'minutes', interval: 5 })).toBe('*/5 * * * *');
        expect(simple({ frequency: 'minutes', interval: 1 })).toBe('* * * * *');
    });

    it('builds hourly, daily, weekly and monthly schedules', () => {
        expect(simple({ frequency: 'hourly', minute: 15 })).toBe('15 * * * *');
        expect(simple({ frequency: 'daily', hour: 2, minute: 30 })).toBe('30 2 * * *');
        expect(simple({ frequency: 'weekly', hour: 9, minute: 0, weekdays: [5, 1, 2, 3, 4] })).toBe('0 9 * * 1-5');
        expect(simple({ frequency: 'monthly', hour: 6, minute: 0, dayOfMonth: 15 })).toBe('0 6 15 * *');
    });

    it('treats a weekly schedule with no days picked as every day', () => {
        expect(simple({ frequency: 'weekly', hour: 9, minute: 0, weekdays: [] })).toBe('0 9 * * *');
    });

    it('prefixes a zero seconds field for NCRONTAB', () => {
        expect(simple({ frequency: 'daily', hour: 2, minute: 30, withSeconds: true })).toBe('0 30 2 * * *');
    });

    it('always emits six fields for every-N-seconds', () => {
        expect(simple({ frequency: 'seconds', interval: 30, withSeconds: false })).toBe('*/30 * * * * *');
    });

    it('clamps out-of-range input to the field limits', () => {
        expect(simple({ frequency: 'daily', hour: 99, minute: -4 })).toBe('0 23 * * *');
        expect(simple({ frequency: 'minutes', interval: 0 })).toBe('* * * * *');
        expect(simple({ frequency: 'monthly', hour: 0, minute: 0, dayOfMonth: 40 })).toBe('0 0 31 * *');
    });
});

describe('buildFieldExpression', () => {
    it('renders each mode', () => {
        expect(buildFieldExpression('minutes', field({ mode: 'every' }))).toBe('*');
        expect(buildFieldExpression('minutes', field({ mode: 'specific', values: [30, 0] }))).toBe('0,30');
        expect(buildFieldExpression('dayOfWeek', field({ mode: 'range', from: 1, to: 5 }))).toBe('1-5');
        expect(buildFieldExpression('minutes', field({ mode: 'step', start: 0, step: 15 }))).toBe('*/15');
        expect(buildFieldExpression('minutes', field({ mode: 'step', start: 5, step: 15 }))).toBe('5/15');
    });

    it('falls back to * when no specific values are picked', () => {
        expect(buildFieldExpression('hours', field({ mode: 'specific', values: [] }))).toBe('*');
    });

    it('swaps a backwards range and collapses a one-value range', () => {
        expect(buildFieldExpression('hours', field({ mode: 'range', from: 17, to: 9 }))).toBe('9-17');
        expect(buildFieldExpression('hours', field({ mode: 'range', from: 4, to: 4 }))).toBe('4');
    });

    it('starts a day-of-month step from 1, the field minimum', () => {
        expect(buildFieldExpression('dayOfMonth', field({ mode: 'step', start: 1, step: 2 }))).toBe('*/2');
    });
});

describe('buildAdvancedCron', () => {
    it('joins five fields, or six when seconds are included', () => {
        const fields = defaultAdvancedFields();
        fields.minutes = field({ mode: 'step', start: 0, step: 10 });
        fields.hours = field({ mode: 'range', from: 9, to: 17 });
        fields.seconds = field({ mode: 'specific', values: [30] });

        expect(buildAdvancedCron(fields, false)).toBe('*/10 9-17 * * *');
        expect(buildAdvancedCron(fields, true)).toBe('30 */10 9-17 * * *');
    });
});

describe('round trip through parseCron', () => {
    const expressions = [
        simple({ frequency: 'seconds', interval: 15 }),
        simple({ frequency: 'minutes', interval: 7, withSeconds: true }),
        simple({ frequency: 'weekly', hour: 23, minute: 59, weekdays: [0, 6] }),
        simple({ frequency: 'monthly', hour: 12, minute: 0, dayOfMonth: 1 }),
        buildAdvancedCron({
            ...defaultAdvancedFields(),
            dayOfMonth: field({ mode: 'step', start: 1, step: 5 }),
            month: field({ mode: 'specific', values: [1, 4, 7, 10] }),
        }, true),
    ];

    it.each(expressions)('%s parses cleanly', (expression) => {
        expect(parseCron(expression).error).toBeNull();
    });
});
