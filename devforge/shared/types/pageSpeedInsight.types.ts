export interface PageSpeedMetrics {
    displayValue: string;
    numericValue: number;
    numericUnit: string;
}

export interface PageSpeedErrorResponse {
    code: number;
    message: string;
}

export interface PageSpeedInsightResult {
    url: string;
    speedIndex: PageSpeedMetrics;
    largestContentfulPaint: PageSpeedMetrics;
    cumulativeLayoutShift: PageSpeedMetrics;
    totalBlockingTime: PageSpeedMetrics;
    firstContentfulPaint: PageSpeedMetrics;
    runWarnings?: string;
    errorResponse?: PageSpeedErrorResponse;
}

export type PageSpeedStrategy = "mobile" | "desktop";

export interface PageSpeedConfiguration {
    apiKey: string;
    strategy: PageSpeedStrategy;
    urls: string[];
    comparisonMode: boolean;
    beforeLabel: string;
    afterLabel: string;
    improvementThreshold: number;
    showImprovement: boolean;
    showSI: boolean;
    showLCP: boolean;
    showCLS: boolean;
    showTBT: boolean;
    showFCP: boolean;
}

export interface UsePageSpeedInsightHooks {
    audit: (url: string) => Promise<PageSpeedInsightResult>;
}

export interface PageSpeedApiResponse {
    lighthouseResult?: {
        audits?: Record<string, Partial<PageSpeedMetrics>>;
        runWarnings?: string;
    };
}

export interface PageSpeedAuditDisplay {
    SI: boolean;
    LCP: boolean;
    CLS: boolean;
    TBT: boolean;
    FCP: boolean;
    singleResult: boolean;
    before: boolean;
    after: boolean;
    improvement: boolean;
}

export type PageSpeedInsightResultMessage = {
    isError: boolean;
    message: string;
};