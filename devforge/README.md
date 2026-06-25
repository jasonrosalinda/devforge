# devForge

Developer toolkit built with Electron, React, and TypeScript. Bundles utilities for performance auditing, Azure App Service / Container Apps monitoring, release runbook prep, asset conversion, and quick-reference cheatsheets into a single cross-platform desktop app.

---

## Features

| Tool | Description |
|------|-------------|
| **PageSpeed Insights** | Run Google PageSpeed and local Lighthouse audits. Single, branch-comparison, and 3-run-average modes. Parallel URL processing. Save/restore/clear run history. Export detailed AI-ready Markdown reports with LCP phase breakdowns, opportunities, diagnostics, and prioritized recommendations. |
| **App Health Check** | Azure App Service + Container Apps health dashboard. CPU/memory charts (p99), incident report generation, downtime detection via Azure Monitor, optional network/edge diagnostics (App Gateway, Front Door, Load Balancer via Log Analytics). |
| **Release Pilot** | Fetch a Confluence release runbook, parse sections/goals/schedule, surface attachment images in a lightbox, and generate a Teams-ready release summary on the clipboard. |
| **Translation** | Localization key viewer/editor with searchable table. |
| **CSS Audit** | Upload stylesheets, analyze selectors, detect unused/duplicate rules. |
| **Image to SVG** | Convert raster images to optimized SVG. |
| **Time Converter** | Multi-timezone conversion with live clocks. |
| **React Cheatsheet** | Quick reference for React hooks, patterns, and APIs. |
| **Blazor Cheatsheet** | Quick reference for Blazor components and lifecycle. |

---

## Tech Stack

- **Runtime** — Electron 35, Node 20+
- **Frontend** — React 19, TypeScript, Vite (rolldown-vite), Tailwind CSS
- **UI** — Radix UI primitives, shadcn-style components, sonner toasts, recharts, `@tanstack/react-table`
- **Performance** — Lighthouse 13, chrome-launcher (warm-cache + LCP capture via CDP)
- **Azure** — `@azure/identity`, `@azure/monitor-query` (App Service + Container Apps, Log Analytics)
- **Confluence** — runbook fetch via persisted browser session + Confluence Cloud REST
- **Markdown / capture** — `marked`, `html2canvas`
- **Testing** — Vitest + happy-dom
- **Auto-update** — `electron-updater` via GitHub Releases
- **Release automation** — `release-please` (conventional commits → version bumps + CHANGELOG)
- **Packaging** — `electron-builder` (NSIS / DMG / AppImage / deb)

---

## Getting Started

### Prerequisites

- Node.js 20 or newer
- npm 10+
- (Windows only, for Lighthouse audits) Chrome installed

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

Releases are fully automated via **conventional commits** + **release-please**.

### Commit convention

| Prefix | Version bump |
|--------|--------------|
| `fix:` | patch (1.2.0 → 1.2.1) |
| `feat:` | minor (1.2.0 → 1.3.0) |
| `feat!:` or `BREAKING CHANGE:` in body | major (1.2.0 → 2.0.0) |
| `chore:`, `docs:`, `refactor:`, `test:`, `style:`, `perf:`, `build:`, `ci:` | no bump |

### Flow

1. Push commits to `main` with conventional prefixes.
2. The `Release` GitHub Action opens (or updates) a **Release PR** titled `chore(main): release X.Y.Z` containing the version bump + auto-generated `CHANGELOG.md`.
3. Merge the Release PR when ready to ship.
4. release-please creates the `vX.Y.Z` tag + GitHub Release.
5. The build matrix runs on Windows / macOS / Linux runners, compiles installers, and uploads them as release assets (plus `latest.yml` for auto-updater).
6. Installed apps detect the new version on next launch and prompt to restart.

Configuration: [release-please-config.json](release-please-config.json), [.release-please-manifest.json](.release-please-manifest.json), [.github/workflows/release-please.yml](.github/workflows/release-please.yml)

---

## Auto-Update

On launch, installed (non-dev) builds query GitHub Releases for newer versions. Update lifecycle is surfaced through toasts:

- New version detected → "Downloading in background..."
- Download progress → live percent in a toast
- Download complete → persistent toast with **Restart Now** action
- Restart → `quitAndInstall()` applies the update

Implementation: [electron/main.js](electron/main.js), [src/hooks/useAppUpdater.ts](src/hooks/useAppUpdater.ts)

---

## Release Notes Viewer

Click the scroll icon in the header to open the in-app release notes modal. It fetches releases from the GitHub API and renders the changelog inline — same content as the GitHub Releases page.

Implementation: [src/components/release-notes/release-notes-modal.tsx](src/components/release-notes/release-notes-modal.tsx)

---

## Project Structure

```
devforge/
├── electron/                 # Main process + IPC handlers
│   ├── main.js              # App entry, BrowserWindow, auto-updater wiring
│   ├── preload.cjs          # contextBridge exposing electronAPI
│   ├── ipc/                 # Per-feature IPC modules
│   │   ├── pagespeed.cjs           # Lighthouse runner
│   │   ├── pagespeed-insight.cjs   # AI Markdown report generator
│   │   ├── azure-metrics.cjs       # Azure Monitor queries
│   │   ├── incident-report.cjs     # Downtime report builder
│   │   ├── confluence.cjs          # Release runbook fetch (session + REST)
│   │   └── commands.cjs            # Shared command helpers
│   └── utils/               # CDP / browser / Lighthouse helpers
├── src/
│   ├── app.tsx              # App shell, providers, modals
│   ├── pages/               # Top-level feature pages
│   ├── components/          # Feature + UI components (pagespeed, app-health-check, release-pilot, …)
│   ├── hooks/               # Custom hooks (useAppUpdater, useAzureMetrics, etc.)
│   ├── services/            # External API clients (googleApi)
│   ├── lib/                 # Utilities (parse-runbook, settings-store, env detection)
│   ├── context/             # Settings provider
│   └── routes/              # Page registry
├── shared/                  # Types + utils shared by main + renderer
└── .github/workflows/       # CI / release automation
```

---

## Configuration

Open the in-app **Settings** modal to configure:

- **Azure** — subscription ID + per-app entries (App Service or Container App, optional API + DB, optional network/edge diagnostics: Log Analytics workspace, App Gateway, Front Door, Load Balancer)
- **API keys** — Google PageSpeed, UptimeRobot
- **Atlassian** — Confluence base URL, account email, API token (for Release Pilot)

Settings are stored locally in the OS user-data directory (no cloud sync).

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
