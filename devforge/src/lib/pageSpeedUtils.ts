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

    if (result1?.errorResponse?.message) {
        messages.push({ isError: true, message: result1.errorResponse.message });
    }
    else if (result1?.runWarnings) {
        messages.push({ isError: false, message: result1.runWarnings });
    }
    if (result2?.errorResponse?.message) {
        messages.push({ isError: true, message: result2.errorResponse.message });
    }
    else if (result2?.runWarnings) {
        messages.push({ isError: false, message: result2.runWarnings });
    }
    return messages.filter(x => x.message.length > 0);
}

export function getPageSpeedInsightResultAverage(url: string, results: PageSpeedInsightResult[]): PageSpeedInsightResult {
    if (results.length === 0) return defaultPageSpeedResult(url);
    if (results.length === 1) return results[0]!;

    const avgMetric = (
        key: keyof Pick<PageSpeedInsightResult,
            'speedIndex' | 'largestContentfulPaint' | 'cumulativeLayoutShift' | 'totalBlockingTime' | 'firstContentfulPaint'>
    ): PageSpeedMetrics => {
        const valid = results.filter(r => r[key]?.numericValue != null);

        if (valid.length === 0) {
            return results[0]![key];
        }

        const avg = valid.reduce((sum, r) => sum + r[key].numericValue, 0) / valid.length;

        return {
            ...valid[0]![key],
            numericValue: avg,
        };
    };

    const result: PageSpeedInsightResult = {
        url,
        speedIndex: avgMetric('speedIndex'),
        largestContentfulPaint: avgMetric('largestContentfulPaint'),
        cumulativeLayoutShift: avgMetric('cumulativeLayoutShift'),
        totalBlockingTime: avgMetric('totalBlockingTime'),
        firstContentfulPaint: avgMetric('firstContentfulPaint'),
    };

    const warnings = [...new Set(
        results.flatMap((r, i) => {
            const w = r.runWarnings != null ? String(r.runWarnings).trim() : '';
            if (!w) return [];
            return [results.length === 1 ? w : `Run ${i + 1}: ${w}`];
        })
    )];

    const errors = results
        .map((r, i) => {
            const msg = r.errorResponse?.message != null ? String(r.errorResponse.message).trim() : '';
            if (!msg) return null;
            return results.length === 1 ? msg : `Run ${i + 1}: ${msg}`;
        })
        .filter((e): e is string => !!e);

    if (warnings.length > 0) result.runWarnings = warnings.join(' | ');
    if (errors.length > 0) result.errorResponse = { code: 0, message: errors.join(' | ') };

    return result;
}