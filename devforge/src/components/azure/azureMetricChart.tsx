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
  loading?: boolean;
}

export const CHART_COLORS = {
  cpuAvg:  '#58a6ff',
  cpuMax:  '#ff7b72',
  memAvg:  '#79c0ff',
  memMax:  '#ffa198',
};

function formatTick(isoStr: string): string {
  const d = new Date(isoStr);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function CombinedChart({ cpu, memory, downtimeIntervals = [], loading = false }: CombinedChartProps) {
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

  const merged = cpu.series.map((p, i) => ({
    t: p.t,
    cpuAvg: p.v,
    cpuMax: p.m,
    memAvg: memory.series[i]?.v ?? 0,
    memMax: memory.series[i]?.m ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={merged} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
        <defs>
          <linearGradient id="gCpuAvg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={CHART_COLORS.cpuAvg} stopOpacity={0.3} />
            <stop offset="95%" stopColor={CHART_COLORS.cpuAvg} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gMemAvg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={CHART_COLORS.memAvg} stopOpacity={0.3} />
            <stop offset="95%" stopColor={CHART_COLORS.memAvg} stopOpacity={0} />
          </linearGradient>
        </defs>

        <XAxis dataKey="t" tickFormatter={formatTick} tick={{ fill: '#8b9ab3', fontSize: 10 }} minTickGap={40} />
        <YAxis domain={[0, 100]} tick={{ fill: '#8b9ab3', fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: number, name: string) => [`${val.toFixed(1)}%`, name]}
          labelFormatter={(label) => new Date(label).toLocaleTimeString()}
        />
        {downtimeIntervals.map((iv, i) => (
          <ReferenceArea
            key={i}
            x1={new Date(iv.start).toISOString()}
            x2={new Date(iv.end).toISOString()}
            fill="rgba(248,81,73,0.15)"
            stroke="none"
          />
        ))}

        <Area type="monotone" dataKey="cpuMax"  name="CPU Max"  stroke={CHART_COLORS.cpuMax}  fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="cpuAvg"  name="CPU Avg"  stroke={CHART_COLORS.cpuAvg}  fill="url(#gCpuAvg)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="memMax"  name="Mem Max"  stroke={CHART_COLORS.memMax}  fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="memAvg"  name="Mem Avg"  stroke={CHART_COLORS.memAvg}  fill="url(#gMemAvg)" strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
