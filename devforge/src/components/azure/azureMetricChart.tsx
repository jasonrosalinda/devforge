import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  BarChart,
  Bar,
  ComposedChart,
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
  /** Metric keys the legend has switched off — 'cpu' | 'memory' | 'dbCpu' | 'dbMemory'.
   *  A metric pinned at 100% flattens everything else on the shared 0–100 axis, so
   *  dropping it is how the rest becomes readable. */
  hiddenMetrics?: ReadonlySet<string>;
  /** Hover group shared with the card's expanded charts — see SeriesChart. */
  syncId?: string | undefined;
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

/**
 * Parsed tick timestamps, cached by their raw string.
 *
 * Recharts calls syncMethod once per chart in the hover group for every pointer event, and
 * Chromium fires mousemove as content scrolls under a stationary cursor — so this sat on
 * the scroll path, re-parsing the same ISO strings on every frame.
 *
 * Cleared wholesale rather than evicted per entry: the keys turn over only when the time
 * range changes, and a plain clear beats tracking ages.
 */
const tickTimeCache = new Map<string, number>();
function tickTime(value: unknown): number {
  const key = String(value);
  const hit = tickTimeCache.get(key);
  // NaN is cached too — an unparseable tick should not be re-parsed on every event.
  if (hit !== undefined) return hit;
  if (tickTimeCache.size > 5000) tickTimeCache.clear();
  const t = new Date(key).getTime();
  tickTimeCache.set(key, t);
  return t;
}

/**
 * Cross-chart hover: snap to the closest bucket in this chart.
 *
 * Recharts' built-in `value` sync needs the x values to match exactly. The card's series
 * come from different queries with their own bin widths — Users is a KQL dcount binned on
 * its own window, the metrics are ARM buckets — so an exact match usually fails and that
 * chart simply never lights up. Nearest-timestamp always resolves to a bucket, which is
 * what the reader wants: the same moment in time, to whatever resolution the chart has.
 */
export function nearestTick(
  ticks: ReadonlyArray<{ value?: unknown; index?: number }>,
  data: { activeLabel?: unknown; activeIndex?: unknown },
): number {
  const label = String(data.activeLabel ?? '');
  const target = tickTime(label);
  if (Number.isNaN(target)) return typeof data.activeIndex === 'number' ? data.activeIndex : -1;
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < ticks.length; i++) {
    const tick = ticks[i]!;
    // Charts that share the source chart's bucketing hit this on their first tick and
    // skip the scan entirely, which is the common case within one card.
    if (String(tick.value) === label) return typeof tick.index === 'number' ? tick.index : i;
    const t = tickTime(tick.value);
    if (Number.isNaN(t)) continue;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = typeof tick.index === 'number' ? tick.index : i;
    }
  }
  return bestIdx;
}

/**
 * Caps how often recharts handles pointer movement.
 *
 * Unthrottled, every mousemove re-renders each chart in the hover group, and Chromium fires
 * mousemove as content scrolls under a stationary cursor — so scrolling with the pointer
 * anywhere over a card drove a full re-render storm. 50ms is ~20 crosshair updates a
 * second, which still reads as continuous while cutting the work several-fold.
 */
const CHART_THROTTLE_MS = 50;

// exactOptionalPropertyTypes rejects syncId={undefined}, so the sync pair is spread in only
// when the caller actually joined a hover group. The throttle applies either way — it is
// bundled here so no chart can be added later that forgets it.
function syncProps(syncId: string | undefined) {
  return syncId
    ? { syncId, syncMethod: nearestTick, throttleDelay: CHART_THROTTLE_MS }
    : { throttleDelay: CHART_THROTTLE_MS };
}

// Recharts sorts tooltip rows by name by default, which drops Mem below DB Mem
// alphabetically. Pin the reading order instead: app CPU, app memory, then the
// database pair, then availability; anything unlisted (instances) trails.
const TOOLTIP_ORDER: Record<string, number> = {
  cpuAvg: 0, cpuMax: 1,
  memAvg: 2, memMax: 3,
  dbCpuAvg: 4, dbCpuMax: 5,
  dbMemAvg: 6, dbMemMax: 7,
  avail: 8,
};

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
  series, color, name, height = 120, valueFormatter, syncId,
}: {
  series: Array<{ t: string; v: number; m: number }>;
  color: string;
  name: string;
  height?: number;
  valueFormatter?: ((v: number) => string) | undefined;
  /** Shared with the card's other charts so hovering one moves the crosshair on
   *  all of them. Synced by axis VALUE, not index: these series come from
   *  different queries and rarely have the same bucket count. */
  syncId?: string | undefined;
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
      <AreaChart data={series} {...syncProps(syncId)} margin={{ top: 4, right: 12, bottom: 0, left: -20 }}>
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
          <Area type="monotone" dataKey="v" name={`${name} Avg`} stroke={color} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
        )}
        <Area type="monotone" dataKey="m" name={singleValued ? name : `${name} Max`} stroke={color} fill={`url(#${gid})`} strokeWidth={2} dot={false} isAnimationActive={false} />
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
  instances, colors, height = 150, syncId,
}: {
  instances: Array<{ name: string; label: string; roleName?: string | null; series: Array<{ t: string; v: number }> }>;
  colors: string[];
  height?: number;
  /** See SeriesChart — same cross-chart hover group. */
  syncId?: string | undefined;
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
      <LineChart data={merged} {...syncProps(syncId)} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
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

/**
 * Merge per-endpoint series onto a shared timestamp axis.
 *
 * Aligned on `t`, not index: endpoints come and go inside a window (a deploy adds a
 * route, a client stops polling), so lining series up by position would draw one
 * endpoint's spike at another's timestamp. Buckets an endpoint never reported stay
 * undefined so `connectNulls={false}` breaks the line rather than plotting a 0.
 *
 * Exported for tests.
 */
export function mergeUrlSeries(
  series: Array<{ url: string; series: Array<{ t: string; count: number }> }>,
): { rows: Array<Record<string, number | string>>; stamps: string[] } {
  const maps = series.map(s => new Map(s.series.map(p => [p.t, p.count])));
  const stamps = [...new Set(series.flatMap(s => s.series.map(p => p.t)))].sort();
  const rows = stamps.map(t => {
    const row: Record<string, number | string> = { t };
    maps.forEach((m, idx) => {
      const v = m.get(t);
      if (v != null) row[`u${idx}`] = v;
    });
    return row;
  });
  return { rows, stamps };
}

/**
 * Per-endpoint volume over time, one line per endpoint — requests for the Top tab,
 * error counts for the HTTP 4xx / 5xx tabs.
 *
 * Those lists answer "which endpoints", never "when". A flat 80 rpm average and a
 * five-minute burst that averages to 80 rpm look identical in a list and completely
 * different here — and for the error tabs, whether the failures were one incident or
 * a constant trickle is the whole question.
 *
 * The caller controls which endpoints are plotted (the list rows are toggles), and
 * passes each one's colour so a line and its row always match.
 */
export function EndpointSeriesChart({
  series, colors, binLabel, height = 140, syncId,
}: {
  series: Array<{ url: string; series: Array<{ t: string; count: number }> }>;
  colors: string[];
  binLabel?: string | null | undefined;
  height?: number;
  /** See SeriesChart — same cross-chart hover group. */
  syncId?: string | undefined;
}) {
  const withData = series.filter(s => s.series.length > 0);
  if (!withData.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7681', fontSize: 10 }}>
        Select an endpoint below to plot it
      </div>
    );
  }

  const { rows, stamps } = mergeUrlSeries(withData);
  const spanMs = stamps.length > 1
    ? new Date(stamps[stamps.length - 1]!).getTime() - new Date(stamps[0]!).getTime()
    : 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} {...syncProps(syncId)} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          tickFormatter={(v: string) => formatTick(v, spanMs)}
          tick={{ fill: '#8b9ab3', fontSize: 10 }}
          minTickGap={40}
        />
        {/* Auto-scaled: these are request counts, and the range between the busiest
            and quietest endpoint in a top-10 set is routinely two orders of magnitude. */}
        <YAxis
          tick={{ fill: '#8b9ab3', fontSize: 10 }}
          tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
          width={45}
        />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: unknown, key: unknown) => {
            const idx = Number(String(key).replace('u', ''));
            const label = withData[idx]?.url ?? String(key);
            return [`${Number(val).toLocaleString()}${binLabel ? ` / ${binLabel}` : ''}`, label];
          }}
          labelFormatter={(label: unknown) => new Date(String(label)).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        />
        {withData.map((s, idx) => (
          <Line
            key={s.url}
            type="monotone"
            dataKey={`u${idx}`}
            name={s.url}
            stroke={colors[idx] ?? '#8b9ab3'}
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

/**
 * One endpoint's rate, errors and duration on a single plot.
 *
 * The bar is stacked by outcome — successes, then 4xx, then 5xx — so its height is the
 * request rate and its colour composition is the error rate. Drawing errors as their
 * own series next to a request series would let 20 requests of which 20 failed read as
 * 40 requests; stacking cannot, because the parts are the whole.
 *
 * Latency gets its own right-hand axis rather than sharing the count axis. That is what
 * makes the failure mode visible: a burst of instant 500s drags the average down while
 * the service is broken, and only a chart holding both scales at once shows the latency
 * line dropping as the red segment climbs.
 *
 * One endpoint at a time by design. Sixty endpoints × three signals is unreadable, and
 * the question this answers — "did THIS endpoint's latency move with its errors" — is
 * about one endpoint anyway.
 */
export function EndpointPerfChart({
  rows, binLabel, height = 170, syncId, msFormatter,
  okColor = '#2ea043', fourXxColor = '#f97316', fiveXxColor = '#f85149', lineColor = '#58a6ff',
  segmentLabels, showFourXx = true, countNoun = 'Requests',
}: {
  rows: Array<{ t: string; ok: number; c4: number; c5: number; count: number; avgMs: number; p95: number }>;
  binLabel?: string | null | undefined;
  /** Renames the stacked segments. A dependency has one failure class, not two, so it
   *  passes { ok: 'succeeded', c5: 'failed' } instead of the 4xx / 5xx split. */
  segmentLabels?: { ok?: string; c4?: string; c5?: string } | undefined;
  /** False drops the middle segment entirely — a permanent "4xx 0" tooltip row would read
   *  as a measured zero rather than as a class that does not apply here. */
  showFourXx?: boolean;
  /** What the stack counts, for the tooltip's total row. */
  countNoun?: string;
  height?: number;
  /** See SeriesChart — same cross-chart hover group. */
  syncId?: string | undefined;
  msFormatter?: ((ms: number) => string) | undefined;
  okColor?: string;
  fourXxColor?: string;
  fiveXxColor?: string;
  lineColor?: string;
}) {
  if (!rows.length) {
    return (
      <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7681', fontSize: 10 }}>
        No timeline for this endpoint
      </div>
    );
  }

  const fmtMs = msFormatter ?? ((ms: number) => ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
  const spanMs = rows.length > 1
    ? new Date(rows[rows.length - 1]!.t).getTime() - new Date(rows[0]!.t).getTime()
    : 0;
  const per = binLabel ? ` / ${binLabel}` : '';

  /**
   * Written out rather than left to the default tooltip so Requests can lead and the
   * outcome split can be indented beneath it as its breakdown. The default lists one
   * line per series in declaration order, which put Successful / 4xx / 5xx on equal
   * footing with no total at all — the bar's height was the only place the request
   * count appeared, and a height is not a number you can read off.
   */
  const PerfTooltip = ({ active, payload, label }: {
    active?: boolean;
    payload?: Array<{ payload?: typeof rows[number] }>;
    label?: string | number;
  }) => {
    const row = active ? payload?.[0]?.payload : undefined;
    if (!row) return null;

    const line = (name: string, value: string, color: string, indent = false) => (
      <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 14, paddingLeft: indent ? 10 : 0 }}>
        <span style={{ color: indent ? '#6e7681' : '#8b9ab3' }}>
          {indent && <span style={{ color, marginRight: 4 }}>■</span>}{name}
        </span>
        <span className="tabular-nums" style={{ color, fontWeight: indent ? 400 : 600 }}>{value}</span>
      </div>
    );

    return (
      <div style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 11, padding: '6px 8px', minWidth: 168 }}>
        <div style={{ color: '#8b9ab3', marginBottom: 4 }}>
          {new Date(String(label)).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </div>
        {line(countNoun, `${row.count.toLocaleString()}${per}`, '#cdd9e5')}
        {line(segmentLabels?.ok ?? 'successful', row.ok.toLocaleString(), okColor, true)}
        {/* Applicable classes always shown, including at zero: "4xx 0" is a fact about the
            bucket, whereas an absent line reads as "not measured". */}
        {showFourXx && line(segmentLabels?.c4 ?? '4xx', row.c4.toLocaleString(), row.c4 ? fourXxColor : '#484f58', true)}
        {line(segmentLabels?.c5 ?? '5xx', row.c5.toLocaleString(), row.c5 ? fiveXxColor : '#484f58', true)}
        <div style={{ borderTop: '1px solid #21262d', margin: '4px 0' }} />
        {line('P95', fmtMs(row.p95), lineColor)}
        {line('Average', fmtMs(row.avgMs), lineColor)}
      </div>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} {...syncProps(syncId)} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <XAxis
          dataKey="t"
          tickFormatter={(v: string) => formatTick(v, spanMs)}
          tick={{ fill: '#8b9ab3', fontSize: 10 }}
          minTickGap={40}
        />
        {/* Left: requests per bucket. Auto-scaled — a top endpoint and a 5xx-only
            endpoint differ by orders of magnitude and both need to be readable. */}
        <YAxis
          yAxisId="count"
          tick={{ fill: '#8b9ab3', fontSize: 10 }}
          tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
          width={42}
        />
        {/* Right: milliseconds. Separate axis, not a second series on the count axis —
            requests and latency have no shared unit. */}
        <YAxis
          yAxisId="ms"
          orientation="right"
          tick={{ fill: '#58a6ff', fontSize: 10 }}
          tickFormatter={(v: number) => fmtMs(v)}
          width={52}
        />
        <Tooltip content={<PerfTooltip />} />
        {/* Stack order puts 5xx on top: it is the segment a reader is looking for, and
            the top of a stack is where a small count is still visible. */}
        <Bar yAxisId="count" dataKey="ok" name="ok" stackId="outcome" fill={okColor}     isAnimationActive={false} />
        {showFourXx && <Bar yAxisId="count" dataKey="c4" name="c4" stackId="outcome" fill={fourXxColor} isAnimationActive={false} />}
        <Bar yAxisId="count" dataKey="c5" name="c5" stackId="outcome" fill={fiveXxColor} isAnimationActive={false} />
        <Line yAxisId="ms" type="monotone" dataKey="avgMs" name="avgMs" stroke={lineColor} strokeWidth={1.2} strokeDasharray="3 3" dot={false} connectNulls={false} isAnimationActive={false} />
        <Line yAxisId="ms" type="monotone" dataKey="p95"   name="p95"   stroke={lineColor} strokeWidth={1.8} dot={false} connectNulls={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/**
 * The chart's own legend: one entry per metric, reading `CPU - 15.90% / 78.17% / 99.00%`
 * with each figure in its line's colour. Click to drop the metric out of the plot.
 *
 * These figures used to be table rows above the chart, which meant reading a colour
 * off the plot and finding it again in a list. Here the value, the colour and the
 * switch are the same thing.
 */
export function MetricLegend({
  items, hidden, onToggle,
}: {
  items: Array<{ key: string; label: string; values: Array<{ text: string; color: string }> }>;
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  if (!items.length) return null;
  // Every entry is the same avg/P99/max triple, so the tooltip names the positions
  // the legend leaves unlabelled: "CPU: Average 15.90% / P99 78.17% / Max 99.00%".
  const STAT_NAMES = ['Average', 'P99', 'Max'];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 14, fontSize: 11, paddingTop: 4, paddingBottom: 4 }}>
      {items.map(item => {
        const off = hidden.has(item.key);
        return (
          <span
            key={item.key}
            onClick={() => onToggle(item.key)}
            title={`${item.label}: ${item.values.map((v, i) => `${STAT_NAMES[i] ?? ''} ${v.text}`.trim()).join(' / ')}`}
            style={{
              color: '#6e7681', whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
              opacity: off ? 0.4 : 1, textDecoration: off ? 'line-through' : 'none',
            }}
          >
            <span style={{ fontWeight: 700 }}>{item.label}</span>
            <span style={{ color: '#484f58' }}> - </span>
            {item.values.map((v, i) => (
              <span key={i}>
                {i > 0 && <span style={{ color: '#484f58' }}> / </span>}
                <span style={{ color: v.color, fontWeight: 600 }}>{v.text}</span>
              </span>
            ))}
          </span>
        );
      })}
    </div>
  );
}

/**
 * Discrete events over time — restarts, deployments, anything that happens rather
 * than fluctuates.
 *
 * Bars, not lines: a line between two restarts implies the value moved through the
 * space in between, when in fact nothing happened there. Stacked, so a bucket that
 * saw both a crash and a platform heal reads as two events rather than as one
 * series hiding behind the other.
 */
export function EventBarChart({
  series, colors, height = 110, syncId, valueLabel = 'events',
}: {
  series: Array<{ name: string; series: Array<{ t: string; count: number }> }>;
  colors: string[];
  height?: number;
  syncId?: string | undefined;
  valueLabel?: string;
}) {
  const withData = series.filter(s => s.series.some(p => p.count > 0));
  if (!withData.length) {
    return <div style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6e7681', fontSize: 10 }}>No events in this window</div>;
  }

  const maps = withData.map(s => new Map(s.series.map(p => [p.t, p.count])));
  const stamps = [...new Set(withData.flatMap(s => s.series.map(p => p.t)))].sort();
  const rows = stamps.map(t => {
    const row: Record<string, number | string> = { t };
    maps.forEach((m, i) => { row[`e${i}`] = m.get(t) ?? 0; });
    return row;
  });
  const spanMs = stamps.length > 1
    ? new Date(stamps[stamps.length - 1]!).getTime() - new Date(stamps[0]!).getTime()
    : 0;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} {...syncProps(syncId)} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
        <XAxis dataKey="t" tickFormatter={(v: string) => formatTick(v, spanMs)} tick={{ fill: '#8b9ab3', fontSize: 10 }} minTickGap={40} />
        {/* allowDecimals=false: half an event does not exist, and an axis reading
            0 / 0.5 / 1 for a single restart is noise. */}
        <YAxis tick={{ fill: '#8b9ab3', fontSize: 10 }} width={30} allowDecimals={false} />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: unknown, key: unknown) => {
            const idx = Number(String(key).replace('e', ''));
            return [`${Number(val).toLocaleString()} ${valueLabel}`, withData[idx]?.name ?? String(key)];
          }}
          labelFormatter={(label: unknown) => new Date(String(label)).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' SGT'}
        />
        {withData.map((s, i) => (
          <Bar key={s.name} dataKey={`e${i}`} name={s.name} stackId="events" fill={colors[i] ?? '#8b9ab3'} isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CombinedChart({
  cpu, memory, dbCpu, dbMemory,
  downtimeIntervals = [], urDowntimeIntervals = [], availabilitySeries,
  instanceHealthSeries, apiInstanceHealthSeries,
  hiddenMetrics = new Set<string>(), syncId,
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
      <AreaChart data={merged} {...syncProps(syncId)} margin={{ top: 4, right: 25, bottom: 0, left: -16 }}>
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
          itemSorter={item => TOOLTIP_ORDER[String(item.dataKey)] ?? 99}
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

        {!hiddenMetrics.has('cpu') && (
          <>
            <Area type="monotone" dataKey="cpuAvg" name="CPU Avg" stroke={CHART_COLORS.cpuAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="cpuMax" name="CPU Max" stroke={CHART_COLORS.cpuMax} fill="url(#gCpuMax)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </>
        )}
        {!hiddenMetrics.has('memory') && (
          <>
            <Area type="monotone" dataKey="memAvg" name="Mem Avg" stroke={CHART_COLORS.memAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="memMax" name="Mem Max" stroke={CHART_COLORS.memMax} fill="url(#gMemMax)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </>
        )}
        {hasAvail && (
          <Area type="monotone" dataKey="avail" name="Availability" stroke={CHART_COLORS.avail} fill="url(#gAvail)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        )}
        {hasDbCpu && !hiddenMetrics.has('dbCpu') && (
          <>
            <Area type="monotone" dataKey="dbCpuAvg" name="DB CPU Avg" stroke={CHART_COLORS.dbCpuAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="dbCpuMax" name="DB CPU Max" stroke={CHART_COLORS.dbCpuMax} fill="url(#gDbCpuMax)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
          </>
        )}
        {hasDbMem && !hiddenMetrics.has('dbMemory') && (
          <>
            <Area type="monotone" dataKey="dbMemAvg" name="DB Mem Avg" stroke={CHART_COLORS.dbMemAvg} fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls={false} isAnimationActive={false} />
            <Area type="monotone" dataKey="dbMemMax" name="DB Mem Max" stroke={CHART_COLORS.dbMemMax} fill="url(#gDbMemMax)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
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
