import type { PageSpeedMetrics, PageSpeedInsightResult, PageSpeedErrorResponse } from "../types/pageSpeedInsight.types";

type AuditEntry = { displayValue?: string; numericValue?: number; numericUnit?: string; };
type RawAudits = Record<string, AuditEntry>;

function extractMetric(audits: RawAudits, key: string): PageSpeedMetrics {
    return {
        displayValue: audits[key]?.displayValue ?? "",
        numericValue: audits[key]?.numericValue ?? 0,
        numericUnit: audits[key]?.numericUnit ?? "",
    };
}

export function parseToPageSpeedInsightResult(url: string, audits: RawAudits, runWarnings?: string): PageSpeedInsightResult {
    return {
        url,
        speedIndex: extractMetric(audits, "speed-index"),
        largestContentfulPaint: extractMetric(audits, "largest-contentful-paint"),
        cumulativeLayoutShift: extractMetric(audits, "cumulative-layout-shift"),
        totalBlockingTime: extractMetric(audits, "total-blocking-time"),
        firstContentfulPaint: extractMetric(audits, "first-contentful-paint"),
        runWarnings: runWarnings ?? "",
        errorResponse: emptyPageSpeedErrorResponse(),
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