import type { PageSpeedAuditDisplay, PageSpeedConfiguration, PageSpeedInsightResult, PageSpeedInsightResultMessage, PageSpeedStrategy } from "@shared/types/pageSpeedInsight.types";
import { emptyPageSpeedErrorResponse, emptyPageSpeedMetrics } from "@shared/utils/pageSpeedAuditParser";

export function defaultPageSpeedConfiguration(strategy?: PageSpeedStrategy): PageSpeedConfiguration {
    return {
        apiKey: '',
        strategy: strategy || 'desktop',
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

    if (result1?.errorResponse?.message)
        messages.push({ isError: true, message: result1.errorResponse.message });
    if (result2?.errorResponse?.message)
        messages.push({ isError: true, message: result2.errorResponse.message });
    return messages;
}