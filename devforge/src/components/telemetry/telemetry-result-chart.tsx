import { Bar, BarChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TelemetryChartData } from '@/lib/telemetry-chart';
import { INSTANCE_PALETTE, UI } from '@/lib/chart-colors';

const SGT = { timeZone: 'Asia/Singapore' } as const;

// Same SGT tick format as the App Health Check charts, so a time reads identically
// on both pages.
function formatTick(iso: string, spanMs: number): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const parts = new Intl.DateTimeFormat('en-GB', {
        ...SGT, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
    if (spanMs > 3 * 24 * 3_600_000) return `${get('month')}/${get('day')}`;
    if (spanMs > 12 * 3_600_000) return `${get('month')}/${get('day')} ${get('hour')}:00`;
    return `${get('hour')}:${get('minute')}`;
}

const compact = (v: number) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(+v.toFixed(2)));
const truncate = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const tooltipProps = {
    contentStyle: { background: UI.surface, border: `1px solid ${UI.border}`, borderRadius: 6, fontSize: 12 },
    labelStyle: { color: UI.textMuted },
};

export function TelemetryResultChart({ data, height = 300 }: { data: TelemetryChartData; height?: number }) {
    if (data.kind === 'table') return null;
    const labelOf = new Map(data.series.map(s => [s.key, s.label]));
    const color = (i: number) => INSTANCE_PALETTE[i % INSTANCE_PALETTE.length]!;
    const legend = data.series.length > 1
        ? <Legend wrapperStyle={{ fontSize: 11 }} formatter={(key: unknown) => truncate(labelOf.get(String(key)) ?? String(key), 40)} />
        : null;
    const formatter = (val: unknown, key: unknown) => [
        typeof val === 'number' ? val.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(val ?? '—'),
        labelOf.get(String(key)) ?? String(key),
    ];

    if (data.kind === 'bar') {
        return (
            <ResponsiveContainer width="100%" height={height} debounce={100}>
                <BarChart data={data.rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                    <XAxis type="number" tick={{ fill: UI.textMuted, fontSize: 10 }} tickFormatter={compact} />
                    <YAxis type="category" dataKey="x" width={180} tick={{ fill: UI.textMuted, fontSize: 10 }} tickFormatter={(v: string) => truncate(v)} />
                    <Tooltip {...tooltipProps} formatter={formatter} cursor={{ fill: UI.border, opacity: 0.4 }} />
                    {legend}
                    {data.series.map((s, i) => (
                        <Bar key={s.key} dataKey={s.key} fill={color(i)} isAnimationActive={false} />
                    ))}
                </BarChart>
            </ResponsiveContainer>
        );
    }

    const first = data.rows[0]?.x;
    const last = data.rows[data.rows.length - 1]?.x;
    const spanMs = first && last ? new Date(last).getTime() - new Date(first).getTime() : 0;

    return (
        <ResponsiveContainer width="100%" height={height} debounce={100}>
            <LineChart data={data.rows} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <XAxis dataKey="x" tickFormatter={(v: string) => formatTick(v, spanMs)} tick={{ fill: UI.textMuted, fontSize: 10 }} minTickGap={40} />
                <YAxis tick={{ fill: UI.textMuted, fontSize: 10 }} tickFormatter={compact} width={50} />
                <Tooltip
                    {...tooltipProps}
                    formatter={formatter}
                    labelFormatter={(label: unknown) => new Date(String(label)).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                />
                {legend}
                {data.series.map((s, i) => (
                    <Line
                        key={s.key}
                        type="monotone"
                        dataKey={s.key}
                        stroke={color(i)}
                        strokeWidth={1.5}
                        dot={data.rows.length === 1}
                        connectNulls={false}
                        isAnimationActive={false}
                    />
                ))}
            </LineChart>
        </ResponsiveContainer>
    );
}
