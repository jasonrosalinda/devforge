import type { TelemetryCell, TelemetryChartSpec, TelemetryColumn } from '@shared/types/telemetry.types';

/**
 * Turns a KQL result into something Recharts can draw.
 *
 * Claude's chart suggestion is a hint, not a contract: every column it names is
 * checked against the columns the query actually returned, and the column types
 * decide when the hint is missing or wrong.
 */

/** Series past this many are summed into "other" — more lines than this don't read. */
export const MAX_SERIES = 8;
/** A bar chart with more categories than this becomes a table. */
export const MAX_BARS = 30;
export const OTHER_LABEL = 'other';

const NUMERIC = new Set(['long', 'int', 'real', 'decimal', 'double']);

/** Recharts reads a dotted dataKey as a path, so series get generated keys and keep their label separately. */
export interface ChartSeries {
    key: string;
    label: string;
}

export type ChartRow = { x: string } & Record<string, number | string | null>;

export type TelemetryChartData =
    | { kind: 'timeseries' | 'bar'; xLabel: string; series: ChartSeries[]; rows: ChartRow[] }
    | { kind: 'table' };

const TABLE: TelemetryChartData = { kind: 'table' };

export const isNumericType = (type: string) => NUMERIC.has(type.toLowerCase());

const toNumber = (v: TelemetryCell): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

export function toChartData(
    columns: TelemetryColumn[],
    rows: TelemetryCell[][],
    spec?: TelemetryChartSpec,
): TelemetryChartData {
    if (!columns.length || !rows.length || spec?.type === 'table') return TABLE;

    const index = new Map(columns.map((c, i) => [c.name, i]));
    const typeOf = (name: string) => columns[index.get(name)!]?.type.toLowerCase() ?? '';
    const has = (name?: string): name is string => !!name && index.has(name);

    const datetimes = columns.filter(c => c.type.toLowerCase() === 'datetime').map(c => c.name);
    const numerics = columns.filter(c => isNumericType(c.type)).map(c => c.name);
    const labels = columns.filter(c => !isNumericType(c.type) && c.type.toLowerCase() !== 'datetime').map(c => c.name);
    if (!numerics.length) return TABLE;

    // Trust the hint only where the columns back it up.
    let kind: 'timeseries' | 'bar' | null = null;
    if (spec?.type === 'timeseries' && (has(spec.x) ? typeOf(spec.x) === 'datetime' : datetimes.length > 0)) kind = 'timeseries';
    else if (spec?.type === 'bar' && (has(spec.x) ? !isNumericType(typeOf(spec.x)) : labels.length > 0)) kind = 'bar';
    else if (datetimes.length) kind = 'timeseries';
    else if (labels.length) kind = 'bar';
    if (!kind) return TABLE;

    const x = has(spec?.x) && (kind === 'timeseries' ? typeOf(spec!.x!) === 'datetime' : !isNumericType(typeOf(spec!.x!)))
        ? spec!.x!
        : (kind === 'timeseries' ? datetimes[0]! : labels[0]!);

    const hinted = (spec?.y ?? []).filter(y => has(y) && isNumericType(typeOf(y)));
    const ys = hinted.length ? hinted : numerics;

    // Long format (time, category, value) splits one value into a line per category.
    // Without a series hint, a lone category column is taken as one — unless the hint
    // named its y columns, which means the split was not wanted.
    const seriesCol = kind === 'timeseries'
        ? (has(spec?.series) && spec!.series !== x && !isNumericType(typeOf(spec!.series!))
            ? spec!.series!
            : (!hinted.length && ys.length === 1 && labels.length === 1 ? labels[0] : undefined))
        : undefined;

    const xi = index.get(x)!;
    if (seriesCol) return pivot(rows, x, xi, index.get(seriesCol)!, index.get(ys[0]!)!);

    if (kind === 'bar' && rows.length > MAX_BARS) return TABLE;

    const series = ys.map((label, i) => ({ key: `s${i}`, label }));
    const out = rows.map(row => {
        const r: ChartRow = { x: String(row[xi] ?? '') };
        ys.forEach((y, i) => { r[`s${i}`] = toNumber(row[index.get(y)!] ?? null); });
        return r;
    });
    if (kind === 'timeseries') out.sort((a, b) => a.x.localeCompare(b.x));
    return { kind, xLabel: x, series, rows: out };
}

function pivot(rows: TelemetryCell[][], x: string, xi: number, si: number, vi: number): TelemetryChartData {
    const totals = new Map<string, number>();
    for (const row of rows) {
        const name = String(row[si] ?? '(empty)');
        totals.set(name, (totals.get(name) ?? 0) + Math.abs(toNumber(row[vi] ?? null) ?? 0));
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    const overflow = ranked.length > MAX_SERIES;
    const kept = overflow ? ranked.slice(0, MAX_SERIES - 1) : ranked;
    const keyOf = new Map(kept.map((name, i) => [name, `s${i}`]));
    const otherKey = `s${kept.length}`;

    const byX = new Map<string, ChartRow>();
    for (const row of rows) {
        const xv = String(row[xi] ?? '');
        let r = byX.get(xv);
        if (!r) { r = { x: xv }; byX.set(xv, r); }
        const key = keyOf.get(String(row[si] ?? '(empty)')) ?? otherKey;
        const v = toNumber(row[vi] ?? null);
        if (v === null) continue;
        r[key] = ((r[key] as number | null | undefined) ?? 0) + v;
    }

    const series: ChartSeries[] = kept.map((label, i) => ({ key: `s${i}`, label }));
    if (overflow) series.push({ key: otherKey, label: OTHER_LABEL });
    return {
        kind: 'timeseries',
        xLabel: x,
        series,
        rows: [...byX.values()].sort((a, b) => a.x.localeCompare(b.x)),
    };
}

/** A cell as table text: objects (customDimensions) as compact JSON. */
export function formatCell(value: TelemetryCell, type: string): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    if (isNumericType(type) && typeof value === 'number') {
        return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    return String(value);
}

/** Tab-separated text of the whole result, for pasting into Excel or Teams. */
export function toTsv(columns: TelemetryColumn[], rows: TelemetryCell[][]): string {
    const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
    return [
        columns.map(c => clean(c.name)).join('\t'),
        ...rows.map(r => r.map((v, i) => clean(formatCell(v, columns[i]?.type ?? ''))).join('\t')),
    ].join('\n');
}
