// Run forensics: is a Before → After movement real, and why did a run spike?
//
// PSI is noisy. A release can read as a 40 % regression because two of seven runs hit
// a cold cache, a slow test machine or a sluggish origin. The red flags say WHICH runs
// drag a metric down; this module says whether the change survives the noise and what
// set each spike apart from an ordinary run — using signals every run already carries
// (server response time, the PSI machine's benchmark, run order, resource details).
//
// Pure functions, no React, no I/O.

import type { PageSpeedConfiguration, PageSpeedInsightResult } from '@shared/types/pageSpeedInsight.types';
import { aggregatePageSpeedInsightResults, aggregateValues, findDegradingRuns, improvementPercent, metricMeasured, resultHasError, shownValue, type ComparableMetricKey } from './pageSpeedUtils';
import { collectAudits, diffAuditItems, formatBytes, formatMs, representativeRun } from './pagespeedEvidenceDiff';

// ─── verdict ───────────────────────────────────────────────────────────────

export type MetricVerdict = 'regression' | 'improved' | 'noise' | 'no-change' | 'too-few';

export interface MetricVerdictResult {
    verdict: MetricVerdict;
    /** Share of (Before, After) run pairs where the After run is slower; ties count ½.
     *  0.5 = the two sets are indistinguishable, 1 = every After run is slower. */
    slowerShare: number;
    /** How many (Before, After) pairs `slowerShare` was computed over. */
    pairs: number;
    /** Improvement % with the flagged After runs left out; undefined when none were flagged. */
    trimmedImprovement?: number | undefined;
    /** The After run indexes left out of `trimmedImprovement`. */
    excluded: number[];
}

// Vargha–Delaney's "large effect" cutoff: past it, the After runs are consistently
// on one side of the Before runs rather than mixed in among them.
export const LARGE_EFFECT = 0.71;
const MIN_RUNS_FOR_VERDICT = 3;

const runsOf = (result: PageSpeedInsightResult): PageSpeedInsightResult[] =>
    result.runHistory?.length ? result.runHistory : [result];

/** Displayed values of every run that measured `key`, keyed by run index. */
const measuredValues = (result: PageSpeedInsightResult, key: ComparableMetricKey): Map<number, number> => {
    const out = new Map<number, number>();
    runsOf(result).forEach((r, i) => {
        if (!resultHasError(r) && metricMeasured(r[key])) out.set(i, shownValue(r[key]));
    });
    return out;
};

/**
 * Whether a metric's Before → After change is real or within run-to-run noise.
 *
 * `slowerShare` is the Mann–Whitney U statistic over n₁·n₂ (Vargha–Delaney A): it
 * needs no normality assumption and stays meaningful at the 3–10 runs PSI allows.
 * The Improvement column only sets the direction; the verdict comes from how the
 * runs themselves overlap.
 */
export function metricVerdict(
    before: PageSpeedInsightResult | undefined,
    after: PageSpeedInsightResult | undefined,
    key: ComparableMetricKey,
    aggregation: PageSpeedConfiguration['aggregation'],
): MetricVerdictResult {
    const empty: MetricVerdictResult = { verdict: 'too-few', slowerShare: 0.5, pairs: 0, excluded: [] };
    if (!before || !after) return empty;
    const b = [...measuredValues(before, key).values()];
    const afterValues = measuredValues(after, key);
    const a = [...afterValues.values()];
    if (b.length < MIN_RUNS_FOR_VERDICT || a.length < MIN_RUNS_FOR_VERDICT) return { ...empty, pairs: b.length * a.length };

    let slower = 0;
    for (const x of b) for (const y of a) slower += y > x ? 1 : y === x ? 0.5 : 0;
    const pairs = b.length * a.length;
    const slowerShare = slower / pairs;

    const excluded = [...(findDegradingRuns(before, after, [key], aggregation)[key]?.runs ?? [])].sort((x, y) => x - y);
    let trimmedImprovement: number | undefined;
    const kept = [...afterValues].filter(([i]) => !excluded.includes(i)).map(([, v]) => v);
    const beforeShown = shownValue(before[key]);
    if (excluded.length && kept.length && beforeShown) {
        trimmedImprovement = ((beforeShown - aggregateValues(kept, aggregation)) / beforeShown) * 100;
    }

    const improvement = improvementPercent(before[key], after[key]);
    let verdict: MetricVerdict;
    if (slowerShare >= LARGE_EFFECT && (improvement ?? -1) < 0) verdict = 'regression';
    else if (slowerShare <= 1 - LARGE_EFFECT && (improvement ?? 1) > 0) verdict = 'improved';
    else if (improvement !== null && improvement < 0) verdict = 'noise';
    else verdict = 'no-change';

    return { verdict, slowerShare, pairs, trimmedImprovement, excluded };
}

// ─── spike causes ──────────────────────────────────────────────────────────

export type SpikeCauseKind = 'slow-server' | 'slow-machine' | 'warm-up' | 'heavier-page' | 'jitter';

export interface SpikeCause {
    kind: SpikeCauseKind;
    /** Short chip text, e.g. "slow server". */
    label: string;
    /** One sentence with the numbers behind it. */
    detail: string;
}

const SLOW_SERVER_FACTOR = 2;
const SLOW_SERVER_MIN_MS = 500;
const SLOW_MACHINE_FACTOR = 0.8;
const HEAVIER_MIN_BYTES = 100 * 1024;
const HEAVIER_MIN_MS = 200;
const PAGE_WEIGHT_AUDITS = ['network-requests', 'third-party-summary', 'bootup-time'] as const;

/** Server response time from the `server-response-time` audit ("Root document took 1,820 ms"). */
export function serverResponseMs(run: PageSpeedInsightResult | undefined): number | undefined {
    const display = collectAudits(run).get('server-response-time')?.displayValue;
    if (!display) return undefined;
    const match = /([\d.,]+)\s*(ms|s)\b/i.exec(display.replace(/\u00a0/g, ' '));
    if (!match) return undefined;
    const n = parseFloat(match[1]!.replace(/,/g, ''));
    if (!Number.isFinite(n)) return undefined;
    return match[2]!.toLowerCase() === 's' ? n * 1000 : n;
}

const median = (values: number[]): number | undefined => (values.length ? aggregateValues(values, 'median') : undefined);

/** Flagged After runs forming one block from run #1 that covers at most half the runs —
 *  the shape a cold CDN or server cache leaves behind. */
const warmUpBlock = (flagged: number[], runCount: number): boolean =>
    flagged.length > 0
    && flagged.length <= Math.floor(runCount / 2)
    && flagged.every((runIdx, i) => runIdx === i);

/** Every After run index flagged on any of `keys`, in run order. */
export function flaggedAfterRuns(
    before: PageSpeedInsightResult | undefined,
    after: PageSpeedInsightResult | undefined,
    keys: ComparableMetricKey[],
    aggregation: PageSpeedConfiguration['aggregation'] = 'average',
): number[] {
    const found = findDegradingRuns(before, after, keys, aggregation);
    return [...new Set(Object.values(found).flatMap(d => [...d.runs]))].sort((x, y) => x - y);
}

/**
 * Why one flagged After run spiked, compared with a typical (unflagged) After run.
 * Most specific cause first; `jitter` only when nothing else stands out.
 */
export function explainSpike(
    runIdx: number,
    after: PageSpeedInsightResult,
    flagged: number[],
    pageOrigin?: string | undefined,
): SpikeCause[] {
    const history = after.runHistory ?? [];
    const run = history[runIdx];
    if (!run) return [];
    const unflagged = history.filter((r, i) => !flagged.includes(i) && !resultHasError(r));
    const typical = unflagged.length ? representativeRun({ ...after, runHistory: unflagged }) : undefined;
    const causes: SpikeCause[] = [];

    const serverMs = serverResponseMs(run);
    const typicalServerMs = median(unflagged.map(serverResponseMs).filter((v): v is number => v !== undefined));
    if (serverMs !== undefined && typicalServerMs !== undefined
        && serverMs >= typicalServerMs * SLOW_SERVER_FACTOR && serverMs - typicalServerMs >= SLOW_SERVER_MIN_MS) {
        causes.push({
            kind: 'slow-server',
            label: 'slow server',
            detail: `Server took ${formatMs(serverMs)} to respond, vs ${formatMs(typicalServerMs)} on a typical run (cold cache or a busy origin).`,
        });
    }

    const benchmark = run.testEnvironment?.benchmarkIndex;
    const typicalBenchmark = median(history.map(r => r.testEnvironment?.benchmarkIndex).filter((v): v is number => typeof v === 'number'));
    if (benchmark !== undefined && typicalBenchmark !== undefined && benchmark < typicalBenchmark * SLOW_MACHINE_FACTOR) {
        causes.push({
            kind: 'slow-machine',
            label: 'slow test machine',
            detail: `PSI ran this on a slower machine: benchmark ${Math.round(benchmark)} vs ${Math.round(typicalBenchmark)} typical. Test-environment noise, not your page.`,
        });
    }

    if (warmUpBlock(flagged, history.length) && flagged.includes(runIdx)) {
        causes.push({
            kind: 'warm-up',
            label: 'warm-up',
            detail: `Only the first run${flagged.length > 1 ? 's' : ''} (#1${flagged.length > 1 ? `–#${flagged.length}` : ''}) spiked, then results settled. Typical of a cold cache after a deploy or purge.`,
        });
    }

    if (typical && typical !== run) {
        const auditsTypical = collectAudits(typical);
        const auditsRun = collectAudits(run);
        const heaviest = PAGE_WEIGHT_AUDITS
            .flatMap(key => diffAuditItems(key, auditsTypical.get(key)?.details, auditsRun.get(key)?.details, { pageOrigin }))
            .map(d => ({ d, bytes: (d.afterBytes ?? 0) - (d.beforeBytes ?? 0), ms: (d.afterMs ?? 0) - (d.beforeMs ?? 0) }))
            .filter(x => x.bytes >= HEAVIER_MIN_BYTES || x.ms >= HEAVIER_MIN_MS)
            .sort((x, y) => (y.bytes / 1024 + y.ms) - (x.bytes / 1024 + x.ms))[0];
        if (heaviest) {
            const amount = heaviest.bytes >= HEAVIER_MIN_BYTES ? `+${formatBytes(heaviest.bytes)}` : `+${formatMs(heaviest.ms)}`;
            causes.push({
                kind: 'heavier-page',
                label: 'heavier page',
                detail: `${heaviest.d.label} cost ${amount} more than on a typical run${heaviest.d.status === 'added' ? ' (not loaded on the typical run at all)' : ''}.`,
            });
        }
    }

    if (!causes.length) {
        causes.push({
            kind: 'jitter',
            label: 'jitter',
            detail: 'Same server response, test machine and resources as a typical run. Most likely network jitter on the PSI side.',
        });
    }
    return causes;
}

// ─── warm-up pattern ───────────────────────────────────────────────────────

/** The leading After runs that look like a cold-cache warm-up, or null. */
export function detectWarmUp(
    before: PageSpeedInsightResult | undefined,
    after: PageSpeedInsightResult | undefined,
    keys: ComparableMetricKey[],
    aggregation: PageSpeedConfiguration['aggregation'] = 'average',
): { runs: number[] } | null {
    const runCount = after?.runHistory?.length ?? 0;
    const flagged = flaggedAfterRuns(before, after, keys, aggregation);
    return warmUpBlock(flagged, runCount) ? { runs: flagged } : null;
}

// ─── re-audit planning ─────────────────────────────────────────────────────

const degradingFor = (
    before: PageSpeedInsightResult,
    history: PageSpeedInsightResult[],
    keys: ComparableMetricKey[],
    aggregation: PageSpeedConfiguration['aggregation'],
) => findDegradingRuns(before, aggregatePageSpeedInsightResults(history[0]?.url ?? '', history, aggregation), keys, aggregation);

/** Whether run `runIdx` is still flagged for the row as it stands now. */
export function isRunFlagged(
    before: PageSpeedInsightResult,
    history: PageSpeedInsightResult[],
    keys: ComparableMetricKey[],
    aggregation: PageSpeedConfiguration['aggregation'],
    runIdx: number,
): boolean {
    return Object.values(degradingFor(before, history, keys, aggregation)).some(d => d.runs.has(runIdx));
}

/**
 * The next run a re-audit should work on: the first still-flagged run not yet
 * attempted, with the metrics it is flagged for — the only ones it is judged on.
 * Recomputed after every accepted fresh run, because one faster run can clear the
 * flags of others. Undefined when nothing is left to re-audit.
 */
export function nextReauditRun(
    before: PageSpeedInsightResult,
    history: PageSpeedInsightResult[],
    keys: ComparableMetricKey[],
    aggregation: PageSpeedConfiguration['aggregation'],
    attempted: ReadonlySet<number>,
): { runIdx: number; keys: ComparableMetricKey[] } | undefined {
    if (history.length < 2) return undefined;
    const found = degradingFor(before, history, keys, aggregation);
    const flagged = [...new Set(Object.values(found).flatMap(d => [...d.runs]))].sort((x, y) => x - y);
    const runIdx = flagged.find(i => !attempted.has(i));
    if (runIdx === undefined) return undefined;
    return { runIdx, keys: keys.filter(k => found[k]?.runs.has(runIdx)) };
}

// ─── re-audit outcomes ─────────────────────────────────────────────────────
// A failed audit never throws — it comes back as a result carrying an errorResponse — so
// "no closer" and "the audit errored" look identical on the table. Each attempt records
// which one it was, so the notice can say why a run stayed as it was.

// `repeat`: PSI answered with an audit whose fetchTime is already in the row — the same
// Lighthouse run served again (cached), so it is neither new data nor an error.
export type ReauditAttemptOutcome = 'improved' | 'no-closer' | 'errored' | 'repeat';

export interface ReauditRunReport {
    /** 0-based After run the attempts were spent on. */
    runIdx: number;
    outcomes: ReauditAttemptOutcome[];
    /** The API's message from the last errored attempt. */
    error?: string | undefined;
    /** Wall-clock time spent on this run's audits. A real PSI audit takes seconds, not milliseconds. */
    elapsedMs?: number | undefined;
}

// Runs whose attempts must all fail before the re-audit gives up: one bad run can be a
// flaky page, two in a row is the API (quota, key, rate limit).
const STALL_RUNS = 2;
const MAX_ERROR_CHARS = 120;

/** Readable text of an audit's error: an errorResponse, an Error, a string, or a thrown API body. */
export function auditErrorText(error: unknown): string | undefined {
    const raw = typeof error === 'string' ? error : (error as { message?: unknown } | null | undefined)?.message;
    const text = (Array.isArray(raw) ? raw.join('; ') : typeof raw === 'string' ? raw : '').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line per run: what its attempts did. */
export function describeReauditRun(report: ReauditRunReport): string {
    const { outcomes } = report;
    const attempts = plural(outcomes.length, 'attempt');
    const errored = outcomes.filter(o => o === 'errored').length;
    const repeated = outcomes.filter(o => o === 'repeat').length;
    const why = report.error ? ` (${report.error})` : '';
    const label = `#${report.runIdx + 1}`;
    const took = report.elapsedMs === undefined ? '' : ` — ${(report.elapsedMs / 1000).toFixed(1)}s`;
    if (errored === outcomes.length) return `${label}: all ${attempts} errored${why}${took}`;
    if (repeated === outcomes.length) return `${label}: all ${attempts} returned an audit PSI had already served (cached), so nothing new was measured${took}`;
    const notes = `${errored ? `; ${errored} errored${why}` : ''}${repeated ? `; ${repeated} repeated an earlier audit (cached)` : ''}${took}`;
    const improvedAt = outcomes.indexOf('improved');
    if (improvedAt >= 0) return `${label}: closer to Before on attempt ${improvedAt + 1} of ${outcomes.length}${notes}`;
    return `${label}: ${attempts}, none closer to Before${notes}`;
}

/** Runs that got at least one cached audit, with how many of their attempts it was — for marking them on the table. */
export function cachedAttemptsByRun(reports: readonly ReauditRunReport[]): Record<number, { repeated: number; attempts: number }> {
    const cached: Record<number, { repeated: number; attempts: number }> = {};
    for (const r of reports) {
        const repeated = r.outcomes.filter(o => o === 'repeat').length;
        if (repeated) cached[r.runIdx] = { repeated, attempts: r.outcomes.length };
    }
    return cached;
}

const unusable = (r: ReauditRunReport): boolean =>
    r.outcomes.length > 0 && r.outcomes.every(o => o === 'errored' || o === 'repeat');

/** Whether the latest runs got nothing usable from any attempt — more attempts would only fail the same way. */
export function reauditStalled(reports: readonly ReauditRunReport[]): boolean {
    const tail = reports.slice(-STALL_RUNS);
    return tail.length === STALL_RUNS && tail.every(unusable);
}

/** Why a stalled re-audit got nothing: PSI replaying stored audits, or the API refusing. */
export function reauditStallCause(reports: readonly ReauditRunReport[]): 'cached' | 'errored' {
    return reports.slice(-STALL_RUNS).some(r => r.outcomes.includes('repeat')) ? 'cached' : 'errored';
}
