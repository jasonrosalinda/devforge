import lighthouse from "lighthouse";
import puppeteer, { executablePath } from 'puppeteer';  // ← add puppeteer default import

/**
 * Run a Lighthouse audit using Puppeteer as the browser launcher.
 */
export async function runLighthouseAudit(url, options = {}) {
    const { strategy = "mobile", categories = ["performance"] } = options;

    try {
        const response = await fetch(url, { method: 'HEAD' });
        console.log("Network Check:", response.status);
    } catch (e) {
        return {
            url,
            strategy,
            timestamp: new Date().toISOString(),
            error: "The server cannot reach this URL at all!",
        };
    }

    // ── Launch Puppeteer ───────────────────────────────────────────────
    const browser = await puppeteer.launch({
        executablePath: executablePath(),
        headless: true, // or 'new'
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu', // Critical for Docker stability
            '--disable-software-rasterizer',
            '--remote-debugging-port=9222',
        ]
    });

    try {
        // Get the port that Puppeteer is using for remote debugging
        const endpoint = browser.wsEndpoint();
        const endpointURL = new URL(endpoint);
        const port = parseInt(endpointURL.port);

        // ── Lighthouse config ──────────────────────────────────────────
        const lhConfig = {
            extends: "lighthouse:default",
            port: (new URL(browser.wsEndpoint())).port,
            output: 'json',
            logLevel: 'info',
            settings: {
                formFactor: strategy === "desktop" ? "desktop" : "mobile",
                screenEmulation:
                    strategy === "desktop"
                        ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
                        : undefined,
                throttling:
                    strategy === "desktop"
                        ? { cpuSlowdownMultiplier: 1, downloadThroughputKbps: 0, uploadThroughputKbps: 0, rttMs: 0, throughputKbps: 0, requestLatencyMs: 0 }
                        : undefined,
                onlyCategories: categories,
                maxWaitForFcp: 30000,
                maxWaitForLoad: 45000,
            },
        };

        const lhFlags = {
            port: port, // Connect Lighthouse to the Puppeteer port
            output: ["json", "html"],
            logLevel: "error",
        };

        // ── Run Lighthouse ─────────────────────────────────────────────
        const runnerResult = await lighthouse(url, lhFlags, lhConfig);

        if (!runnerResult || !runnerResult.lhr) {
            throw new Error("Lighthouse returned no results.");
        }

        const { lhr } = runnerResult;
        const audits = lhr.audits || {};

        // ── Extract metrics (Keep your existing extract logic) ──────────
        const metrics = {
            speedIndex: extractMetric(audits, "speed-index"),
            largestContentfulPaint: extractMetric(audits, "largest-contentful-paint"),
            cumulativeLayoutShift: extractMetric(audits, "cumulative-layout-shift"),
            totalBlockingTime: extractMetric(audits, "total-blocking-time"),
            firstContentfulPaint: extractMetric(audits, "first-contentful-paint"),
            runWarnings: lhr.runWarnings?.length > 0 ? lhr.runWarnings.join(" | ") : "",
        };

        const scores = {};
        for (const [key, cat] of Object.entries(lhr.categories || {})) {
            scores[key] = {
                title: cat.title,
                score: cat.score !== null ? Math.round(cat.score * 100) : null,
            };
        }

        const additionalAudits = {
            interactive: extractMetric(audits, "interactive"),
            serverResponseTime: extractMetric(audits, "server-response-time"),
            totalByteWeight: extractMetric(audits, "total-byte-weight"),
            domSize: extractMetric(audits, "dom-size"),
            maxPotentialFid: extractMetric(audits, "max-potential-fid"),
        };

        const htmlReport = Array.isArray(runnerResult.report) ? runnerResult.report[1] : null;

        return {
            url,
            strategy,
            timestamp: new Date().toISOString(),
            metrics,
            scores,
            additionalAudits,
            fetchTime: lhr.fetchTime,
            finalUrl: lhr.finalDisplayedUrl || lhr.finalUrl,
            lighthouseVersion: lhr.lighthouseVersion,
            userAgent: lhr.userAgent,
            htmlReport,
        };
    } finally {
        // Ensure browser is closed even if audit fails
        await browser.close();
    }
}

function extractMetric(audits, auditId) {
    const audit = audits[auditId];
    if (!audit) return { displayValue: "", numericValue: 0, numericUnit: "" };
    return {
        displayValue: audit.displayValue || "",
        numericValue: audit.numericValue ?? 0,
        numericUnit: audit.numericUnit || "",
    };
}