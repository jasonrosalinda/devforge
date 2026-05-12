import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
} from 'recharts';
import type { MetricSeries } from '@shared/types/azureMetrics.types';

interface DowntimeInterval {
  start: number;
  end: number;
}

interface CombinedChartProps {
  cpu: MetricSeries;
  memory: MetricSeries;
  downtimeIntervals?: DowntimeInterval[];
  availabilitySeries?: Array<{ t: string; v: number }> | undefined;
  instanceHealthSeries?: Array<{ name: string; series: Array<{ t: string; v: number }> }> | null;
  loading?: boolean;
  height?: number;
}

export const CHART_COLORS = {
  cpuAvg:  '#c4b5fd',
  cpuMax:  '#a78bfa',
  memAvg:  '#fdba74',
  memMax:  '#f97316',
  avail:   '#3fb950',
};

export const INSTANCE_PALETTE = [
  '#38bdf8', '#f472b6', '#facc15', '#60a5fa', '#22d3ee',
  '#e879f9', '#2dd4bf', '#a3e635', '#93c5fd', '#d946ef',
];

const SGT = { timeZone: 'Asia/Singapore' } as const;

function formatTick(isoStr: string, spanMs: number): string {
  const d = new Date(isoStr);
  const parts = new Intl.DateTimeFormat('en-GB', {
    ...SGT, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '00';
  if (spanMs > 3 * 24 * 60 * 60 * 1000) return `${get('month')}/${get('day')}`;
  if (spanMs > 12 * 60 * 60 * 1000)     return `${get('month')}/${get('day')} ${get('hour')}:00`;
  return `${get('hour')}:${get('minute')}`;
}

export function CombinedChart({ cpu, memory, downtimeIntervals = [], availabilitySeries, instanceHealthSeries, loading = false, height = 200 }: CombinedChartProps) {
  if (loading) {
    return (
      <div style={{
        height: 200,
        background: 'linear-gradient(90deg, #1a1f2e 25%, #222840 50%, #1a1f2e 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        borderRadius: 6,
      }} />
    );
  }

  const instances = instanceHealthSeries ?? [];
  const instKeys = instances.map((_, i) => `inst_${i}`);

  // Build time-indexed map for instance series
  const instMaps = instances.map(inst => {
    const m = new Map<string, number>();
    for (const p of inst.series) m.set(p.t, p.v);
    return m;
  });

  const merged = cpu.series.map((p, i) => {
    const row: Record<string, number | string | undefined> = {
      t: p.t,
      cpuAvg: p.v,
      cpuMax: p.m,
      memAvg: memory.series[i]?.v ?? 0,
      memMax: memory.series[i]?.m ?? 0,
      avail: availabilitySeries?.[i]?.v ?? undefined,
    };
    for (let j = 0; j < instances.length; j++) {
      row[instKeys[j]] = instMaps[j].get(p.t);
    }
    return row;
  });

  const spanMs = merged.length > 1
    ? new Date(merged[merged.length - 1].t as string).getTime() - new Date(merged[0].t as string).getTime()
    : 0;

  const hasAvail = (availabilitySeries?.length ?? 0) > 0;
  const hasInstances = instances.length > 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={merged} margin={{ top: 4, right: 25, bottom: 0, left: -16 }}>
        <defs>
          <linearGradient id="gCpuMax" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={CHART_COLORS.cpuMax} stopOpacity={0.3} />
            <stop offset="95%" stopColor={CHART_COLORS.cpuMax} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gMemMax" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={CHART_COLORS.memMax} stopOpacity={0.25} />
            <stop offset="95%" stopColor={CHART_COLORS.memMax} stopOpacity={0} />
          </linearGradient>
          {hasAvail && (
            <linearGradient id="gAvail" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={CHART_COLORS.avail} stopOpacity={0.15} />
              <stop offset="95%" stopColor={CHART_COLORS.avail} stopOpacity={0} />
            </linearGradient>
          )}
          {hasInstances && instances.map((_, i) => (
            <linearGradient key={i} id={`gInst${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={INSTANCE_PALETTE[i % INSTANCE_PALETTE.length]} stopOpacity={0.12} />
              <stop offset="95%" stopColor={INSTANCE_PALETTE[i % INSTANCE_PALETTE.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>

        <XAxis dataKey="t" tickFormatter={(v) => formatTick(v, spanMs)} tick={{ fill: '#8b9ab3', fontSize: 10 }} minTickGap={40} />
        <YAxis domain={[0, 100]} tick={{ fill: '#8b9ab3', fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: number, name: string) => [`${val.toFixed(1)}%`, name]}
          labelFormatter={(label) => new Date(label).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' SGT'}
        />
        {downtimeIntervals.map((iv, i) => (
          <ReferenceArea
            key={i}
            x1={new Date(iv.start).toISOString()}
            x2={new Date(iv.end).toISOString()}
            fill="rgba(139,0,0,0.25)"
            stroke="rgba(139,0,0,0.4)"
            strokeWidth={1}
          />
        ))}

        <Area type="monotone" dataKey="cpuAvg" name="CPU Avg" stroke={CHART_COLORS.cpuAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="cpuMax" name="CPU Max" stroke={CHART_COLORS.cpuMax} fill="url(#gCpuMax)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="memAvg" name="Mem Avg" stroke={CHART_COLORS.memAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="memMax" name="Mem Max" stroke={CHART_COLORS.memMax} fill="url(#gMemMax)" strokeWidth={2} dot={false} />
        {hasAvail && (
          <Area type="monotone" dataKey="avail" name="Availability" stroke={CHART_COLORS.avail} fill="url(#gAvail)" strokeWidth={2} dot={false} connectNulls={false} />
        )}
        {hasInstances && instances.map((inst, i) => (
          <Area
            key={instKeys[i]}
            type="monotone"
            dataKey={instKeys[i]}
            name={`${inst.name} health`}
            stroke={INSTANCE_PALETTE[i % INSTANCE_PALETTE.length]}
            fill={`url(#gInst${i})`}
            strokeWidth={1}
            strokeDasharray="4 2"
            dot={false}
            connectNulls={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
