import { describe, expect, it } from 'vitest';
import type { TelemetryColumn } from '@shared/types/telemetry.types';
import { MAX_BARS, MAX_SERIES, OTHER_LABEL, formatCell, toChartData, toTsv } from './telemetry-chart';

const col = (name: string, type: string): TelemetryColumn => ({ name, type });
const T1 = '2026-10-20T01:00:00Z';
const T2 = '2026-10-20T02:00:00Z';

describe('toChartData', () => {
    it('is a table for no rows, no columns, a table hint or no numbers', () => {
        expect(toChartData([], [])).toEqual({ kind: 'table' });
        expect(toChartData([col('n', 'long')], [])).toEqual({ kind: 'table' });
        expect(toChartData([col('n', 'long')], [[1]], { type: 'table' })).toEqual({ kind: 'table' });
        expect(toChartData([col('name', 'string')], [['a']])).toEqual({ kind: 'table' });
    });

    it('draws a time series with every numeric column, sorted by time', () => {
        const out = toChartData(
            [col('timestamp', 'datetime'), col('P95', 'real'), col('Count', 'long')],
            [[T2, 2.5, 4], [T1, '1.5', null]],
        );
        expect(out).toEqual({
            kind: 'timeseries',
            xLabel: 'timestamp',
            series: [{ key: 's0', label: 'P95' }, { key: 's1', label: 'Count' }],
            rows: [{ x: T1, s0: 1.5, s1: null }, { x: T2, s0: 2.5, s1: 4 }],
        });
    });

    it('uses only the hinted y columns that exist and are numeric', () => {
        const out = toChartData(
            [col('timestamp', 'datetime'), col('a', 'long'), col('b', 'long'), col('label', 'string')],
            [[T1, 1, 2, 'x']],
            { type: 'timeseries', x: 'timestamp', y: ['b', 'missing', 'label'] },
        );
        expect(out.kind === 'timeseries' && out.series).toEqual([{ key: 's0', label: 'b' }]);
    });

    it('pivots long format into a line per category', () => {
        const out = toChartData(
            [col('timestamp', 'datetime'), col('name', 'string'), col('n', 'long')],
            [[T1, 'GET /a', 3], [T1, 'GET /b', 1], [T2, 'GET /a', 5]],
            { type: 'timeseries', x: 'timestamp', series: 'name' },
        );
        expect(out).toEqual({
            kind: 'timeseries',
            xLabel: 'timestamp',
            series: [{ key: 's0', label: 'GET /a' }, { key: 's1', label: 'GET /b' }],
            rows: [{ x: T1, s0: 3, s1: 1 }, { x: T2, s0: 5 }],
        });
    });

    it('pivots without a hint when there is one category and one value', () => {
        const out = toChartData(
            [col('timestamp', 'datetime'), col('code', 'string'), col('n', 'long')],
            [[T1, null, 2], [T1, '500', null]],
        );
        expect(out.kind === 'timeseries' && out.series.map(s => s.label)).toEqual(['(empty)', '500']);
        expect(out.kind === 'timeseries' && out.rows).toEqual([{ x: T1, s0: 2 }]);
    });

    it(`keeps the top ${MAX_SERIES - 1} series and sums the rest into "${OTHER_LABEL}"`, () => {
        const rows = Array.from({ length: 12 }, (_, i) => [T1, `op${i}`, 100 - i]);
        const out = toChartData([col('timestamp', 'datetime'), col('op', 'string'), col('n', 'long')], rows);
        if (out.kind !== 'timeseries') throw new Error('expected a time series');
        expect(out.series).toHaveLength(MAX_SERIES);
        expect(out.series[MAX_SERIES - 1]).toEqual({ key: `s${MAX_SERIES - 1}`, label: OTHER_LABEL });
        const otherSum = rows.slice(MAX_SERIES - 1).reduce((s, r) => s + (r[2] as number), 0);
        expect(out.rows[0]![`s${MAX_SERIES - 1}`]).toBe(otherSum);
    });

    it('draws bars for a category breakdown', () => {
        const out = toChartData([col('target', 'string'), col('Failures', 'long')], [['sql', 9], ['redis', 2]]);
        expect(out).toEqual({
            kind: 'bar',
            xLabel: 'target',
            series: [{ key: 's0', label: 'Failures' }],
            rows: [{ x: 'sql', s0: 9 }, { x: 'redis', s0: 2 }],
        });
    });

    it('turns too many bars into a table', () => {
        const rows = Array.from({ length: MAX_BARS + 1 }, (_, i) => [`t${i}`, i]);
        expect(toChartData([col('t', 'string'), col('n', 'long')], rows)).toEqual({ kind: 'table' });
    });

    it('ignores a hint the columns cannot back', () => {
        // A bar hint on a datetime-only result still charts — as the time series it is.
        const out = toChartData([col('timestamp', 'datetime'), col('n', 'long')], [[T1, 1]], { type: 'bar', x: 'n' });
        expect(out.kind).toBe('timeseries');
        // A time-series hint without a datetime column falls back to bars.
        const bars = toChartData([col('name', 'string'), col('n', 'long')], [['a', 1]], { type: 'timeseries', x: 'name' });
        expect(bars.kind).toBe('bar');
    });

    it('honours a valid bar x column', () => {
        const out = toChartData(
            [col('first', 'string'), col('second', 'string'), col('n', 'long')],
            [['a', 'b', 1]],
            { type: 'bar', x: 'second' },
        );
        expect(out.kind === 'bar' && out.rows).toEqual([{ x: 'b', s0: 1 }]);
    });

    it('is a table when only numeric columns exist', () => {
        expect(toChartData([col('a', 'long'), col('b', 'real')], [[1, 2]])).toEqual({ kind: 'table' });
    });
});

describe('formatCell', () => {
    it('formats each kind of value', () => {
        expect(formatCell(null, 'string')).toBe('');
        expect(formatCell({ a: 1 }, 'dynamic')).toBe('{"a":1}');
        expect(formatCell(1234, 'long')).toBe((1234).toLocaleString());
        expect(formatCell(1.23456, 'real')).toBe((1.23).toLocaleString());
        expect(formatCell(true, 'bool')).toBe('true');
        expect(formatCell('x', 'string')).toBe('x');
    });
});

describe('toTsv', () => {
    it('writes a header and rows, flattening tabs and newlines', () => {
        expect(toTsv([col('name', 'string'), col('n', 'long')], [['a\tb\nc', 1]])).toBe('name\tn\na b c\t1');
    });
});
