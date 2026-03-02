# DevForge Lighthouse Server

A standalone server-side Lighthouse implementation that runs performance audits directly on your machine using a local headless Chrome instance — **no Google PageSpeed API key required**.

## Quick Start

```bash
cd server
npm install
npm run start
```

The server starts on **http://localhost:3100** by default.

## API Endpoints

### Health Check

```
GET /api/health
```

Returns server status and uptime.

---

### Run Audit (POST)

```
POST /api/lighthouse/audit
Content-Type: application/json

{
  "urls": ["https://example.com", "https://google.com"],
  "strategy": "mobile",          // "mobile" | "desktop" (default: "mobile")
  "categories": ["performance"]  // (default: ["performance"])
}
```

Runs Lighthouse against one or more URLs (max 10 per request). Each result includes:

- **`metrics`** — `speedIndex`, `largestContentfulPaint`, `cumulativeLayoutShift`, `totalBlockingTime`, `firstContentfulPaint` (same shape as the frontend's `PageSpeedMetrics`)
- **`scores`** — Category scores (e.g. performance: 100)
- **`additionalAudits`** — `interactive`, `serverResponseTime`, `totalByteWeight`, `domSize`, `maxPotentialFid`
- **`hasHtmlReport`** — `true` if a full Lighthouse HTML report is available

---

### Run Audit (GET)

```
GET /api/lighthouse/audit?url=https://example.com&strategy=desktop
```

Quick single-URL audit via query params (convenient for testing).

---

### View History

```
GET /api/lighthouse/history
```

Returns the most recent 50 audit results (newest first, without full HTML reports).

---

### View Full HTML Report

```
GET /api/lighthouse/report/:id
```

Returns the complete Lighthouse HTML report for a specific audit. Open this URL in a browser to see the interactive report.

---

### Clear History

```
DELETE /api/lighthouse/history
```

Clears all stored audit results.

---

### Delete Single Audit

```
DELETE /api/lighthouse/history/:id
```

Deletes a specific audit result by its ID.

## Architecture

```
server/
├── src/
│   ├── index.js                 # Express server entry point
│   ├── routes/
│   │   └── lighthouse.js        # REST API route handlers
│   ├── services/
│   │   └── lighthouse.js        # Core Lighthouse runner (chrome-launcher + lighthouse)
│   └── store/
│       └── auditStore.js        # In-memory audit result store (capped at 100 records)
├── package.json
└── .gitignore
```

## Notes

- Audits run sequentially per request to avoid Chrome resource contention
- The in-memory store is capped at 100 records with FIFO eviction
- Each audit launches a fresh headless Chrome instance and cleans it up after
- The server uses CORS so the DevForge frontend can call it directly
