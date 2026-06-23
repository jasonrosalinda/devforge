import type { PageSpeedMetrics, PageSpeedInsightResult, PageSpeedErrorResponse, PageSpeedOpportunity, AuditDetails } from "../types/pageSpeedInsight.types";

type AuditEntry = {
    displayValue?: string;
    numericValue?: number;
    numericUnit?: string;
    score?: number | null;
    title?: string;
    description?: string;
    scoreDisplayMode?: string;
    details?: AuditDetails;
    metricSavings?: Record<string, number>;
};
type RawAudits = Record<string, AuditEntry>;

function extractMetric(audits: RawAudits, key: string): PageSpeedMetrics {
    return {
        displayValue: audits[key]?.displayValue ?? "",
        numericValue: audits[key]?.numericValue ?? 0,
        numericUnit: audits[key]?.numericUnit ?? "",
    };
}

const METRIC_AUDIT_KEYS = new Set([
    'speed-index', 'largest-contentful-paint', 'cumulative-layout-shift',
    'total-blocking-time', 'first-contentful-paint',
]);
const SKIP_MODES = new Set(['notApplicable', 'manual']);

// Audits that only carry raw data for other tools (filmstrip, treemap, metric dumps) — never shown.
const DATA_ONLY_KEYS = new Set([
    'screenshot-thumbnails', 'final-screenshot', 'full-page-screenshot',
    'script-treemap-data', 'metrics',
]);

// New Lighthouse "insight" audits (keys end in -insight) + classic savings/opportunity audits.
const isInsightAudit = (key: string): boolean => key.endsWith('-insight');
const isSavingsAudit = (mode: string | undefined): boolean => mode === 'metricSavings' || mode === 'opportunity';

export function parseToPageSpeedInsightResult(
    url: string,
    audits: RawAudits,
    runWarnings?: string,
    meta?: { performanceScore?: number | undefined; lighthouseVersion?: string | undefined; fetchTime?: string | undefined }
): PageSpeedInsightResult {
    const opps: PageSpeedOpportunity[] = Object.entries(audits)
        .filter(([key, a]) =>
            !METRIC_AUDIT_KEYS.has(key) &&
            !DATA_ONLY_KEYS.has(key) &&
            !SKIP_MODES.has(a.scoreDisplayMode ?? '') &&
            !!a.title &&
            (isInsightAudit(key) || isSavingsAudit(a.scoreDisplayMode)) &&
            // Drop passing ("green") audits — but always keep the qualitative *-insight findings
            // (e.g. forced reflow), which can score 1 yet still report a real issue.
            (isInsightAudit(key) || !(typeof a.score === 'number' && a.score >= 0.9))
        )
        // Worst first (score 0 → top); passing audits (score 1) sink to the bottom.
        .sort(([, a], [, b]) => (a.score ?? 1) - (b.score ?? 1))
        .map(([key, a]) => ({
            type: 'opportunity' as const,
            auditKey: key,
            title: a.title!,
            description: a.description,
            displayValue: a.displayValue,
            score: a.score ?? null,
            scoreDisplayMode: a.scoreDisplayMode,
            ...(a.details ? { details: a.details } : {}),
            ...(a.metricSavings ? { metricSavings: a.metricSavings } : {}),
        }));

    const diags: PageSpeedOpportunity[] = Object.entries(audits)
        .filter(([key, a]) =>
            !METRIC_AUDIT_KEYS.has(key) &&
            !DATA_ONLY_KEYS.has(key) &&
            !isInsightAudit(key) &&
            a.scoreDisplayMode === 'informative' &&
            a.title
        )
        .map(([key, a]) => ({
            type: 'diagnostic' as const,
            auditKey: key,
            title: a.title!,
            description: a.description,
            displayValue: a.displayValue,
            score: null,
            scoreDisplayMode: a.scoreDisplayMode,
            ...(a.details ? { details: a.details } : {}),
        }));

    const opportunities = [...opps, ...diags];
    const interactive = extractMetric(audits, 'interactive');

    return {
        url,
        speedIndex: extractMetric(audits, "speed-index"),
        largestContentfulPaint: extractMetric(audits, "largest-contentful-paint"),
        cumulativeLayoutShift: extractMetric(audits, "cumulative-layout-shift"),
        totalBlockingTime: extractMetric(audits, "total-blocking-time"),
        firstContentfulPaint: extractMetric(audits, "first-contentful-paint"),
        ...(interactive.numericValue > 0 ? { interactive } : {}),
        runWarnings: runWarnings ?? "",
        errorResponse: emptyPageSpeedErrorResponse(),
        ...(opportunities.length ? { opportunities } : {}),
        ...(meta ?? {}),
    };
}

export function buildErrorPageSpeedInsightResult(url: string, error: unknown): PageSpeedInsightResult {
    console.log(error);
    return {
        url,
        speedIndex: emptyPageSpeedMetrics(),
        largestContentfulPaint: emptyPageSpeedMetrics(),
        cumulativeLayoutShift: emptyPageSpeedMetrics(),
        totalBlockingTime: emptyPageSpeedMetrics(),
        firstContentfulPaint: emptyPageSpeedMetrics(),
        runWarnings: "",
        errorResponse: parseError(error),
    };
}

export function parseObjectToMetrics(raw: any): PageSpeedInsightResult {
    return {
        url: raw.url,
        speedIndex: raw.speedIndex,
        largestContentfulPaint: raw.largestContentfulPaint,
        cumulativeLayoutShift: raw.cumulativeLayoutShift,
        totalBlockingTime: raw.totalBlockingTime,
        firstContentfulPaint: raw.firstContentfulPaint,
        runWarnings: raw.runWarnings ?? "",
        errorResponse: raw.errorResponse
            ? typeof raw.errorResponse === "string"
                ? { code: 403, message: raw.errorResponse }
                : { code: raw.errorResponse.code, message: raw.errorResponse.message }
            : emptyPageSpeedErrorResponse(),
        opportunities: raw.opportunities ?? undefined,
        interactive: raw.interactive ?? undefined,
        performanceScore: raw.performanceScore ?? undefined,
        lighthouseVersion: raw.lighthouseVersion ?? undefined,
        fetchTime: raw.fetchTime ?? undefined,
    };
}

export function emptyPageSpeedErrorResponse() {
    return {
        code: 0,
        message: "",
    }
}

export function emptyPageSpeedMetrics() {
    return {
        displayValue: "",
        numericValue: 0,
        numericUnit: "",
    }
}
export function parseError(error: unknown): PageSpeedErrorResponse {
    if (typeof error === "object" && error !== null) {
        const obj = error as Record<string, unknown>;

        if (typeof obj.error === "object" && obj.error !== null) {
            const inner = obj.error as Record<string, unknown>;
            return {
                message: inner.message as string,
                code: inner.code as number,
            } as PageSpeedErrorResponse;
        }

        if ("message" in obj) {
            return {
                code: obj.code ?? 500,
                message: obj.message as string,
            } as PageSpeedErrorResponse;
        }
    }

    if (error instanceof Error) {
        return {
            code: 500,
            message: error.message,
        } as PageSpeedErrorResponse;
    }

    return {
        message: "Unknown error",
    } as PageSpeedErrorResponse;
}
