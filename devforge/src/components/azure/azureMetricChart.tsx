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

interface InstanceSeries {
  name: string;
  roleName?: string | null;
  series: Array<{ t: string; v: number }>;
}

interface CombinedChartProps {
  cpu: MetricSeries;
  memory: MetricSeries;
  downtimeIntervals?: DowntimeInterval[];
  urDowntimeIntervals?: DowntimeInterval[];
  availabilitySeries?: Array<{ t: string; v: number }> | undefined;
  instanceHealthSeries?: InstanceSeries[] | null;
  apiInstanceHealthSeries?: InstanceSeries[] | null;
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

export function CombinedChart({
  cpu, memory, downtimeIntervals = [], urDowntimeIntervals = [], availabilitySeries,
  instanceHealthSeries, apiInstanceHealthSeries,
  loading = false, height = 200,
}: CombinedChartProps) {
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

  // Combine FE and API instances; shared instances (same name) shown once without prefix
  type ChartInst = { key: string; label: string; map: Map<string, number>; colorIdx: number };
  const allInst: ChartInst[] = [];
  const feInst = instanceHealthSeries ?? [];
  const apiInst = apiInstanceHealthSeries ?? [];
  const hasApi = apiInst.length > 0;
  const apiNames = new Set(apiInst.map(i => i.name.toLowerCase()));
  const feNames  = new Set(feInst.map(i => i.name.toLowerCase()));

  feInst.forEach((inst, i) => {
    const key = `fe_${i}`;
    const map = new Map<string, number>();
    for (const p of inst.series) map.set(p.t, p.v);
    const shared = hasApi && apiNames.has(inst.name.toLowerCase());
    const label = shared
      ? inst.name
      : inst.roleName
        ? `${inst.roleName}: ${inst.name}`
        : hasApi ? `FE: ${inst.name}` : `${inst.name} health`;
    allInst.push({ key, label, map, colorIdx: i });
  });
  apiInst.forEach((inst, i) => {
    if (feNames.has(inst.name.toLowerCase())) return; // skip shared — already added via FE
    const key = `api_${i}`;
    const map = new Map<string, number>();
    for (const p of inst.series) map.set(p.t, p.v);
    const label = inst.roleName ? `${inst.roleName}: ${inst.name}` : `API: ${inst.name}`;
    allInst.push({ key, label, map, colorIdx: feInst.length + i });
  });

  const merged = cpu.series.map((p, i) => {
    const row: Record<string, number | string> = {
      t: p.t,
      cpuAvg: p.v,
      cpuMax: p.m,
      memAvg: memory.series[i]?.v ?? 0,
      memMax: memory.series[i]?.m ?? 0,
    };
    const av = availabilitySeries?.[i]?.v;
    if (av != null) row.avail = av;
    for (const inst of allInst) {
      const v = inst.map.get(p.t);
      if (v != null) row[inst.key] = v;
    }
    return row;
  });

  const first = merged[0]?.t as string | undefined;
  const last  = merged[merged.length - 1]?.t as string | undefined;
  const spanMs = first && last
    ? new Date(last).getTime() - new Date(first).getTime()
    : 0;

  const hasAvail = (availabilitySeries?.length ?? 0) > 0;

  const snapX = (ms: number): string | null => {
    if (!merged.length) return null;
    return merged.reduce((best, cur) => {
      const bd = Math.abs(new Date(String(best.t)).getTime() - ms);
      const cd = Math.abs(new Date(String(cur.t)).getTime() - ms);
      return cd < bd ? cur : best;
    }).t as string;
  };

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
          {allInst.map((inst, i) => (
            <linearGradient key={i} id={`gInst_${inst.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={INSTANCE_PALETTE[inst.colorIdx % INSTANCE_PALETTE.length]} stopOpacity={0.12} />
              <stop offset="95%" stopColor={INSTANCE_PALETTE[inst.colorIdx % INSTANCE_PALETTE.length]} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>

        <XAxis dataKey="t" tickFormatter={(v: string) => formatTick(v, spanMs)} tick={{ fill: '#8b9ab3', fontSize: 10 }} minTickGap={40} />
        <YAxis domain={[0, 100]} tick={{ fill: '#8b9ab3', fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: unknown, name: unknown) => [`${Number(val).toFixed(1)}%`, String(name)]}
          labelFormatter={(label: unknown) => new Date(String(label)).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' SGT'}
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
        {urDowntimeIntervals.map((iv, i) => {
          const x1 = snapX(iv.start);
          const x2 = snapX(iv.end);
          if (!x1 || !x2 || x1 === x2) return null;
          return (
            <ReferenceArea
              key={`ur_${i}`}
              x1={x1}
              x2={x2}
              fill="rgba(248,81,73,0.65)"
              stroke="rgba(248,81,73,1)"
              strokeWidth={1}
            />
          );
        })}

        <Area type="monotone" dataKey="cpuAvg" name="CPU Avg" stroke={CHART_COLORS.cpuAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="cpuMax" name="CPU Max" stroke={CHART_COLORS.cpuMax} fill="url(#gCpuMax)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="memAvg" name="Mem Avg" stroke={CHART_COLORS.memAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="memMax" name="Mem Max" stroke={CHART_COLORS.memMax} fill="url(#gMemMax)" strokeWidth={2} dot={false} />
        {hasAvail && (
          <Area type="monotone" dataKey="avail" name="Availability" stroke={CHART_COLORS.avail} fill="url(#gAvail)" strokeWidth={2} dot={false} connectNulls={false} />
        )}
        {allInst.map(inst => (
          <Area
            key={inst.key}
            type="monotone"
            dataKey={inst.key}
            name={inst.label}
            stroke={INSTANCE_PALETTE[inst.colorIdx % INSTANCE_PALETTE.length] ?? '#38bdf8'}
            fill={`url(#gInst_${inst.key})`}
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
