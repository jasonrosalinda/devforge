import type { PageSpeedAuditDisplay, PageSpeedConfiguration, PageSpeedInsightResult, PageSpeedInsightResultMessage, PageSpeedMetrics, PageSpeedStrategy } from "@shared/types/pageSpeedInsight.types";
import { emptyPageSpeedErrorResponse, emptyPageSpeedMetrics } from "@shared/utils/pageSpeedAuditParser";

export function defaultPageSpeedConfiguration(strategy?: PageSpeedStrategy): PageSpeedConfiguration {
    return {
        apiKey: '',
        strategy: strategy || 'desktop',
        browserMode: false,
        visitMode: 'warm',
        runMode: 'single',
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

export function getPageSpeedInsightResultAverage(url: string, results: PageSpeedInsightResult[]): PageSpeedInsightResult {
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

    const avgMetric = (
        key: keyof Pick<PageSpeedInsightResult,
            'speedIndex' | 'largestContentfulPaint' | 'cumulativeLayoutShift' | 'totalBlockingTime' | 'firstContentfulPaint'>
    ): PageSpeedMetrics => {
        const valid = results.filter(r => r[key]?.numericValue != null);

        if (valid.length === 0) {
            return results[0]![key];
        }

        const avg = valid.reduce((sum, r) => sum + r[key].numericValue, 0) / valid.length;
        const ref = valid[0]![key];

        return {
            ...ref,
            numericValue: avg,
            displayValue: formatDisplayValue(avg, ref.numericUnit, ref.displayValue),
        };
    };

    const result: PageSpeedInsightResult = {
        url,
        speedIndex: avgMetric('speedIndex'),
        largestContentfulPaint: avgMetric('largestContentfulPaint'),
        cumulativeLayoutShift: avgMetric('cumulativeLayoutShift'),
        totalBlockingTime: avgMetric('totalBlockingTime'),
        firstContentfulPaint: avgMetric('firstContentfulPaint'),
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

    return result;
}