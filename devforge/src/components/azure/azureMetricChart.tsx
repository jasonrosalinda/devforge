import {
  AreaChart,
  Area,
  LineChart,
  Line,
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
  /** Azure SQL cpu_percent / sql_instance_memory_percent. Both are already
   *  percentages, so they share the 0–100 axis with the app's CPU and memory. */
  dbCpu?: MetricSeries | null | undefined;
  dbMemory?: MetricSeries | null | undefined;
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
  // Database. CPU and memory get separate hues for the same reason the app's do
  // (purple vs orange) — two shades of one colour are unreadable once four lines
  // overlap. None of these appear in INSTANCE_PALETTE below, which the per-instance
  // health lines draw from: #2dd4bf and #22d3ee are in it, so the teal is 0d9488.
  dbCpuAvg: '#5eead4',   // teal-300
  dbCpuMax: '#0d9488',   // teal-600
  dbMemAvg: '#a5b4fc',   // indigo-300
  dbMemMax: '#4f46e5',   // indigo-600
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

/** One metric on its own auto-scaled axis. CombinedChart is pinned to 0–100 for
 *  percentages, so counts (users, requests) need this instead. */
export function SeriesChart({
  series, color, name, height = 120, valueFormatter,
}: {
  series: Array<{ t: string; v: number; m: number }>;
  color: string;
  name: string;
  height?: number;
  valueFormatter?: ((v: number) => string) | undefined;
}) {
  if (!series.length) {
    return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7681', fontSize: 10 }}>No time-series data</div>;
  }
  const first = series[0]!.t;
  const last = series[series.length - 1]!.t;
  const spanMs = new Date(last).getTime() - new Date(first).getTime();
  const fmt = valueFormatter ?? ((v: number) => v.toLocaleString());
  const gid = `gSeries_${name.replace(/\W+/g, '')}`;
  // Some series carry one value per bucket with avg and max set identically (the
  // users series is a dcount, for instance). Drawing both would stack two
  // indistinguishable lines, so collapse to one.
  const singleValued = series.every(p => p.v === p.m);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={series} margin={{ top: 4, right: 12, bottom: 0, left: -20 }}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="t" tickFormatter={(v: string) => formatTick(v, spanMs)} tick={{ fill: '#8b9ab3', fontSize: 10 }} minTickGap={40} />
        <YAxis tick={{ fill: '#8b9ab3', fontSize: 10 }} tickFormatter={(v: number) => fmt(v)} width={48} />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: unknown, key: unknown) => [fmt(Number(val)), String(key)]}
          labelFormatter={(label: unknown) => new Date(String(label)).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        />
        {!singleValued && (
          <Area type="monotone" dataKey="v" name={`${name} Avg`} stroke={color} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        )}
        <Area type="monotone" dataKey="m" name={singleValued ? name : `${name} Max`} stroke={color} fill={`url(#${gid})`} strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/**
 * Per-instance health over time — one line per App Service instance.
 *
 * Replaces the per-instance table rows in the Instances block: a table could only
 * show avg / latest / min, which hides *when* an instance dropped and whether the
 * instances failed together (a plan-wide problem) or one at a time (a single
 * crashed worker). That distinction is the whole point of looking per-instance.
 */
export function InstanceHealthChart({
  instances, colors, height = 150,
}: {
  instances: Array<{ name: string; label: string; roleName?: string | null; series: Array<{ t: string; v: number }> }>;
  colors: string[];
  height?: number;
}) {
  const withData = instances.filter(i => i.series.length > 0);
  if (!withData.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7681', fontSize: 10 }}>
        No per-instance time-series data
      </div>
    );
  }

  // Merged on timestamp, not index: instances start and stop at different times, so
  // aligning by position would draw one instance's dip at another's timestamp.
  const maps = withData.map(i => new Map(i.series.map(p => [p.t, p.v])));
  const stamps = [...new Set(withData.flatMap(i => i.series.map(p => p.t)))].sort();
  const merged = stamps.map(t => {
    const row: Record<string, number | string> = { t };
    maps.forEach((m, idx) => {
      const v = m.get(t);
      // Left undefined when the instance reported nothing in this bucket — with
      // connectNulls={false} the line breaks there instead of implying 0% health.
      if (v != null) row[`i${idx}`] = v;
    });
    return row;
  });

  const spanMs = stamps.length > 1
    ? new Date(stamps[stamps.length - 1]!).getTime() - new Date(stamps[0]!).getTime()
    : 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      {/* No negative left margin: the YAxis gets an explicit width sized to "100%"
          instead. Offsetting a default 60px axis leftwards is what previously either
          clipped the labels or left a wide empty gutter, depending on the offset. */}
      <LineChart data={merged} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          tickFormatter={(v: string) => formatTick(v, spanMs)}
          tick={{ fill: '#8b9ab3', fontSize: 10 }}
          minTickGap={40}
        />
        {/* Pinned 0–100: these are health percentages, and an auto-scaled axis makes
            a dip from 100% to 96% look like a catastrophe. */}
        {/* width 45: fits "100%" at 10px plus the tick mark, with a little breathing
            room from the container edge. */}
        <YAxis
          domain={[0, 100]}
          ticks={[0, 25, 50, 75, 100]}
          tick={{ fill: '#8b9ab3', fontSize: 10 }}
          tickFormatter={(v: number) => `${v}%`}
          width={45}
        />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: unknown, key: unknown) => {
            const idx = Number(String(key).replace('i', ''));
            return [`${Number(val).toFixed(2)}%`, withData[idx]?.label ?? String(key)];
          }}
          labelFormatter={(label: unknown) => new Date(String(label)).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        />
        {withData.map((inst, idx) => (
          <Line
            key={inst.name}
            type="monotone"
            dataKey={`i${idx}`}
            name={inst.label}
            stroke={colors[idx % colors.length] ?? '#8b9ab3'}
            strokeWidth={1.5}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export function CombinedChart({
  cpu, memory, dbCpu, dbMemory,
  downtimeIntervals = [], urDowntimeIntervals = [], availabilitySeries,
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

  // Keyed by timestamp rather than index: the DB metrics come from a different
  // Azure resource, so a missing bucket would otherwise shift every later point.
  const byTime = (s: MetricSeries | null | undefined) => {
    const m = new Map<string, { v: number; m: number }>();
    for (const p of s?.series ?? []) m.set(p.t, { v: p.v, m: p.m });
    return m;
  };
  const dbCpuMap = byTime(dbCpu);
  const dbMemMap = byTime(dbMemory);
  const hasDbCpu = dbCpuMap.size > 0;
  const hasDbMem = dbMemMap.size > 0;

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
    const dc = dbCpuMap.get(p.t);
    if (dc) { row.dbCpuAvg = dc.v; row.dbCpuMax = dc.m; }
    const dm = dbMemMap.get(p.t);
    if (dm) { row.dbMemAvg = dm.v; row.dbMemMax = dm.m; }
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
          {hasDbCpu && (
            <linearGradient id="gDbCpuMax" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={CHART_COLORS.dbCpuMax} stopOpacity={0.2} />
              <stop offset="95%" stopColor={CHART_COLORS.dbCpuMax} stopOpacity={0} />
            </linearGradient>
          )}
          {hasDbMem && (
            <linearGradient id="gDbMemMax" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={CHART_COLORS.dbMemMax} stopOpacity={0.2} />
              <stop offset="95%" stopColor={CHART_COLORS.dbMemMax} stopOpacity={0} />
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
        {hasDbCpu && (
          <>
            <Area type="monotone" dataKey="dbCpuAvg" name="DB CPU Avg" stroke={CHART_COLORS.dbCpuAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="dbCpuMax" name="DB CPU Max" stroke={CHART_COLORS.dbCpuMax} fill="url(#gDbCpuMax)" strokeWidth={2} dot={false} connectNulls={false} />
          </>
        )}
        {hasDbMem && (
          <>
            <Area type="monotone" dataKey="dbMemAvg" name="DB Mem Avg" stroke={CHART_COLORS.dbMemAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls={false} />
            <Area type="monotone" dataKey="dbMemMax" name="DB Mem Max" stroke={CHART_COLORS.dbMemMax} fill="url(#gDbMemMax)" strokeWidth={2} dot={false} connectNulls={false} />
          </>
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
