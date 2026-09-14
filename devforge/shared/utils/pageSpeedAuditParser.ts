import type { PageSpeedMetrics, PageSpeedInsightResult, PageSpeedErrorResponse, PageSpeedOpportunity, PageSpeedPassedAudit, AuditDetails } from "../types/pageSpeedInsight.types";

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

// Uncapped `details.items` dominates the serialized size of a result (network-requests
// alone can be 200+ rows), which is what quietly blows the localStorage quota.
// Lighthouse already returns opportunity items worst-first, so a slice keeps the
// high-signal rows — except for the audits below, which are ordered by time.
const MAX_DETAIL_ITEMS = 40;
const CAP_SORT_KEY: Record<string, string> = {
    'network-requests': 'transferSize',
    'long-tasks': 'duration',
};

function capDetails(key: string, details: AuditDetails): AuditDetails {
    const items = details.items;
    if (!items || items.length <= MAX_DETAIL_ITEMS) return details;
    const sortKey = CAP_SORT_KEY[key];
    const ordered = sortKey
        ? [...items].sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0))
        : items;
    return { ...details, items: ordered.slice(0, MAX_DETAIL_ITEMS), itemsTruncated: true, itemCount: items.length };
}

// Audits eligible to be reported at all — shared by the failing (opportunities) and
// passing (passedAudits) passes so the two can never drift apart.
const isCandidate = (key: string, a: AuditEntry): boolean =>
    !METRIC_AUDIT_KEYS.has(key) &&
    !DATA_ONLY_KEYS.has(key) &&
    !SKIP_MODES.has(a.scoreDisplayMode ?? '') &&
    !!a.title &&
    (isInsightAudit(key) || isSavingsAudit(a.scoreDisplayMode));

const isPassing = (a: AuditEntry): boolean => typeof a.score === 'number' && a.score >= 0.9;

export function parseToPageSpeedInsightResult(
    url: string,
    audits: RawAudits,
    runWarnings?: string,
    meta?: { performanceScore?: number | undefined; lighthouseVersion?: string | undefined; fetchTime?: string | undefined }
): PageSpeedInsightResult {
    const opps: PageSpeedOpportunity[] = Object.entries(audits)
        .filter(([key, a]) =>
            isCandidate(key, a) &&
            // Drop passing ("green") audits — but always keep the qualitative *-insight findings
            // (e.g. forced reflow), which can score 1 yet still report a real issue.
            // Passing audits are still recorded, slim, in `passedAudits` below.
            (isInsightAudit(key) || !isPassing(a))
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
            ...(a.details ? { details: capDetails(key, a.details) } : {}),
            ...(a.metricSavings ? { metricSavings: a.metricSavings } : {}),
        }));

    // Audits that passed on this run, without `details`. Lets a before/after diff
    // attribute "fixed" instead of watching the audit disappear from `opportunities`.
    // Sorted by key so diffs are stable between runs.
    const passedAudits: PageSpeedPassedAudit[] = Object.entries(audits)
        .filter(([key, a]) => isCandidate(key, a) && !isInsightAudit(key) && isPassing(a))
        .sort(([ka], [kb]) => ka.localeCompare(kb))
        .map(([key, a]) => ({
            auditKey: key,
            title: a.title!,
            score: a.score as number,
            ...(a.displayValue ? { displayValue: a.displayValue } : {}),
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
            ...(a.details ? { details: capDetails(key, a.details) } : {}),
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
        ...(passedAudits.length ? { passedAudits } : {}),
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
        passedAudits: raw.passedAudits ?? undefined,
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
