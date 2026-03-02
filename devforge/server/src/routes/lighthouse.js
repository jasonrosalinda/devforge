import { Router } from "express";
import { runLighthouseAudit } from "../services/lighthouse.js";
import { AuditStore } from "../store/auditStore.js";

export const lighthouseRouter = Router();
const store = new AuditStore();

/**
 * POST /api/lighthouse/audit
 *
 * Run a Lighthouse audit against one or more URLs.
 *
 * Body:
 *  {
 *    "urls":     ["https://example.com"],          // required – array of URLs
 *    "strategy": "mobile" | "desktop",             // optional – defaults to "mobile"
 *    "categories": ["performance"]                  // optional – defaults to ["performance"]
 *  }
 *
 * Response: array of audit result objects that match the
 * PageSpeedMetrics shape used by the DevForge frontend.
 */
lighthouseRouter.post("/audit", async (req, res) => {
    const { urls, strategy = "mobile", categories = ["performance"] } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({
            error: "Please provide an array of URLs in the request body.",
        });
    }

    // Cap at 10 URLs per request to avoid overloading the server
    const targetUrls = urls.slice(0, 10);

    const results = [];

    for (const url of targetUrls) {
        try {
            console.log(`⏳ Auditing: ${url} (${strategy})`);
            const audit = await runLighthouseAudit(url, { strategy, categories });
            const saved = store.save(audit);
            results.push(saved);
            console.log(`✅ Completed: ${url}`);
        } catch (err) {
            console.error(`❌ Failed: ${url}`, err.message);
            results.push({
                url,
                strategy,
                error: err.message,
                timestamp: new Date().toISOString(),
            });
        }
    }

    res.json(results);
});

/**
 * GET /api/lighthouse/audit?url=<url>&strategy=<strategy>
 *
 * Quick single-URL audit via query params (convenient for testing).
 */
lighthouseRouter.get("/audit", async (req, res) => {
    const { url, strategy = "mobile" } = req.query;

    if (!url) {
        return res
            .status(400)
            .json({ error: "Please provide a ?url= query parameter." });
    }

    try {
        console.log(`⏳ Auditing: ${url} (${strategy})`);
        const audit = await runLighthouseAudit(url, {
            strategy,
            categories: ["performance"],
        });
        const saved = store.save(audit);
        console.log(`✅ Completed: ${url}`);
        res.json(saved);
    } catch (err) {
        console.error(`❌ Failed: ${url}`, err.message);
        res.status(500).json({ url, error: err.message });
    }
});

/**
 * GET /api/lighthouse/history
 *
 * Return the most recent audit results (last 50).
 */
lighthouseRouter.get("/history", (_req, res) => {
    res.json(store.getAll());
});

/**
 * GET /api/lighthouse/report/:id
 *
 * Return the full HTML Lighthouse report for a specific audit.
 */
lighthouseRouter.get("/report/:id", (req, res) => {
    const record = store.getById(req.params.id);

    if (!record) {
        return res.status(404).json({ error: "Audit not found." });
    }

    if (!record.htmlReport) {
        return res.status(404).json({ error: "No HTML report available for this audit." });
    }

    res.setHeader("Content-Type", "text/html");
    res.send(record.htmlReport);
});

/**
 * DELETE /api/lighthouse/history
 *
 * Clear all stored audit results.
 */
lighthouseRouter.delete("/history", (_req, res) => {
    store.clear();
    res.json({ message: "History cleared." });
});

/**
 * DELETE /api/lighthouse/history/:id
 *
 * Delete a specific audit result by ID.
 */
lighthouseRouter.delete("/history/:id", (req, res) => {
    const removed = store.removeById(req.params.id);
    if (!removed) {
        return res.status(404).json({ error: "Audit not found." });
    }
    res.json({ message: "Audit deleted.", id: req.params.id });
});
