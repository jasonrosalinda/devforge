import type { PageSpeedAuditDisplay, PageSpeedConfiguration, PageSpeedInsightResult, PageSpeedInsightResultMessage, PageSpeedMetrics, PageSpeedStrategy } from "@shared/types/pageSpeedInsight.types";
import { emptyPageSpeedErrorResponse, emptyPageSpeedMetrics } from "@shared/utils/pageSpeedAuditParser";

export function defaultPageSpeedConfiguration(strategy?: PageSpeedStrategy): PageSpeedConfiguration {
    return {
        apiKey: '',
        strategy: strategy || 'desktop',
        runs: 1,
        aggregation: 'average',
        urls: [],

        comparisonMode: false,
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
        before: config.comparisonMode,
        after: config.comparisonMode,
        improvement: config.showImprovement,
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

export interface RunComparison {
    /** Better-or-equal on every compared metric AND strictly better on at least one. */
    wins: boolean;
    /** How many metrics are not worse — ranks near-misses when nothing wins outright. */
    notWorse: number;
    /** Mean candidate/baseline ratio; lower is faster. Infinity when nothing compared. */
    ratio: number;
}

/**
 * Compare one run against the run it is trying to beat.
 *
 * Uses `numericValue`, never the display string: the same metric can render as
 * "0.8 s" in one run and "980 ms" in another, and parsing those would compare 0.8
 * against 980. Every metric here is lower-is-better. Metrics the baseline never
 * measured (0) are skipped — there is nothing to beat.
 */
export function compareRunToBaseline(
    candidate: PageSpeedInsightResult,
    baseline: PageSpeedInsightResult,
    keys: ComparableMetricKey[],
): RunComparison {
    let allBetterOrEqual = true;
    let strictlyBetter = false;
    let notWorse = 0;
    let ratioSum = 0;
    let counted = 0;

    for (const key of keys) {
        const b = baseline[key]?.numericValue ?? 0;
        const c = candidate[key]?.numericValue ?? 0;
        if (!b) continue;
        counted++;
        if (c > b) allBetterOrEqual = false; else notWorse++;
        if (c < b) strictlyBetter = true;
        ratioSum += c / b;
    }

    return {
        wins: counted > 0 && allBetterOrEqual && strictlyBetter,
        notWorse,
        ratio: counted ? ratioSum / counted : Number.POSITIVE_INFINITY,
    };
}

export interface UnwinnableMetric {
    key: ComparableMetricKey;
    /** Best (lowest) value seen across every run sampled. */
    best: number;
    /** The value it has to beat. */
    target: number;
    /** How much the metric varies between runs — the noise floor. */
    spread: number;
    samples: number;
}

// A metric whose best value is still worse than the target by far more than the runs
// vary between themselves is a real regression, not an unlucky sample. Re-running it
// is wasted API quota, so a brute audit uses this to stop early and say why.
const UNWINNABLE_SPREAD_FACTOR = 5;
const MIN_SAMPLES_FOR_VERDICT = 3;

export function findUnwinnableMetrics(
    samples: Partial<Record<ComparableMetricKey, number[]>>,
    baseline: PageSpeedInsightResult,
    keys: ComparableMetricKey[],
): UnwinnableMetric[] {
    return keys.flatMap(key => {
        const target = baseline[key]?.numericValue ?? 0;
        const values = samples[key] ?? [];
        if (!target || values.length < MIN_SAMPLES_FOR_VERDICT) return [];
        const best = Math.min(...values);
        const spread = Math.max(...values) - best;
        const gap = best - target;
        if (gap <= 0) return [];
        // A perfectly stable metric (spread 0) that is worse is unwinnable outright.
        if (spread > 0 && gap <= spread * UNWINNABLE_SPREAD_FACTOR) return [];
        return [{ key, best, target, spread, samples: values.length }];
    });
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
