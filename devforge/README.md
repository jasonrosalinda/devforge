# devForge

Developer toolkit built with Electron, React, and TypeScript. Bundles Azure App Service / Container Apps monitoring, PageSpeed auditing, unused-asset scanning, release runbook prep and editing, and everyday developer utilities into a single cross-platform desktop app.

---

## Features

| Tool | Description |
|------|-------------|
| **App Health Check** | Azure App Service + Container Apps health dashboard. CPU/memory charts (p99), incident report generation, downtime detection via Azure Monitor, optional network/edge diagnostics (App Gateway, Front Door, Load Balancer via Log Analytics). |
| **PageSpeed Insights** | Run Google PageSpeed audits. Single, branch-comparison, and multi-run modes (1-10 runs per URL, average or median). Save/restore/clear run history. Export detailed AI-ready Markdown reports with LCP phase breakdowns, opportunities, diagnostics, and prioritized recommendations. See [docs/pagespeed-insights.md](docs/pagespeed-insights.md). |
| **Unused Assets** | Scan a project folder for unused CSS classes/ids and unused JS functions. |
| **Release Pilot** | Fetch a Confluence release runbook, parse sections/goals/schedule, surface attachment images in a lightbox, and generate a Teams-ready release summary on the clipboard. |
| **Translation** | Localization key viewer/editor with searchable table. |

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
- **AI** — the [Claude CLI](https://docs.claude.com/en/docs/claude-code) (`claude -p`, your existing login) for RCA, PageSpeed analysis and the Unused Assets review
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
- Optional: [Claude CLI](https://docs.claude.com/en/docs/claude-code) on PATH — for RCA, PageSpeed Claude Analysis and the Unused Assets review

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
│       ├── pagespeed-insight.cjs   # Google PageSpeed API + AI Markdown report generator
│       ├── azure-metrics.cjs       # Azure Monitor queries
│       ├── incident-report.cjs     # Downtime report builder
│       ├── confluence.cjs          # Release runbook fetch (session + REST)
│       └── commands.cjs            # Shared command helpers
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
