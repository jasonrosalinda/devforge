'use strict';

const { formatMs } = require('./lighthouseUtils.cjs');

// Stores captured API responses per origin for replay during pre-navigation
// Map<origin, Map<requestUrl, { status, headers, body }>>
const capturedApiResponses = new Map();

// ─── Warm-up: navigate + capture API responses ────────────────────────────────

async function cdpWarmUpAndCapture(url, chrome, { label = 'Warm-up' } = {}) {
    const CDP = (await import('chrome-remote-interface')).default;
    const origin = new URL(url).origin;
    let cdp;

    try {
        cdp = await CDP({ port: chrome.port });
        await cdp.Page.enable();
        await cdp.Network.enable();
        await cdp.Runtime.enable();

        // Intercept ALL responses — capture API/JSON ones for replay
        await cdp.Fetch.enable({ patterns: [{ urlPattern: '*', requestStage: 'Response' }] });

        const captured = new Map();

        cdp.Fetch.on('requestPaused', async (event) => {
            try {
                const { requestId, request, responseStatusCode, responseHeaders } = event;

                const isJson = responseHeaders?.find(h =>
                    h.name.toLowerCase() === 'content-type' && h.value.includes('application/json')
                );
                const isApi = request.url.includes('/api/');

                if ((isApi || isJson) && responseStatusCode >= 200 && responseStatusCode < 300) {
                    try {
                        const body = await cdp.Fetch.getResponseBody({ requestId });
                        captured.set(request.url, {
                            status: responseStatusCode,
                            headers: responseHeaders ?? [],
                            body: body.body,
                        });
                        console.log(`[Lighthouse][warm] ${label}: captured ${request.url.substring(0, 80)}`);
                    } catch { /* body unavailable */ }
                }

                await cdp.Fetch.continueRequest({ requestId });
            } catch { /* ignore */ }
        });

        console.log(`[Lighthouse][warm] ${label}: navigating to ${url}...`);
        await Promise.all([
            cdp.Page.loadEventFired(),
            cdp.Page.navigate({ url }),
        ]);

        console.log(`[Lighthouse][warm] ${label}: load event fired — waiting for network quiet...`);
        await waitForNetworkQuiet(cdp);
        console.log(`[Lighthouse][warm] ${label}: network quiet.`);

        await waitForCpuQuiet(cdp);
        console.log(`[Lighthouse][warm] ${label}: CPU quiet.`);

        // Store captured responses
        if (captured.size > 0) {
            const existing = capturedApiResponses.get(origin) ?? new Map();
            for (const [k, v] of captured) existing.set(k, v);
            capturedApiResponses.set(origin, existing);
            console.log(`[Lighthouse][warm] ${label}: captured ${captured.size} API response(s) — ${existing.size} total for ${origin}`);
        } else {
            console.warn(`[Lighthouse][warm] ${label}: no API responses captured`);
        }

        console.log(`[Lighthouse][warm] ${label}: complete.`);

    } finally {
        if (cdp) try { await cdp.close(); } catch { /* ignore */ }
    }
}

// ─── Pre-navigation: replay captured API + capture LCP ───────────────────────

async function cdpPreNavigateAndCaptureLcp(url, chrome, { label = 'Pre-navigation' } = {}) {
    const CDP = (await import('chrome-remote-interface')).default;
    const origin = new URL(url).origin;
    const cached = capturedApiResponses.get(origin);
    let cdp;

    try {
        cdp = await CDP({ port: chrome.port });
        await cdp.Page.enable();
        await cdp.Network.enable();
        await cdp.Runtime.enable();

        // Inject LCP observer BEFORE navigation
        const { identifier: scriptId } = await cdp.Page.addScriptToEvaluateOnNewDocument({
            source: `
                window.__lcpValue   = null;
                window.__lcpElement = null;
                try {
                    const observer = new PerformanceObserver((list) => {
                        const entries = list.getEntries();
                        if (entries.length > 0) {
                            const last = entries[entries.length - 1];
                            window.__lcpValue   = last.startTime;
                            window.__lcpElement = last.element
                                ? {
                                    tag:   last.element.tagName,
                                    id:    last.element.id,
                                    class: last.element.className?.toString?.().substring(0, 80),
                                    src:   last.element.src ?? last.element.currentSrc ?? null,
                                    text:  last.element.innerText?.substring(0, 50) ?? null,
                                  }
                                : null;
                        }
                    });
                    observer.observe({ type: 'largest-contentful-paint', buffered: true });
                } catch (e) {
                    window.__lcpError = e.message;
                }
            `,
        });
        console.log(`[Lighthouse][warm] ${label}: LCP observer injected.`);

        // Replay captured API responses so Blazor gets instant responses
        // instead of waiting for real VPN API calls (~10s each)
        if (cached && cached.size > 0) {
            await cdp.Fetch.enable({ patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

            cdp.Fetch.on('requestPaused', async (event) => {
                const { requestId, request } = event;
                const hit = cached.get(request.url);
                if (hit) {
                    try {
                        await cdp.Fetch.fulfillRequest({
                            requestId,
                            responseCode: hit.status,
                            responseHeaders: hit.headers,
                            body: hit.body,
                        });
                        return;
                    } catch { /* fall through */ }
                }
                try { await cdp.Fetch.continueRequest({ requestId }); } catch { /* ignore */ }
            });

            console.log(`[Lighthouse][warm] ${label}: replaying ${cached.size} cached API response(s).`);
        } else {
            console.warn(`[Lighthouse][warm] ${label}: no cached API responses — Blazor will make real VPN calls.`);
        }

        console.log(`[Lighthouse][warm] ${label}: navigating to ${url}...`);
        await Promise.all([
            cdp.Page.loadEventFired(),
            cdp.Page.navigate({ url }),
        ]);

        console.log(`[Lighthouse][warm] ${label}: load event fired — waiting for network quiet...`);
        await waitForNetworkQuiet(cdp);
        console.log(`[Lighthouse][warm] ${label}: network quiet.`);

        await waitForCpuQuiet(cdp);
        console.log(`[Lighthouse][warm] ${label}: CPU quiet.`);

        // Read LCP
        const result = await cdp.Runtime.evaluate({
            expression: `({ lcp: window.__lcpValue, element: window.__lcpElement, error: window.__lcpError })`,
            returnByValue: true,
        });
        const value = result?.result?.value;
        const lcpMs = value?.lcp ?? null;

        try { await cdp.Page.removeScriptToEvaluateOnNewDocument({ identifier: scriptId }); }
        catch { /* ignore */ }

        if (lcpMs != null) {
            console.log(`[Lighthouse][warm] ${label}: real LCP = ${Math.round(lcpMs)}ms — element: ${JSON.stringify(value?.element)}`);
        } else {
            console.warn(`[Lighthouse][warm] ${label}: LCP not captured — ${value?.error ?? 'no entries'}`);
        }

        console.log(`[Lighthouse][warm] ${label}: complete.`);
        return { lcpMs };

    } finally {
        if (cdp) try { await cdp.close(); } catch { /* ignore */ }
    }
}

// ─── Shared quiet helpers ─────────────────────────────────────────────────────

async function waitForNetworkQuiet(cdp) {
    return new Promise((resolve) => {
        let timer;
        const activeRequests = new Set();
        const resetTimer = () => {
            if (activeRequests.size <= 2) {
                clearTimeout(timer);
                timer = setTimeout(resolve, 500);
            }
        };
        cdp.Network.on('requestWillBeSent', ({ requestId }) => { activeRequests.add(requestId); clearTimeout(timer); });
        cdp.Network.on('loadingFinished', ({ requestId }) => { activeRequests.delete(requestId); resetTimer(); });
        cdp.Network.on('loadingFailed', ({ requestId }) => { activeRequests.delete(requestId); resetTimer(); });
        resetTimer();
        setTimeout(resolve, 45000);
    });
}

async function waitForCpuQuiet(cdp) {
    return new Promise((resolve) => {
        const fallback = setTimeout(resolve, 25000);
        cdp.Runtime.evaluate({
            expression: `
                new Promise((resolve) => {
                    let idleTimer = setTimeout(resolve, 5000);
                    const observer = new PerformanceObserver(() => {
                        clearTimeout(idleTimer);
                        idleTimer = setTimeout(resolve, 5000);
                    });
                    try { observer.observe({ type: 'longtask', buffered: false }); }
                    catch (e) { resolve(); }
                    setTimeout(resolve, 20000);
                })
            `,
            awaitPromise: true,
            returnByValue: true,
        }).then(() => { clearTimeout(fallback); resolve(); }).catch(() => resolve());
    });
}

function clearCapturedApiResponses() {
    capturedApiResponses.clear();
}

module.exports = {
    cdpWarmUpAndCapture,
    cdpPreNavigateAndCaptureLcp,
    clearCapturedApiResponses,
};