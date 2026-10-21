# devForge

Developer toolkit built with Electron, React, and TypeScript. Bundles Azure App Service / Container Apps monitoring, PageSpeed auditing, unused-asset scanning, release runbook prep and everyday developer utilities into a single cross-platform desktop app.

---

## Pages

Every page opens as its own tab from the sidebar or the Home cards. The sidebar groups them as below. The page list lives in [src/routes/page-routes.tsx](src/routes/page-routes.tsx) and the Toolbox tools in [src/components/toolbox/toolbox-registry.ts](src/components/toolbox/toolbox-registry.ts). **When you add, remove or change a page, update this section in the same PR.**

### Home

**Use it to** find and open a tool. It shows a card for every page, in sidebar order, and the sidebar search filters them by title, description and keywords.

### Monitoring

#### App Health Check

**Use it to** see how Azure apps behaved over a time window, and to explain an outage or a spike: during an incident, for a daily check, when a tray alert fires, or after a release to compare before and after.

- Pick one or more apps and a From / To range (defaults to today 00:00 → now) at 1m–6h granularity. You can turn on **Auto reload** to keep the end at "now".
- Each app gets a card with a status (healthy / warning / critical). **Blocks** choose what the card shows: Remarks, CPU, Memory, Database, Users, Page Load, Performance, Exceptions, Instances, UptimeRobot, SNAT Ports, Restarts, Crash Monitoring, Anomaly Detection, and Frontend / API.
- **Release markers:** every time chart on the card draws a dashed line where a release reached production (FE darker, API fainter; the CPU / Memory chart labels each one with its SGT time), so a change in CPU, restarts or errors reads as before vs after the release. The **Frontend** and **API** section headers each show that site's **Last release**, even when it falls outside the range (30-day look-back); hover it for the build, commit and who released. The card header shows it instead for a site whose section is not on screen: the card is collapsed or the block is hidden. Releases come from the Activity Log (slot swaps, including manual ones) and the Kudu deployment history (pipeline deploys and swaps); Container Apps use their revisions.
- **Anomaly Detection** flags correlated spikes across CPU, memory, DB CPU and DB memory (plus FE/API error rates when App Insights is available).
- **Copy for Teams** puts the status header, chart image and metrics table on the clipboard in one paste.
- **AI report** writes an AI-ready Markdown incident report for the range to `~/.claude/agents/incident-reports/` and opens it.
- **RCA** opens a downtime root-cause analysis: add your investigation notes and Claude drafts the report. You can copy it for Teams or save it as Markdown, PDF or Word.
- **Needs:** `az login`, and apps configured in **Settings → Azure**. Optional: an App Insights ID, a database, and the API app per entry. UptimeRobot needs a key in **Settings → API Keys**. Release markers need Reader on the app's resource group (the header shows "n/a" without it). RCA needs the [Claude CLI](https://docs.claude.com/en/docs/claude-code) on PATH. Desktop app only.

#### Ask Telemetry

**Use it to** answer a question about an app's Application Insights that App Health Check has no block for, without writing KQL or opening the Azure Portal. For example: "which endpoints got slower today?", "top exception types on the API this week" or "failed dependency calls by target".

- Pick an app, **Frontend** or **API**, and a range (1h / 24h / 7d / custom), then type the question (Ctrl+Enter). Starter questions and your recent ones sit under the box.
- Claude writes one KQL query from the app's real table schema. devForge runs it read-only and shows the query, a one-line explanation, a chart (a line over time, split by category up to 8 lines, or bars for a breakdown) and the full table.
- If App Insights rejects the query, Claude gets the error and fixes it once by itself. The query shows a **repaired** badge when that happens.
- The query stays editable. **Run** (Ctrl+Enter) runs your edit directly, with no Claude call. Results are capped at 5,000 rows.
- **Save** keeps a query in the library on the right. Running a saved query reuses its KQL on the current range, so it costs no Claude call. **Copy rows** (paste into Excel or Teams) and **Copy chart** (image) share the answer.
- **Privacy:** only the question, the table and column names, and (on a repair) the query error go to Claude. Telemetry rows never leave the machine. The query is written by Claude through your Claude Code login, never the metered API, so there is no per-question charge. Claude runs without tools or the coding-agent prompt, so a question uses about 2k tokens of your plan; each answer shows the tokens it used (hover for the API-equivalent figure).
- **Needs:** `az login`, the app in **Settings → Azure** (the App Insights ID is looked up when not set), and the Claude CLI on PATH. Desktop app only.

### Web quality

#### PageSpeed

**Use it to** measure a site's Lighthouse performance, or to prove a release made it faster or slower.

- Add https URLs; each is audited on **Desktop** and **Mobile** through the PageSpeed Insights API: SI, LCP, CLS, TBT and FCP, plus opportunities and diagnostics.
- There are three modes. **Single** takes one snapshot. **Comparison** shows before → after with % change. **Accuracy** does 1–10 runs per URL, averaged or median.
- **Copy for Teams** (Excel-style table), **Copy as Image** and **Claude Analysis** (a short findings / assessment summary).
- A **Fix brief** writes a Markdown task file into a repo folder for an AI coding agent. **History** keeps up to 25 saved runs.
- **Needs:** a Google PageSpeed API key in **Settings → API Keys**. Claude Analysis needs the Claude CLI. Full guide: [docs/pagespeed-insights.md](docs/pagespeed-insights.md).

#### Unused Assets

**Use it to** clean up a front-end codebase by finding CSS classes / ids and JS functions nothing references.

- Pick a project folder and scan. The results come as two searchable lists, unused CSS and unused JS, with a code view per item.
- An AI **review** checks each item and gives a verdict. If you stop it, the items already checked keep their verdict.
- Download a Markdown report of a scan. Past scans are kept in history.
- **Needs:** the desktop app. The AI review also needs the Claude CLI.

### Release

#### Release Pilot

**Use it to** prepare and run a deployment from its Confluence runbook without switching between pages.

- Paste the **Deployment Runbook** URL, and optionally the **Release Plan** URL (the release goals are taken from it). It loads the activity table and every screenshot, including ones inside expand drawers.
- Copy a Teams-ready summary, either as text only (always fits) or with full-resolution screenshots. You can also copy any single screenshot.
- **Export** every section as one full-quality HTML file.
- **Needs:** a Confluence base URL, account email and API token in **Settings → Atlassian**.

#### Release Runbook

**Use it to** write or update a Confluence deployment runbook without hand-editing its tables: start a new one from a template, or move a whole deployment to a new start time.

- Start one of three ways. **Edit a runbook** opens a page URL (past URLs are remembered). **New from template** loads a template or an earlier runbook, resets the statuses to TODO, empties the logbooks and drops the "[Template] " prefix. **New blank runbook** gives Pre-Prod, Prod, Post-Prod and Rollback sections with the standard columns.
- Edit rows: insert, duplicate, move, delete, and merge with or split from the row above. Pick PICs through Confluence user search. Edit a cell as rich text, with pasted screenshots and task lists. Planned start and end are recalculated from Time and Duration, and an unreadable duration is flagged.
- **Reschedule:** set the deployment start date and time (SGT) and the activity it starts with. Every date, time, planned time, logbook check time and the date in the title move by the same offset.
- **Review & save** shows a diff first; nothing is written until you confirm. **Create page…** and **Save as template…** create a new page and copy the screenshots across.
- **Safe by design:** only tables with both a Time and an Activity column are treated as runbook tables, and a cell nobody touched is saved back unchanged. A table with merged cells is read-only ("Edit it in Confluence"). If someone else saved the page in the meantime, devForge shows who and when, never overwrites, and lists your edits that would be lost on reload.
- **Needs:** a valid Confluence URL, email and API token in **Settings → Atlassian**, and edit permission on the page or space (a 403 means the account or token is not allowed).

### Utilities

#### Translation

**Use it to** look up, add or edit localization keys across EN, ID and VN.

- A searchable, sortable table of keys and their values. You can add, edit and delete entries.
- Import and export as `.sql`, and copy the table as an image.

#### Toolbox

Offline utilities, each on its own page. Nothing you paste leaves the machine.

| Tool | Use it to |
|------|-----------|
| **DateTime Converter** | Convert a time between local, UTC, other time zones, ISO 8601 and Unix timestamps — e.g. to read a log timestamp in SGT. |
| **JWT Decoder** | Decode a token and read its claims, with expiry and issue times shown in local time and UTC. |
| **Regex Tester** | Try a pattern against sample text, with warnings where .NET's regex engine behaves differently. |
| **Cron Explainer & Creator** | Explain an existing cron / NCRONTAB expression, or build one, and preview its next runs. |
| **JSON / YAML / XML** | Format, validate and convert config between the three formats. |
| **Encoders** | Base64, URL and HTML encode / decode, hashes (SHA) and UUIDs. |
| **Text Diff** | Compare two blocks of text line by line. |
| **Image Converter** | Convert images between PNG, JPEG, WebP, ICO and SVG (traced or embedded), e.g. to make a favicon. |

---

## Background monitor (system tray)

**Use it to** get a desktop alert when a watched Azure app degrades, without keeping the App Health Check page open. Turn it on in **Settings → Background monitor**.

- It checks the watched apps every minute over the last 6h at 1m buckets. It fetches only what the alerts need, in a few batched Azure calls.
- It alerts when:
  - the status gets worse;
  - 2 or more of CPU, memory, DB CPU and DB memory spike together;
  - 5xx errors go above 5% of requests;
  - UptimeRobot reports downtime;
  - Azure is unreachable for 3 checks in a row (and again when it recovers).
- Each alert carries its numbers (peak values, time, averages). The Settings tab lists the exact thresholds.
- Clicking an alert opens App Health Check reloaded to today. With the monitor on, closing the window keeps devForge in the tray; quit from the tray menu.

Implementation: [electron/ipc/background-monitor.cjs](electron/ipc/background-monitor.cjs), [src/monitor/](src/monitor/)

---

## App shell

- **Sidebar**, grouped Monitoring / Web quality / Release / Utilities, with search.
- **Browser-style tabs.** Open tabs are restored on the next launch and stay mounted, so switching back keeps your inputs and results. Shortcuts: **Ctrl+Tab** / **Ctrl+Shift+Tab** to cycle, **Ctrl+W** to close, **Ctrl+1–8** to jump to a tab and **Ctrl+9** for the last one.
- **Settings**, **Release notes** and **auto-update** are covered in their sections below.

---

## Documentation

| Guide | Contents |
|-------|----------|
| [PageSpeed Insights](docs/pagespeed-insights.md) | Work instruction: API key setup, single / comparison / accuracy runs, reading results, Copy for Teams, Claude Analysis, fix briefs, history, troubleshooting. |

---

## Tech Stack

- **Runtime** — Electron 35, Node 20+
- **Frontend** — React 19, TypeScript, Vite (rolldown-vite), Tailwind CSS
- **UI** — Radix UI primitives, shadcn-style components, sonner toasts, recharts, `@tanstack/react-table`
- **Azure** — `@azure/identity`, `@azure/monitor-query` (App Service + Container Apps, Log Analytics)
- **Confluence** — runbook fetch via persisted browser session + Confluence Cloud REST; Release Runbook reads and writes the storage format (REST v1) and edits only the runbook tables
- **Markdown / capture** — `marked`, `html2canvas`
- **AI** — the [Claude CLI](https://docs.claude.com/en/docs/claude-code) (`claude -p`, your existing login) for RCA, PageSpeed analysis, the Unused Assets review and Ask Telemetry. Never the metered API. Calls that need no tools run lean (no tools, no plugins, hooks or MCP connectors, a short system prompt of their own), about 2k tokens of your plan instead of 50–70k
- **Testing** — Vitest + happy-dom
- **Auto-update** — `electron-updater` via GitHub Releases
- **Release automation** — GitHub Actions (`deploy.yml`): conventional commits → version tag → release build
- **Packaging** — `electron-builder` (NSIS / DMG / AppImage / deb)

---

## Getting Started

### Prerequisites

- Node.js 20 or newer
- npm 10+
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli), signed in with `az login` — for App Health Check and the background monitor
- Optional: [Claude CLI](https://docs.claude.com/en/docs/claude-code) on PATH — for RCA, PageSpeed Claude Analysis, the Unused Assets review and Ask Telemetry

### Install

```bash
git clone https://github.com/jasonrosalinda/devforge.git
cd devforge
npm install
```

### Run in development

Two flavors:

```bash
npm run dev                  # Vite dev server only (browser preview)
npm run electron:dev:live    # Vite + Electron with HMR
```

`electron:dev:live` runs Vite at `http://localhost:5173` and launches Electron with hot reload — recommended for active development.

---

## Build & Package

```bash
npm run electron:build    # Build production app + installer for current OS
npm run electron:pack     # Build without creating installer (unpacked dir)
npm run electron:release  # Build + publish to GitHub Releases (CI use)
```

Output lands in `release/`.

Targets configured in [electron-builder.json5](electron-builder.json5):
- **Windows**: NSIS installer + portable exe
- **macOS**: DMG + ZIP
- **Linux**: AppImage + deb

---

## Release Workflow

Releases are automated from **conventional commits** by the repo-root workflow [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml). It runs on every push to `main`.

### Commit convention

The bump is decided by scanning every commit since the last tag. The highest bump wins.

| Prefix | Version bump |
|--------|--------------|
| `fix:`, `perf:` | patch (1.2.0 → 1.2.1) |
| `feat:` | minor (1.2.0 → 1.3.0) |
| `feat!:` (any `type!:`) or `BREAKING CHANGE` in a message | major (1.2.0 → 2.0.0) |
| `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `build:`, `ci:` | no release |

### Flow

1. Merge to `main`.
2. **deploy** builds the web version (`npm run build`) and publishes it to GitHub Pages.
3. **auto-tag** works out the bump. It then runs `npm version`, commits `chore: release vX.Y.Z [skip ci]`, and pushes the commit and the `vX.Y.Z` tag.
4. **release**, on a Windows runner, generates release notes with [`.github/scripts/release-notes.mjs`](../.github/scripts/release-notes.mjs), then runs `npm run electron:build`. It uploads the installers and `latest*.yml` (for the auto-updater) to a GitHub Release.
5. Installed apps pick up the new version on their next launch (see Auto-Update).

---

## Auto-Update

On launch, installed (non-dev) builds query GitHub Releases for newer versions. Update lifecycle is surfaced through toasts:

- New version detected → "Downloading in background..."
- Download progress → live percent in a toast
- Download complete → persistent toast with **Restart Now** action
- Restart → `quitAndInstall()` applies the update

Implementation: [electron/main.cjs](electron/main.cjs), [src/hooks/useAppUpdater.ts](src/hooks/useAppUpdater.ts)

---

## Release Notes Viewer

Click the scroll icon in the header to open the in-app release notes modal. It fetches releases from the GitHub API and renders the changelog inline — same content as the GitHub Releases page.

Implementation: [src/components/release-notes/release-notes-modal.tsx](src/components/release-notes/release-notes-modal.tsx)

---

## Project Structure

```
devforge/
├── index.html               # Main window entry
├── monitor.html             # Hidden background-monitor worker entry
├── electron/                # Main process + IPC handlers
│   ├── main.cjs             # App entry, BrowserWindow, auto-updater wiring
│   ├── preload.cjs          # contextBridge exposing electronAPI (main window + worker)
│   └── ipc/                 # Per-feature IPC modules
│       ├── azure-metrics.cjs         # Azure Monitor / App Insights queries (page + monitor fetch)
│       ├── azure-*.cjs               # SNAT, restarts, crash monitoring, page views, detectors, signals
│       ├── background-monitor.cjs    # Tray icon, hidden worker window, desktop notifications
│       ├── incident-report.cjs       # AI report + Claude RCA
│       ├── telemetry-ask.cjs         # Ask Telemetry: Claude-written KQL, run read-only on App Insights
│       ├── pagespeed-insight.cjs     # Google PageSpeed API + Markdown report / fix brief
│       ├── unused-assets.cjs         # Unused CSS/JS scan + Claude review
│       ├── confluence.cjs            # Release runbook fetch (session + REST)
│       ├── claude-cli.cjs            # Shared Claude CLI spawning
│       └── commands.cjs, ipapi.cjs, …
├── src/
│   ├── app.tsx              # App shell: sidebar, tabs, providers, modals
│   ├── pages/               # Top-level pages
│   ├── components/          # Feature + UI components (azure, pagespeed, toolbox, release-pilot, …)
│   ├── monitor/             # Background monitor worker: fetch loop + alert rules
│   ├── hooks/               # Custom hooks (useAppUpdater, useAzureMetrics, usePageTabs, …)
│   ├── services/            # External API clients (googleApi)
│   ├── lib/                 # Utilities (settings-store, page-tabs, parse-runbook, …)
│   ├── context/             # Settings providers
│   └── routes/              # Page registry
└── shared/                  # Types shared by main + renderer

.github/ (repo root)         # deploy.yml (Pages + tag + release), scripts/release-notes.mjs
```

---

## Configuration

Open the in-app **Settings** modal to configure:

- **Azure** — subscription ID + per-app entries (App Service or Container App, optional API + DB, optional network/edge diagnostics: Log Analytics workspace, App Gateway, Front Door, Load Balancer)
- **API Keys** — Google PageSpeed, UptimeRobot
- **Atlassian** — Confluence base URL, account email, API token (for Release Pilot)
- **Background monitor** — turn the tray monitor on and pick the apps to watch; lists what it watches and when it alerts

Settings are stored encrypted in the app's local storage, on this machine only (no cloud sync). Azure access comes from your `az login`, not from Settings.

---

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server (browser only) |
| `npm run electron:dev:live` | Vite + Electron with HMR |
| `npm run electron:build` | Production installer for current OS |
| `npm run electron:pack` | Unpacked build (no installer) |
| `npm run electron:release` | Build + publish to GitHub Releases |
| `npm run lint` | ESLint over the codebase |
| `npm run typecheck` | `tsc --noEmit` type check |
| `npm run test` | Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |

---

## License

ISC
