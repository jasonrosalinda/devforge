import express from "express";
import cors from "cors";
import { lighthouseRouter } from "./routes/lighthouse.js";

const app = express();
const PORT = process.env.PORT || 3100;

// ── Middleware ──────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Health check ───────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// ── Routes ─────────────────────────────────────────────────────────────
app.use("/api/lighthouse", lighthouseRouter);

// ── Start ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🚀 DevForge Lighthouse Server running on http://localhost:${PORT}`);
    console.log(`   Health:    GET  /api/health`);
    console.log(`   Audit:     POST /api/lighthouse/audit`);
    console.log(`   History:   GET  /api/lighthouse/history`);
    console.log(`   Report:    GET  /api/lighthouse/report/:id\n`);
});
