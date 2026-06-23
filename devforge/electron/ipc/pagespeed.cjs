'use strict';

const { ipcMain, app } = require('electron');

const {
    getOrLaunchChrome,
    killChrome,
    killAllChromeAndWait,
    getWarmChromePort,
    waitForPort,
    clearLighthouseProfile,
} = require('../utils/browserManager.cjs');

const { cdpWarmUpAndCapture,
    cdpPreNavigateAndCaptureLcp,
    clearCapturedApiResponses, } = require('../utils/cdpUtils.cjs');

const {
    formatMs,
    RUN_MODE_COUNT,
    MAX_RUN_RETRIES,
    WARMUP_SETTLE_MS,
    buildLighthouseConfig,
    averageAudits,
    logDiag,
} = require('../utils/lighthouseUtils.cjs');

// ─── Warm state tracking ──────────────────────────────────────────────────────

const wasmWarmedOrigins = new Set();
const apiWarmedUrls = new Set();

// ─── Run with retry ───────────────────────────────────────────────────────────

async function runWithRetry(lighthouse, url, lighthouseConfig, visitMode, label) {
    const maxAttempts = MAX_RUN_RETRIES + 1;
    let lastError;
    let preNavigated = false;
    let realLcpMs = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1) {
                console.warn(`[Lighthouse][${visitMode}] ${label} attempt ${attempt - 1} failed — retrying (${attempt}/${maxAttempts})...`);
                if (visitMode === 'cold' || !preNavigated) {
                    killChrome(visitMode);
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } else {
                    // Warm mode — keep browser alive so WASM stays compiled
                    console.log(`[Lighthouse][warm] Keeping browser alive for retry...`);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            const chrome = await getOrLaunchChrome(visitMode);

            if (visitMode === 'warm' && !preNavigated) {
                // Pre-navigate with LCP capture.
                // PerformanceObserver is injected via addScriptToEvaluateOnNewDocument
                // BEFORE Page.navigate() — catches LCP from frame 1, same timing
                // as browser DevTools Lighthouse "single page session".
                // Network + CPU quiet detection matches DevTools wait conditions.
                const { lcpMs } = await cdpPreNavigateAndCaptureLcp(url, chrome, {
                    label: 'Pre-navigation',
                });
                preNavigated = true;
                realLcpMs = lcpMs;
            }

            const result = await lighthouse(url, {
                ...lighthouseConfig,
                port: chrome.port,
            });

            if (!result) throw new Error('Lighthouse failed to produce a result.');
            if (result.lhr.runtimeError) throw new Error(result.lhr.runtimeError.message);

            // Patch LCP with the real value captured during pre-navigation.
            // Lighthouse's own LCP is inflated because it navigates cold —
            // Blazor has to recompile WASM and re-call APIs on every navigation.
            // The PerformanceObserver value from the pre-navigation is the
            // ground truth — same source as browser DevTools Lighthouse.
            if (visitMode === 'warm' && realLcpMs != null) {
                const lighthouseLcp = result.lhr.audits['largest-contentful-paint']?.numericValue ?? 0;
                console.log(`[Lighthouse][warm] LCP patch: Lighthouse=${Math.round(lighthouseLcp)}ms → Real=${Math.round(realLcpMs)}ms`);
                result.lhr.audits['largest-contentful-paint'] = {
                    ...result.lhr.audits['largest-contentful-paint'],
                    numericValue: realLcpMs,
                    displayValue: `${(realLcpMs / 1000).toFixed(1)} s`,
                };
            } else if (visitMode === 'warm' && realLcpMs == null) {
                console.warn(`[Lighthouse][warm] No real LCP captured — Lighthouse value likely inflated`);
            }

            if (attempt > 1) console.log(`[Lighthouse][${visitMode}] ${label} succeeded on attempt ${attempt}.`);
            logDiag(result.lhr);
            return result.lhr;

        } catch (err) {
            lastError = err;
            console.warn(`[Lighthouse][${visitMode}] ${label} attempt ${attempt} failed: ${err.message}`);

            if (visitMode === 'cold') {
                killChrome(visitMode);
            } else {
                // Only restart warm browser if it actually crashed
                try {
                    const warmPort = getWarmChromePort();
                    if (warmPort) await waitForPort(warmPort, { retries: 3, intervalMs: 200 });
                } catch {
                    console.warn(`[Lighthouse][warm] Browser crashed — restarting...`);
                    killChrome(visitMode);
                    preNavigated = false;
                    realLcpMs = null;
                }
            }
        }
    }

    throw new Error(lastError?.message);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

module.exports = function registerPagespeedHandlers(_win) {

    ipcMain.handle('run-lighthouse', async (_event, { url, strategy, visitMode = 'cold', runMode = 'single' }) => {
        if (typeof performance !== 'undefined' && performance.clearMarks) {
            performance.clearMarks();
            performance.clearMeasures();
        }

        const numRuns = RUN_MODE_COUNT[runMode] ?? 1;
        console.log(`[Lighthouse] Mode: ${visitMode} | Run mode: ${runMode} (${numRuns} run(s)) | URL: ${url} | Strategy: ${strategy}`);

        try {
            const lighthouse = (await import('lighthouse')).default;
            const { parseToPageSpeedInsightResult, buildErrorPageSpeedInsightResult } =
                await import('../utils/pageSpeedAuditParser.js');

            const chrome = await getOrLaunchChrome(visitMode);
            const lighthouseConfig = buildLighthouseConfig(strategy, visitMode);

            // ── Warm-up ───────────────────────────────────────────────────────
            if (visitMode === 'warm') {
                const origin = new URL(url).origin;
                const wasmIsWarm = wasmWarmedOrigins.has(origin);
                const apiIsWarm = apiWarmedUrls.has(url);

                if (!apiIsWarm) {
                    console.log(`[Lighthouse][warm] Warming up ${url}...`);
                    const warmupStart = Date.now();
                    try {
                        // Capture API responses during warm-up for replay during pre-navigation.
                        // Since responses are no-store, we capture them via CDP and serve them
                        // ourselves — bypasses VPN latency on subsequent runs.
                        await cdpWarmUpAndCapture(url, chrome, { label: 'Warm-up' });
                        wasmWarmedOrigins.add(origin);
                        apiWarmedUrls.add(url);

                        const settleMs = wasmIsWarm ? 3000 : WARMUP_SETTLE_MS;
                        console.log(`[Lighthouse][warm] Warm-up completed in ${formatMs(Date.now() - warmupStart)} — settling for ${formatMs(settleMs)}...`);
                        await new Promise(resolve => setTimeout(resolve, settleMs));
                    } catch (err) {
                        console.warn(`[Lighthouse][warm] Warm-up failed (${err.message}) — proceeding without warm cache.`);
                    }
                } else {
                    console.log(`[Lighthouse][warm] ${url} already warm — skipping warm-up.`);
                }
            }

            if (visitMode === 'cold') killChrome('cold');

            // ── Measured runs ─────────────────────────────────────────────────
            const lhrList = [];
            const auditStart = Date.now();

            for (let run = 1; run <= numRuns; run++) {
                const runLabel = `Run ${run}/${numRuns}`;
                console.log(`[Lighthouse][${visitMode}][${runMode}] ${runLabel} — ${url}`);

                const runStart = Date.now();
                try {
                    const lhr = await runWithRetry(lighthouse, url, lighthouseConfig, visitMode, runLabel);
                    lhrList.push(lhr);
                    console.log(`[Lighthouse][${visitMode}][${runMode}] ${runLabel} completed in ${formatMs(Date.now() - runStart)}`);
                } catch (err) {
                    console.warn(`[Lighthouse][${visitMode}][${runMode}] ${runLabel} skipped after all retries in ${formatMs(Date.now() - runStart)}: ${err.message}`);
                }

                if (visitMode === 'cold') killChrome('cold');
                if (run < numRuns) await new Promise(resolve => setTimeout(resolve, 1000));
            }

            if (lhrList.length === 0) {
                throw new Error(`All ${numRuns} run(s) failed for ${url}. No results to return.`);
            }

            console.log(`[Lighthouse][${visitMode}][${runMode}] Done — ${lhrList.length}/${numRuns} run(s) succeeded in ${formatMs(Date.now() - auditStart)} total for ${url}`);

            const lastLhr = lhrList[lhrList.length - 1];
            const averagedAudits = averageAudits(lhrList);

            const result = parseToPageSpeedInsightResult(
                url,
                averagedAudits,
                lhrList[0].runWarnings?.[0],
                {
                    performanceScore: Math.round((lastLhr.categories?.performance?.score ?? 0) * 100),
                    lighthouseVersion: lastLhr.lighthouseVersion,
                    fetchTime: lastLhr.fetchTime,
                }
            );

            // averageAudits() strips details — re-parse last LHR to get opportunities with details
            const lastResult = parseToPageSpeedInsightResult(url, lastLhr.audits);
            result.opportunities = lastResult.opportunities;

            // Attach individual run results as history when in accuracy mode
            if (lhrList.length > 1) {
                result.runHistory = lhrList.map((lhr) =>
                    parseToPageSpeedInsightResult(url, lhr.audits, lhr.runWarnings?.[0], {
                        fetchTime: lhr.fetchTime,
                    })
                );
            }

            return result;

        } catch (err) {
            console.error(`[Lighthouse][${visitMode}] Error:`, err.message);
            killChrome(visitMode);
            const { buildErrorPageSpeedInsightResult } = await import('../utils/pageSpeedAuditParser.js');
            return buildErrorPageSpeedInsightResult(url, err.message);
        }
    });

    ipcMain.handle('clear-lighthouse-cache', async () => {
        await killAllChromeAndWait();
        wasmWarmedOrigins.clear();
        apiWarmedUrls.clear();
        clearCapturedApiResponses();       // ← add this
        return clearLighthouseProfile();
    });

    app.on('before-quit', () => {
        killChrome('cold');
        killChrome('warm');
    });
};
