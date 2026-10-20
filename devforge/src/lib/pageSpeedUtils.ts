import type { PageSpeedAuditDisplay, PageSpeedConfiguration, PageSpeedInsightResult, PageSpeedInsightResultMessage, PageSpeedMetrics, PageSpeedStrategy, PageSpeedTestEnvironment } from "@shared/types/pageSpeedInsight.types";
import { emptyPageSpeedErrorResponse, emptyPageSpeedMetrics } from "@shared/utils/pageSpeedAuditParser";

export function defaultPageSpeedConfiguration(strategy?: PageSpeedStrategy): PageSpeedConfiguration {
    return {
        apiKey: '',
        strategy: strategy || 'desktop',
        runs: 1,
        aggregation: 'average',
        warmUpRun: false,
        urls: [],

        comparisonMode: false,
        comparisonColumns: 'both',
        beforeLabel: 'Before',
        afterLabel: 'After',
        improvementThreshold: 20,
        showImprovement: false,

        showSI: true,
        showLCP: true,
        showCLS: true,
        showTBT: true,
        showFCP: true,
        showWarnings: false,
    };
}

/**
 * PSI's fixed per-strategy presets. The v5 API trims `configSettings` down to form
 * factor and locale, so these fill any field a run did not report. The CPU slowdown
 * is left out for mobile: PSI calibrates it to each host, and the API does not say
 * what it picked.
 */
const PAGESPEED_TEST_PRESETS: Record<PageSpeedStrategy, { device: string; network: string } & PageSpeedTestEnvironment> = {
    mobile: { device: 'Emulated Moto G Power', network: 'Slow 4G', rttMs: 150, throughputKbps: 1638.4, screenWidth: 412, screenHeight: 823, deviceScaleFactor: 1.75 },
    desktop: { device: 'Emulated Desktop', network: 'Custom throttling', rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, screenWidth: 1350, screenHeight: 940, deviceScaleFactor: 1 },
};

/** "1.2" for one value, "1.1–1.3" when runs differ; undefined when none reported. */
function formatRange(values: (number | undefined)[], digits: number): string | undefined {
    const nums = values.filter((v): v is number => typeof v === 'number');
    if (!nums.length) return undefined;
    const fmt = (n: number) => String(Number(n.toFixed(digits)));
    const lo = fmt(Math.min(...nums)), hi = fmt(Math.max(...nums));
    return lo === hi ? lo : `${lo}–${hi}`;
}

/**
 * Header label for the throttling and emulation PSI used. Reads every finished run
 * (including each URL's `runHistory`), falling back to the preset per field.
 */
export function describePageSpeedTestEnvironment(
    strategy: PageSpeedStrategy,
    results: (PageSpeedInsightResult | null | false | undefined)[],
): { summary: string; detail: string } {
    const preset = PAGESPEED_TEST_PRESETS[strategy];
    const envs = results
        .flatMap(r => (r ? (r.runHistory?.length ? r.runHistory : [r]) : []))
        .map(r => r.testEnvironment)
        .filter((e): e is PageSpeedTestEnvironment => !!e);
    const pick = <K extends keyof PageSpeedTestEnvironment>(key: K) => {
        const reported = envs.map(e => e[key]).filter(v => v !== undefined);
        return reported.length ? reported : [preset[key]];
    };

    const rtt = formatRange(pick('rttMs'), 0);
    const mbps = formatRange(pick('throughputKbps').map(k => (k === undefined ? k : k / 1024)), 1);
    const cpu = formatRange(pick('cpuSlowdownMultiplier'), 1);
    const benchmark = formatRange(envs.map(e => e.benchmarkIndex), 0);
    const width = formatRange(pick('screenWidth'), 0), height = formatRange(pick('screenHeight'), 0);
    const dpr = formatRange(pick('deviceScaleFactor'), 2);

    const network = `${preset.network} (${rtt ?? '?'} ms RTT, ${mbps ?? '?'} Mbps)`;
    const cpuText = cpu === undefined ? 'CPU slowdown set per host' : cpu === '1' ? 'no CPU slowdown' : `${cpu}x CPU slowdown`;

    const detail = [
        `Simulated throttling on Google's servers: ${rtt ?? '?'} ms round trip, ${mbps ?? '?'} Mbps throughput, ${cpuText}.`,
        width && height ? `Screen ${width}×${height} at ${dpr ?? '?'}x DPR.` : '',
        benchmark
            ? `Host CPU/memory power (unthrottled): ${benchmark}. PSI scales the CPU slowdown to this, so it can differ between runs.`
            : cpu === undefined ? 'PSI scales the CPU slowdown to each host and the API does not report it; the PageSpeed Insights site shows it per report.' : '',
        'Cold load with cache and storage cleared.',
    ].filter(Boolean).join(' ');

    return { summary: `${preset.device} · ${network} · ${cpuText}`, detail };
}

export function defaultPageSpeedResult(url: string): PageSpeedInsightResult {
    return {
        url: url,
        speedIndex: emptyPageSpeedMetrics(),
        largestContentfulPaint: emptyPageSpeedMetrics(),
        cumulativeLayoutShift: emptyPageSpeedMetrics(),
        totalBlockingTime: emptyPageSpeedMetrics(),
        firstContentfulPaint: emptyPageSpeedMetrics(),
        runWarnings: '',
        errorResponse: emptyPageSpeedErrorResponse(),
    };
}

export function displayPageSpeedAudit(config: PageSpeedConfiguration): PageSpeedAuditDisplay {
    return {
        SI: config.showSI,
        LCP: config.showLCP,
        CLS: config.showCLS,
        TBT: config.showTBT,
        FCP: config.showFCP,
        singleResult: !config.comparisonMode,
        before: config.comparisonMode && config.comparisonColumns !== 'after',
        after: config.comparisonMode && config.comparisonColumns !== 'before',
        // A percentage with no visible baseline reads as unexplained, so the delta
        // goes when either side does.
        improvement: config.showImprovement && config.comparisonMode && (config.comparisonColumns ?? 'both') === 'both',
    }
}

export function defaultPageSpeedResults(urls: string[]): PageSpeedInsightResult[] {
    return urls.map(url => defaultPageSpeedResult(url));
}

export function getPageSpeedInsightResultMessages(result1: PageSpeedInsightResult | undefined, result2: PageSpeedInsightResult | undefined): PageSpeedInsightResultMessage[] {
    let messages: PageSpeedInsightResultMessage[] = [];

    const pushMessages = (value: string | string[] | undefined, isError: boolean) => {
        if (!value) return;
        const items = Array.isArray(value) ? value : [value];
        for (const msg of items) {
            if (msg.length > 0) messages.push({ isError, message: msg });
        }
    };

    if (result1?.errorResponse?.message) {
        pushMessages(result1.errorResponse.message, true);
    } else {
        pushMessages(result1?.runWarnings, false);
    }
    if (result2?.errorResponse?.message) {
        pushMessages(result2.errorResponse.message, true);
    } else {
        pushMessages(result2?.runWarnings, false);
    }
    return messages;
}

export type ComparableMetricKey =
    'speedIndex' | 'largestContentfulPaint' | 'cumulativeLayoutShift' | 'totalBlockingTime' | 'firstContentfulPaint';

// The value as shown on screen, in one unit (ms for timings), so "0.6 s" and "600 ms"
// compare equal. Strings can't be compared directly: Lighthouse writes "0.6\u00a0s"
// (non-breaking space) while an aggregate writes "0.6 s", and a CLS of "0" aggregates
// to "0.000". Falls back to the raw value when the display carries no number.
export function shownValue(metric: PageSpeedMetrics): number {
    const display = String(metric.displayValue ?? '').replace(/[\s,]/g, '').toLowerCase();
    const n = parseFloat(display);
    if (!Number.isFinite(n)) return metric.numericValue;
    return display.endsWith('s') && !display.endsWith('ms') ? n * 1000 : n;
}

/** Average or median of plain values — the same rule the aggregate row uses. */
export function aggregateValues(values: number[], aggregation: PageSpeedConfiguration['aggregation']): number {
    if (!values.length) return 0;
    if (aggregation === 'median') {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    }
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * How far one run sits above the target scores (the Before column), summed as
 * fractions of each target (0.5 = 50 % worse). 0 means the run is no worse than the
 * target on any metric — compared as displayed, so a rounding tie is not "worse".
 * An errored run is Infinity so any measured run beats it; a metric the run did not
 * measure, or that has no target, adds nothing.
 */
export function excessOverTargets(
    run: PageSpeedInsightResult,
    targets: Partial<Record<ComparableMetricKey, PageSpeedMetrics>>,
    keys: ComparableMetricKey[],
): number {
    if (resultHasError(run)) return Number.POSITIVE_INFINITY;
    let excess = 0;
    for (const key of keys) {
        const t = targets[key];
        const v = run[key];
        if (!t || !metricMeasured(t) || !metricMeasured(v)) continue;
        const target = shownValue(t);
        const value = shownValue(v);
        if (!target || value <= target) continue;
        excess += value / target - 1;
    }
    return excess;
}

export interface DegradingRuns {
    /** The Before score (average or median) the After score must not exceed. */
    target: PageSpeedMetrics;
    /** The fewest worst After runs whose removal clears the regression. */
    runs: Set<number>;
    /** The After score without those runs, in the displayed unit (ms; unitless for CLS). */
    without: number;
}

/**
 * The After runs to blame for a regressed metric: the fewest worst runs whose removal
 * brings the After score back to the Before score or better.
 *
 * This explains every negative Improvement — one outlier beyond the Before range, or
 * a shift in how many runs land slow (e.g. 5 of 7 slow instead of 3 of 7). Only runs
 * worse than the Before score are candidates: dropping a better run cannot help. At
 * least one run is always kept, so a fully slower row flags all but its best run.
 */
export function findDegradingRuns(
    before: PageSpeedInsightResult | undefined,
    after: PageSpeedInsightResult | undefined,
    keys: ComparableMetricKey[],
    aggregation: PageSpeedConfiguration['aggregation'] = 'average',
): Partial<Record<ComparableMetricKey, DegradingRuns>> {
    const found: Partial<Record<ComparableMetricKey, DegradingRuns>> = {};
    const afterRuns = after?.runHistory;
    if (!before || !after || !afterRuns?.length) return found;

    for (const key of keys) {
        const pct = improvementPercent(before[key], after[key]);
        if (pct === null || pct >= 0) continue;
        const target = shownValue(before[key]);

        const measured = afterRuns.flatMap((r, i) =>
            !resultHasError(r) && metricMeasured(r[key]) ? [{ i, v: shownValue(r[key]) }] : []);
        if (!measured.length) continue;

        const runs = new Set<number>();
        let without = aggregateValues(measured.map(m => m.v), aggregation);
        for (const worst of [...measured].sort((x, y) => y.v - x.v || x.i - y.i)) {
            if (without <= target || worst.v <= target || runs.size >= measured.length - 1) break;
            runs.add(worst.i);
            without = aggregateValues(measured.filter(m => !runs.has(m.i)).map(m => m.v), aggregation);
        }
        if (runs.size) found[key] = { target: before[key], runs, without };
    }
    return found;
}

export function aggregatePageSpeedInsightResults(
    url: string,
    results: PageSpeedInsightResult[],
    aggregation: PageSpeedConfiguration['aggregation'] = 'average',
): PageSpeedInsightResult {
    if (results.length === 0) return defaultPageSpeedResult(url);
    if (results.length === 1) return results[0]!;

    const formatDisplayValue = (value: number, numericUnit: string, referenceDisplay: string): string => {
        if (numericUnit === 'unitless') {
            // CLS-style: show as decimal (e.g. "0.617")
            return value < 0.005 ? value.toFixed(3) : parseFloat(value.toFixed(3)).toString();
        }
        // Millisecond-based metric — check reference to determine seconds vs ms format
        if (referenceDisplay.includes('ms')) {
            return `${Math.round(value).toLocaleString()} ms`;

        }
        return `${(value / 1000).toFixed(1)} s`;
    };

    const isRunError = (r: PageSpeedInsightResult): boolean => {
        const err = r.errorResponse;
        if (!err) return false;
        if (err.code !== 0) return true;
        const msg = err.message;
        return Array.isArray(msg) ? msg.some(m => m.length > 0) : msg.length > 0;
    };

    // Median of an even-sized set is the mean of the two middle values.
    const median = (values: number[]): number => {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
    };

    const aggMetric = (
        key: keyof Pick<PageSpeedInsightResult,
            'speedIndex' | 'largestContentfulPaint' | 'cumulativeLayoutShift' | 'totalBlockingTime' | 'firstContentfulPaint'>
    ): PageSpeedMetrics => {
        const valid = results.filter(r => !isRunError(r) && r[key]?.numericValue != null);

        if (valid.length === 0) {
            return results[0]![key];
        }

        const values = valid.map(r => r[key].numericValue);
        const agg = aggregation === 'median'
            ? median(values)
            : values.reduce((sum, v) => sum + v, 0) / values.length;
        const ref = valid[0]![key];

        return {
            ...ref,
            numericValue: agg,
            displayValue: formatDisplayValue(agg, ref.numericUnit, ref.displayValue),
        };
    };

    const result: PageSpeedInsightResult = {
        url,
        speedIndex: aggMetric('speedIndex'),
        largestContentfulPaint: aggMetric('largestContentfulPaint'),
        cumulativeLayoutShift: aggMetric('cumulativeLayoutShift'),
        totalBlockingTime: aggMetric('totalBlockingTime'),
        firstContentfulPaint: aggMetric('firstContentfulPaint'),
        ...(results.length > 1 ? { runHistory: results } : {}),
    };

    const warnings = [...new Set(
        results.flatMap((r, i) => {
            if (!r.runWarnings) return [];
            const items = Array.isArray(r.runWarnings) ? r.runWarnings : [r.runWarnings];
            return items
                .map(w => w.trim())
                .filter(w => w.length > 0)
                .map(w => results.length === 1 ? w : `Run ${i + 1}: ${w}`);
        })
    )];

    const errors = results.flatMap((r, i) => {
        if (!r.errorResponse?.message) return [];
        const items = Array.isArray(r.errorResponse.message) ? r.errorResponse.message : [r.errorResponse.message];
        return items
            .map(msg => msg.trim())
            .filter(msg => msg.length > 0)
            .map(msg => results.length === 1 ? msg : `Run ${i + 1}: ${msg}`);
    });

    if (warnings.length > 0) result.runWarnings = warnings;
    if (errors.length > 0) result.errorResponse = { code: 0, message: errors };

    // Preserve qualitative fields from last non-error result (can't be meaningfully averaged)
    const lastGood = [...results].reverse().find(r => !isRunError(r));
    if (lastGood) {
        result.interactive = lastGood.interactive;
        result.opportunities = lastGood.opportunities;
        result.passedAudits = lastGood.passedAudits;
        result.performanceScore = lastGood.performanceScore;
        result.lighthouseVersion = lastGood.lighthouseVersion;
        result.fetchTime = lastGood.fetchTime;
        result.testEnvironment = lastGood.testEnvironment;
    }

    return result;
}
// ─── Keeping per-row state aligned when the URL list is edited ────────────────
// Results, analyses and expanded-row state are all stored positionally, indexed
// against `config.urls`. Removing (or reordering) a URL therefore slides every
// later row's data onto the wrong URL unless the stored rows are remapped first.

/**
 * For each URL in `nextUrls`, the index it occupied in `prevUrls`, or -1 when it
 * is new. Duplicate URLs each consume a distinct previous slot, left to right.
 */
export function mapUrlsToPreviousIndexes(prevUrls: string[], nextUrls: string[]): number[] {
    const available = new Map<string, number[]>();
    prevUrls.forEach((url, i) => {
        const slots = available.get(url);
        if (slots) slots.push(i); else available.set(url, [i]);
    });
    return nextUrls.map(url => available.get(url)?.shift() ?? -1);
}

/** Re-order positional row data onto the new URL positions; new rows come back `undefined`. */
export function realignSlots<T>(slots: T[], indexMap: number[]): (T | undefined)[] {
    return indexMap.map(prevIndex => (prevIndex === -1 ? undefined : slots[prevIndex]));
}

/** Re-key an index-keyed record (e.g. per-row analyses) onto the new URL positions. */
export function realignIndexedRecord<T>(record: Record<number, T>, indexMap: number[]): Record<number, T> {
    const next: Record<number, T> = {};
    indexMap.forEach((prevIndex, nextIndex) => {
        if (prevIndex === -1) return;
        const value = record[prevIndex];
        if (value !== undefined) next[nextIndex] = value;
    });
    return next;
}

/** Re-key an index-keyed set (e.g. expanded rows) onto the new URL positions. */
export function realignIndexSet(set: Set<number>, indexMap: number[]): Set<number> {
    const next = new Set<number>();
    indexMap.forEach((prevIndex, nextIndex) => {
        if (prevIndex !== -1 && set.has(prevIndex)) next.add(nextIndex);
    });
    return next;
}

/**
 * Whether a finished audit carries an error from the API or from Lighthouse.
 *
 * A successful parse still attaches an `errorResponse`, zeroed — so presence of the
 * object means nothing and only a non-zero code or a non-empty message counts.
 */
export function resultHasError(result: PageSpeedInsightResult | undefined): boolean {
    const err = result?.errorResponse;
    if (!err) return false;
    const hasMessage = Array.isArray(err.message)
        ? err.message.some(m => m.length > 0)
        : err.message.length > 0;
    return err.code !== 0 || hasMessage;
}

/**
 * Whether every run of a multi-run audit errored.
 *
 * The distinction that matters for retrying: a partial failure still aggregates into
 * usable metrics, so re-running it would throw away numbers the user can read. Only a
 * total failure — nothing measured — is worth another attempt.
 */
export function allRunsFailed(result: PageSpeedInsightResult | undefined): boolean {
    if (!result) return false;
    const history = result.runHistory;
    if (history?.length) return history.every(r => resultHasError(r));
    return resultHasError(result);
}

/**
 * Whether the audit actually measured this metric.
 *
 * Needed because a zero is ambiguous on its own: an absent metric arrives as
 * `emptyPageSpeedMetrics()` — numericValue 0 — and a perfect CLS is also 0. Only the
 * display string tells them apart: "" when nothing was measured, "0" when it was.
 */
export function metricMeasured(metric: PageSpeedMetrics | undefined): boolean {
    if (!metric) return false;
    if (String(metric.displayValue ?? '').trim() !== '') return true;
    return metric.numericValue > 0;
}

/**
 * The metric as DISPLAYED, so a comparison matches the numbers on screen — "1.3 s"
 * against "1.3 s" is 0%, not a delta hidden by rounding. Falls back to the raw value
 * when the display string carries no number.
 */
export function displayedMetricValue(metric: PageSpeedMetrics | undefined): number {
    if (!metric) return 0;
    const n = parseFloat(String(metric.displayValue).replace(/,/g, ''));
    return Number.isFinite(n) ? n : metric.numericValue;
}

/**
 * Percent improvement from `before` to `after`, positive when the metric got faster.
 * Null means "no percentage exists" — either run never measured the metric — which
 * the caller renders as a dash.
 *
 * A zero baseline (CLS, TBT) has no true percentage: any increase over nothing is
 * infinite, and a flat cap would make 0.001 look as bad as 0.5. So the change is
 * measured against the metric's "good" threshold instead (`zeroBaselineFloor`):
 * CLS 0 → 0.001 is 1% of 0.1, i.e. -1%; TBT 0 → 50 ms is -25%. `zeroBaseline` tells
 * callers to say so. Zero to zero is no change: 0%.
 *
 * A measured zero in `after` is NOT one of those cases: dropping CLS to 0 is the best
 * outcome a page can post and reads as +100%. Testing the number for falsiness instead
 * of the measurement for presence is what previously blanked exactly that result.
 */
export function improvementPercent(
    before: PageSpeedMetrics | undefined,
    after: PageSpeedMetrics | undefined,
): number | null {
    if (!metricMeasured(before) || !metricMeasured(after)) return null;
    const b = displayedMetricValue(before);
    if (!b) {
        if (displayedMetricValue(after) === 0) return 0;
        return -(shownValue(after!) / zeroBaselineFloor(after!).value) * 100;
    }
    return ((b - displayedMetricValue(after)) / b) * 100;
}

/**
 * What a zero-baseline change is measured against: the metric's Lighthouse "good"
 * threshold. Only CLS (unitless) and TBT (ms) can measure 0 — SI, LCP and FCP never
 * do — so the unit decides which one applies.
 */
export function zeroBaselineFloor(metric: PageSpeedMetrics): { value: number; label: string } {
    return metric.numericUnit === 'unitless'
        ? { value: 0.1, label: '0.1, the "good" CLS threshold' }
        : { value: 200, label: '200 ms, the "good" TBT threshold' };
}

/** True when the Before value displays as zero — its % is against `zeroBaselineFloor`, not Before. */
export function zeroBaseline(before: PageSpeedMetrics | undefined, after: PageSpeedMetrics | undefined): boolean {
    return metricMeasured(before) && metricMeasured(after) && displayedMetricValue(before) === 0 && displayedMetricValue(after) !== 0;
}

/**
 * The change as an absolute amount — what a zero-baseline % (e.g. CLS 0.000 → 0.001)
 * actually was. Same sign convention: + is better, - is worse. "-0.001" for CLS, "-50 ms" / "-1.2 s" for timings. Null when
 * either side never measured the metric.
 */
export function absoluteChange(
    before: PageSpeedMetrics | undefined,
    after: PageSpeedMetrics | undefined,
): { value: number; text: string } | null {
    if (!before || !after || !metricMeasured(before) || !metricMeasured(after)) return null;
    const value = shownValue(before) - shownValue(after);
    const magnitude = Math.abs(value);
    const unitless = before.numericUnit === 'unitless' || after.numericUnit === 'unitless';
    const amount = unitless
        ? magnitude.toFixed(3)
        : magnitude >= 1000 ? `${(magnitude / 1000).toFixed(1)} s` : `${Math.round(magnitude)} ms`;
    return { value, text: `${value > 0 ? '+' : value < 0 ? '-' : ''}${amount}` };
}
