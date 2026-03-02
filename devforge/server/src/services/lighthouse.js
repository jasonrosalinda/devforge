import lighthouse from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * Run a Lighthouse audit against a single URL using a locally-launched
 * headless Chrome instance.
 *
 * Returns a result object that is compatible with the DevForge
 * PageSpeedMetrics shape *plus* extra data (scores, categories, HTML report).
 *
 * @param {string} url – The URL to audit
 * @param {object} options
 * @param {"mobile"|"desktop"} options.strategy
 * @param {string[]} options.categories
 * @returns {Promise<object>}
 */
export async function runLighthouseAudit(url, options = {}) {
    const { strategy = "mobile", categories = ["performance"] } = options;

    // ── Create a temp user-data dir for Chrome ─────────────────────────
    const userDataDir = path.join(os.tmpdir(), `lh-chrome-${Date.now()}`);
    fs.mkdirSync(userDataDir, { recursive: true });

    // ── Launch headless Chrome ─────────────────────────────────────────
    // Use CHROME_PATH env var if set (e.g. on Render/Docker), otherwise auto-detect
    const launchOptions = {
        chromeFlags: [
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ],
        userDataDir,
    };

    if (process.env.CHROME_PATH) {
        launchOptions.chromePath = process.env.CHROME_PATH;
    }

    const chrome = await chromeLauncher.launch(launchOptions);

    try {
        // ── Lighthouse config ──────────────────────────────────────────
        const lhConfig = {
            extends: "lighthouse:default",
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
            },
        };

        const lhFlags = {
            port: chrome.port,
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

        // ── Extract metrics matching DevForge PageSpeedMetrics shape ──
        const metrics = {
            speedIndex: extractMetric(audits, "speed-index"),
            largestContentfulPaint: extractMetric(audits, "largest-contentful-paint"),
            cumulativeLayoutShift: extractMetric(audits, "cumulative-layout-shift"),
            totalBlockingTime: extractMetric(audits, "total-blocking-time"),
            firstContentfulPaint: extractMetric(audits, "first-contentful-paint"),
            runWarnings:
                lhr.runWarnings && lhr.runWarnings.length > 0
                    ? lhr.runWarnings.join(" | ")
                    : "",
        };

        // ── Category scores ────────────────────────────────────────────
        const scores = {};
        for (const [key, cat] of Object.entries(lhr.categories || {})) {
            scores[key] = {
                title: cat.title,
                score: cat.score !== null ? Math.round(cat.score * 100) : null,
            };
        }

        // ── Additional useful audits ───────────────────────────────────
        const additionalAudits = {
            interactive: extractMetric(audits, "interactive"),
            serverResponseTime: extractMetric(audits, "server-response-time"),
            totalByteWeight: extractMetric(audits, "total-byte-weight"),
            domSize: extractMetric(audits, "dom-size"),
            maxPotentialFid: extractMetric(audits, "max-potential-fid"),
        };

        // ── HTML Report ────────────────────────────────────────────────
        const htmlReport =
            Array.isArray(runnerResult.report)
                ? runnerResult.report[1] // index 1 is HTML when output: ["json", "html"]
                : null;

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
        await chrome.kill();
    }
}

/**
 * Extract a metric from Lighthouse audits into the DevForge
 * PageSpeedMetricDetails shape.
 */
function extractMetric(audits, auditId) {
    const audit = audits[auditId];
    if (!audit) {
        return { displayValue: "", numericValue: 0, numericUnit: "" };
    }
    return {
        displayValue: audit.displayValue || "",
        numericValue: audit.numericValue ?? 0,
        numericUnit: audit.numericUnit || "",
    };
}
