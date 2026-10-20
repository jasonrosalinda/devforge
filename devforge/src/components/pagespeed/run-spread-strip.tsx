import type { PageSpeedInsightResult } from '@shared/types/pageSpeedInsight.types';
import { Hint } from '@/components/ui/hint';
import { findDegradingRuns, metricMeasured, resultHasError, shownValue, type ComparableMetricKey } from '@/lib/pageSpeedUtils';

// One dot per run, Before on the top lane and After on the bottom, on a shared axis.
// Overlapping lanes = run-to-run noise; separated lanes = a real change. Lanes carry
// identity by position and label, so color only marks state: neutral for Before,
// primary for After, the error color for a flagged After run (one that drives the
// regression).
//
// Marks are positioned HTML rather than SVG so every one of them — dot, score tick,
// axis end, metric name — can carry the app's rich tooltip.

interface RunSpreadStripProps {
    before: PageSpeedInsightResult;
    after: PageSpeedInsightResult;
    keys: ComparableMetricKey[];
    labels: Record<ComparableMetricKey, string>;
    beforeLabel: string;
    afterLabel: string;
    aggregation: 'average' | 'median';
}

interface Run {
    runIdx: number;
    value: number;
    display: string;
    flagged: boolean;
}

/** Runs that display the same value share one dot, with a count beside it. */
interface Dot {
    value: number;
    display: string;
    runs: number[];
    flagged: boolean;
}

interface Side {
    label: string;
    dots: Dot[];
    runs: Run[];
    score?: { value: number; display: string } | undefined;
}

const LANE = 22;

const METRIC_INFO: Record<ComparableMetricKey, string> = {
    speedIndex: 'Speed Index: how quickly the page content is visibly painted while it loads.',
    largestContentfulPaint: 'Largest Contentful Paint: when the largest image or text block finishes rendering.',
    cumulativeLayoutShift: 'Cumulative Layout Shift: how much the layout jumps while loading. Unitless.',
    totalBlockingTime: 'Total Blocking Time: how long the main thread was too busy to respond to input.',
    firstContentfulPaint: 'First Contentful Paint: when the first text or image appears.',
};

const formatValue = (key: ComparableMetricKey, value: number): string => {
    if (key === 'cumulativeLayoutShift') return value.toFixed(3);
    return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
};

const runsLabel = (runs: number[]): string =>
    runs.length > 1 ? `Runs ${runs.map(i => `#${i + 1}`).join(', ')}` : `Run #${runs[0]! + 1}`;

const runsOf = (result: PageSpeedInsightResult, key: ComparableMetricKey, flagged?: Set<number>): Run[] =>
    (result.runHistory ?? [result]).flatMap((r, runIdx) => {
        if (resultHasError(r) || !metricMeasured(r[key])) return [];
        return [{ runIdx, value: shownValue(r[key]), display: r[key].displayValue, flagged: !!flagged?.has(runIdx) }];
    });

const groupDots = (runs: Run[]): Dot[] => {
    const byDisplay = new Map<string, Dot>();
    for (const r of runs) {
        const dot = byDisplay.get(r.display);
        if (dot) {
            dot.runs.push(r.runIdx);
            dot.flagged ||= r.flagged;
        } else {
            byDisplay.set(r.display, { value: r.value, display: r.display, runs: [r.runIdx], flagged: r.flagged });
        }
    }
    return [...byDisplay.values()];
};

const spanOf = (key: ComparableMetricKey, runs: Run[]): string => {
    const values = runs.map(r => r.value);
    const lo = Math.min(...values), hi = Math.max(...values);
    return lo === hi ? formatValue(key, lo) : `${formatValue(key, lo)}–${formatValue(key, hi)}`;
};

const Tip = ({ title, lines }: { title: string; lines: (string | false | undefined)[] }) => (
    <div className="text-left">
        <p className="font-semibold">{title}</p>
        {lines.filter(Boolean).map((l, i) => <p key={i} className="opacity-90">{l}</p>)}
    </div>
);

export function RunSpreadStrip({ before, after, keys, labels, beforeLabel, afterLabel, aggregation }: RunSpreadStripProps) {
    const degrading = findDegradingRuns(before, after, keys, aggregation);
    const scoreOf = (r: PageSpeedInsightResult, key: ComparableMetricKey) =>
        metricMeasured(r[key]) ? { value: shownValue(r[key]), display: r[key].displayValue } : undefined;

    const rows = keys.flatMap(key => {
        const bRuns = runsOf(before, key);
        const aRuns = runsOf(after, key, degrading[key]?.runs);
        if (!bRuns.length || !aRuns.length) return [];
        const sides: [Side, Side] = [
            { label: beforeLabel, runs: bRuns, dots: groupDots(bRuns), score: scoreOf(before, key) },
            { label: afterLabel, runs: aRuns, dots: groupDots(aRuns), score: scoreOf(after, key) },
        ];
        const all = [...bRuns, ...aRuns];
        const min = all.reduce((x, y) => (y.value < x.value ? y : x));
        const max = all.reduce((x, y) => (y.value > x.value ? y : x));
        return [{ key, sides, flag: degrading[key], min, max, minSide: bRuns.includes(min) ? beforeLabel : afterLabel, maxSide: bRuns.includes(max) ? beforeLabel : afterLabel }];
    });
    if (!rows.length) return null;

    const unit = (key: ComparableMetricKey) => (key === 'cumulativeLayoutShift' ? ['lower', 'higher'] : ['faster', 'slower']) as [string, string];

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-muted-foreground" />{beforeLabel} run</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" />{afterLabel} run</span>
                <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-error" />flagged (drives the regression)</span>
                <span className="inline-flex items-center gap-1"><span className="h-2.5 w-0.5 rounded-full bg-foreground" />score shown in the table</span>
                <span className="inline-flex items-center gap-1"><span className="font-semibold">×3</span> runs with the same value</span>
                <span className="ml-auto italic">Left = better. Hover any mark for details.</span>
            </div>

            {rows.map(row => {
                const span = row.max.value - row.min.value;
                const pos = (v: number) => `${span ? ((v - row.min.value) / span) * 100 : 50}%`;
                const [better, worse] = unit(row.key);
                const label = labels[row.key];

                const dotTip = (side: Side, dot: Dot) => {
                    const lines: (string | false | undefined)[] = [];
                    if (side.score) {
                        const diff = dot.value - side.score.value;
                        lines.push(Math.abs(diff) < 1e-9
                            ? `Equal to the ${side.label} score (${side.score.display}).`
                            : `${formatValue(row.key, Math.abs(diff))} ${diff < 0 ? better : worse} than the ${side.label} ${aggregation} (${side.score.display}).`);
                    }
                    if (dot.flagged && row.flag) {
                        lines.push(`Flagged: one of the runs driving the regression. Without the flagged runs the ${afterLabel} ${aggregation} would be ${formatValue(row.key, row.flag.without)}, no worse than ${beforeLabel}'s ${row.flag.target.displayValue}.`);
                    }
                    return <Tip title={`${side.label} · ${runsLabel(dot.runs)} · ${label} ${dot.display}`} lines={lines} />;
                };

                return (
                    <div key={row.key} className="grid grid-cols-[2.5rem_4.5rem_1fr] items-center gap-x-2">
                        <Hint label={<Tip title={label} lines={[
                            METRIC_INFO[row.key],
                            'Lower is better.',
                            `${beforeLabel} runs: ${spanOf(row.key, row.sides[0].runs)}.`,
                            `${afterLabel} runs: ${spanOf(row.key, row.sides[1].runs)}.`,
                        ]} />} side="right" delayDuration={100}>
                            <span className="cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted underline-offset-2">{label}</span>
                        </Hint>

                        <div className="flex flex-col text-[10px] text-muted-foreground" style={{ lineHeight: `${LANE}px` }}>
                            <span className="truncate" title={beforeLabel}>{beforeLabel}</span>
                            <span className="truncate" title={afterLabel}>{afterLabel}</span>
                        </div>

                        <div>
                            <div className="relative mx-3" style={{ height: LANE * 2 }} role="img"
                                aria-label={`${label}: ${beforeLabel} runs ${row.sides[0].runs.map(r => r.display).join(', ')}; ${afterLabel} runs ${row.sides[1].runs.map(r => r.display).join(', ')}`}>
                                <div className="absolute inset-x-0 border-t border-border" style={{ top: LANE }} />

                                {row.sides.map((side, laneIdx) => side.score && (
                                    <div key={`score-${laneIdx}`} className="absolute z-10 -translate-x-1/2" style={{ left: pos(side.score.value), top: laneIdx * LANE + 3, height: LANE - 6 }}>
                                        <Hint label={<Tip title={`${side.label} ${label} score · ${side.score.display}`} lines={[`The ${aggregation} of the ${side.label} runs, as shown in the table.`]} />}
                                            delayDuration={100} className="h-full w-2 cursor-help justify-center">
                                            <span className="h-full w-0.5 rounded-full bg-foreground" />
                                        </Hint>
                                    </div>
                                ))}

                                {row.sides.map((side, laneIdx) => side.dots.map(dot => (
                                    <div key={`${laneIdx}-${dot.display}`} className="absolute z-20 -translate-x-1/2 -translate-y-1/2" style={{ left: pos(dot.value), top: laneIdx * LANE + LANE / 2 }}>
                                        <Hint label={dotTip(side, dot)} delayDuration={100} className="relative cursor-help p-1">
                                            <span className={`block h-2 w-2 rounded-full ring-2 ring-background ${dot.flagged ? 'bg-error' : laneIdx === 0 ? 'bg-muted-foreground' : 'bg-primary'}`} />
                                            {dot.runs.length > 1 && (
                                                <span className="absolute left-full top-1/2 -translate-y-1/2 text-[9px] font-semibold leading-none text-muted-foreground">×{dot.runs.length}</span>
                                            )}
                                        </Hint>
                                    </div>
                                )))}
                            </div>

                            <div className="mx-3 mt-0.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                                <Hint label={<Tip title={`Best run on this row · ${row.min.display}`} lines={[`${row.minSide} run #${row.min.runIdx + 1}. The axis starts here; further left is better.`]} />} delayDuration={100}>
                                    <span className="cursor-help underline decoration-dotted underline-offset-2">{row.min.display}</span>
                                </Hint>
                                <Hint label={<Tip title={`Worst run on this row · ${row.max.display}`} lines={[`${row.maxSide} run #${row.max.runIdx + 1}. The axis ends here; further right is worse.`]} />} delayDuration={100}>
                                    <span className="cursor-help underline decoration-dotted underline-offset-2">{row.max.display}</span>
                                </Hint>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
