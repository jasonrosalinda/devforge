'use strict';

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatMs(ms) {
    if (ms >= 60000) {
        const mins = Math.floor(ms / 60000);
        const secs = ((ms % 60000) / 1000).toFixed(2);
        return `${mins}m ${secs}s`;
    }
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.round(ms)}ms`;
}

// ─── Audit constants ──────────────────────────────────────────────────────────

const REQUIRED_AUDITS = [
    'first-contentful-paint',
    'largest-contentful-paint',
    'total-blocking-time',
    'cumulative-layout-shift',
    'speed-index',
    'interactive',
];

const INTERNAL_AUDITS = [
    'network-requests',
    'network-rtt',
    'network-server-latency',
    'main-thread-tasks',
    'metrics',
];

const SKIP_AUDITS = [
    'screenshot-thumbnails',
    'final-screenshot',
    'full-page-screenshot',
    'uses-optimized-images',
    'uses-webp-images',
    'uses-responsive-images',
    'efficient-animated-content',
    'offscreen-images',
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'uses-text-compression',
    'uses-rel-preconnect',
    'server-response-time',
    'redirects',
    'uses-http2',
    'uses-long-cache-ttl',
    'total-byte-weight',
    'dom-size',
    'critical-request-chains',
    'user-timings',
    'bootup-time',
    'mainthread-work-breakdown',
    'font-display',
    'resource-summary',
    'third-party-summary',
    'third-party-facades',
    'largest-contentful-paint-element',
    'lcp-lazy-loaded',
    'layout-shift-elements',
    'long-tasks',
    'no-unload-listeners',
    'uses-passive-event-listeners',
];

const RUN_MODE_COUNT = { single: 1, average: 3 };
const MAX_RUN_RETRIES = 2;

const WARMUP_SETTLE_MS = 8000;

// ─── Throttling presets ───────────────────────────────────────────────────────

const MOBILE_THROTTLING = {
    rttMs: 150,
    throughputKbps: 1638.4,
    requestLatencyMs: 562.5,
    downloadThroughputKbps: 1474.56,
    uploadThroughputKbps: 675,
    cpuSlowdownMultiplier: 4,
};

// Matches browser DevTools Lighthouse desktop:
// 40ms TCP RTT, 10240 kb/s throughput, 1x CPU (unthrottled)
const DESKTOP_THROTTLING = {
    rttMs: 40,
    throughputKbps: 10240,
    requestLatencyMs: 40,
    downloadThroughputKbps: 9216,
    uploadThroughputKbps: 9216,
    cpuSlowdownMultiplier: 1,
};

// ─── Lighthouse config builder ────────────────────────────────────────────────

function buildLighthouseConfig(strategy, visitMode) {
    const isMobile = strategy === 'mobile';
    return {
        output: 'json',
        logLevel: 'error',
        locale: 'en-US',
        channel: 'devtools',
        formFactor: strategy,

        // Match browser DevTools Lighthouse screen emulation exactly:
        // Mobile: 412x823 DPR 1.75, Desktop: 1350x940 DPR 1
        screenEmulation: isMobile
            ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, touch: true, disabled: false }
            : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, touch: false, disabled: false },

        throttlingMethod: 'simulate',
        throttling: isMobile ? MOBILE_THROTTLING : DESKTOP_THROTTLING,

        // Match "Using Chromium 146.0.0.0 with devtools" user agent from DevTools
        emulatedUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',

        onlyCategories: ['performance'],
        onlyAudits: [...REQUIRED_AUDITS, ...INTERNAL_AUDITS],
        skipAudits: SKIP_AUDITS,

        maxWaitForLoad: 60000,
        maxWaitForFcp: 30000,

        // Warm mode: match DevTools "single page session" —
        // don't clear storage or navigate to about:blank between passes
        disableStorageReset: visitMode === 'warm',
        skipAboutBlank: visitMode === 'warm',

        ...(visitMode === 'warm' && {
            pauseAfterFcpMs: 3000,
            pauseAfterLoadMs: 3000,
            networkQuietThresholdMs: 2000,
            cpuQuietThresholdMs: 3000,
        }),
    };
}

// ─── Audit averaging ──────────────────────────────────────────────────────────

function formatDisplayValue(value, numericUnit, referenceDisplay) {
    if (numericUnit === 'unitless') {
        return value < 0.005 ? value.toFixed(3) : parseFloat(value.toFixed(3)).toString();
    }
    if (referenceDisplay && referenceDisplay.includes(' s')) {
        return `${(value / 1000).toFixed(1)} s`;
    }
    return `${Math.round(value).toLocaleString()} ms`;
}

function averageAudits(lhrList) {
    if (lhrList.length === 1) return lhrList[0].audits;

    const base = lhrList[0].audits;
    const averaged = { ...base };

    for (const key of REQUIRED_AUDITS) {
        const values = lhrList
            .map(lhr => lhr.audits?.[key]?.numericValue)
            .filter(v => v != null);

        if (values.length === 0) continue;

        const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
        const ref = base[key];
        averaged[key] = {
            ...ref,
            numericValue: avg,
            displayValue: formatDisplayValue(avg, ref?.numericUnit, ref?.displayValue),
        };
    }

    return averaged;
}

// ─── Diagnostic logging ───────────────────────────────────────────────────────

function logDiag(lhr) {
    const audits = lhr.audits;
    const lcpEl = audits['largest-contentful-paint-element']?.details?.items?.[0];
    console.log(`[DIAG] FCP : ${audits['first-contentful-paint']?.numericValue?.toFixed(0)}ms`);
    console.log(`[DIAG] LCP : ${audits['largest-contentful-paint']?.numericValue?.toFixed(0)}ms`);
    console.log(`[DIAG] LCP element:`, JSON.stringify(lcpEl, null, 2));
    const networkItems = audits['network-requests']?.details?.items ?? [];
    const slow = [...networkItems]
        .map(r => ({ ms: Math.round(r.endTime - r.startTime), url: r.url?.substring(0, 100) }))
        .filter(r => r.ms > 1000)
        .sort((a, b) => b.ms - a.ms);
    console.log('[DIAG] Requests over 1s:');
    console.table(slow);
}

module.exports = {
    formatMs,
    REQUIRED_AUDITS,
    INTERNAL_AUDITS,
    SKIP_AUDITS,
    RUN_MODE_COUNT,
    MAX_RUN_RETRIES,
    WARMUP_SETTLE_MS,
    MOBILE_THROTTLING,
    DESKTOP_THROTTLING,
    buildLighthouseConfig,
    averageAudits,
    logDiag,
};
