function extractMetric(audits, key) {
    return {
        displayValue: audits[key]?.displayValue ?? "",
        numericValue: audits[key]?.numericValue ?? 0,
        numericUnit: audits[key]?.numericUnit ?? "",
    };
}

export function parseToPageSpeedInsightResult(url, audits, runWarnings) {
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

export function buildErrorPageSpeedInsightResult(url, error) {
    return {
        url,
        speedIndex: emptyPageSpeedMetrics(),
        largestContentfulPaint: emptyPageSpeedMetrics(),
        cumulativeLayoutShift: emptyPageSpeedMetrics(),
        totalBlockingTime: emptyPageSpeedMetrics(),
        firstContentfulPaint: emptyPageSpeedMetrics(),
        runWarnings: "",
        errorResponse: { code: 403, message: error },
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
