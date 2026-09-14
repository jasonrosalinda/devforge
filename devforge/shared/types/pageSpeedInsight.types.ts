export interface PageSpeedMetrics {
    displayValue: string;
    numericValue: number;
    numericUnit: string;
}

export interface PageSpeedErrorResponse {
    code: number;
    message: string | string[];
}

export interface AuditDetailsHeading {
    key: string;
    valueType?: string;
    label?: string;
}

export interface AuditDetails {
    type: string;
    headings?: AuditDetailsHeading[];
    items?: Record<string, unknown>[];
    overallSavingsMs?: number;
    // Set when `items` was capped at parse time; `itemCount` is the pre-cap length,
    // so a before/after diff can still say "40 of 214 requests shown".
    itemsTruncated?: boolean;
    itemCount?: number;
}

// A Lighthouse audit that PASSED (score >= 0.9) on this run, recorded WITHOUT `details`
// so a before/after diff can report "this was fixed" instead of the audit silently
// vanishing from `opportunities`. ~90 bytes each.
export interface PageSpeedPassedAudit {
    auditKey: string;
    title: string;
    score: number;
    displayValue?: string | undefined;
    metricSavings?: Record<string, number> | undefined;
}

export interface PageSpeedOpportunity {
    type: 'opportunity' | 'diagnostic';
    auditKey?: string;
    title: string;
    description?: string | undefined;
    displayValue?: string | undefined;
    score: number | null;
    scoreDisplayMode?: string | undefined;
    details?: AuditDetails;
    metricSavings?: Record<string, number>;
}

export interface PageSpeedInsightResult {
    url: string;
    speedIndex: PageSpeedMetrics;
    largestContentfulPaint: PageSpeedMetrics;
    cumulativeLayoutShift: PageSpeedMetrics;
    totalBlockingTime: PageSpeedMetrics;
    firstContentfulPaint: PageSpeedMetrics;
    runWarnings?: string | string[];
    errorResponse?: PageSpeedErrorResponse;
    runHistory?: PageSpeedInsightResult[];
    opportunities?: PageSpeedOpportunity[] | undefined;
    passedAudits?: PageSpeedPassedAudit[] | undefined;
    interactive?: PageSpeedMetrics | undefined;
    performanceScore?: number | undefined;
    lighthouseVersion?: string | undefined;
    fetchTime?: string | undefined;
}

export type PageSpeedStrategy = "mobile" | "desktop";

export interface PageSpeedConfiguration {
    apiKey: string;
    strategy: PageSpeedStrategy;
    runs: number;
    aggregation: "average" | "median";
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
    showWarnings: boolean;
}

export interface UsePageSpeedInsightHooks {
    audit: (url: string, signal?: AbortSignal, runs?: number) => Promise<PageSpeedInsightResult>;
}

export interface PageSpeedApiResponse {
    lighthouseResult?: {
        audits?: Record<string, {
            displayValue?: string;
            numericValue?: number;
            numericUnit?: string;
            score?: number | null;
            title?: string;
            description?: string;
            scoreDisplayMode?: string;
            details?: AuditDetails;
            metricSavings?: Record<string, number>;
        }>;
        runWarnings?: string;
        timing?: {
            total: number;
        };
        lighthouseVersion?: string;
        fetchTime?: string;
        categories?: {
            performance?: { score?: number };
        };
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
