# Azure Dashboard Full Remodel — Design Spec
**Date:** 2026-05-05  
**Status:** Approved

## Summary

Replace the Puppeteer screenshot-based Azure Dashboard with a real Azure Monitor metrics page modelled on StackSentinel's health-check feature. Auth switches from browser-based MSAL (Puppeteer) to `DefaultAzureCredential` (`az login`). UI switches from inline image tiles to live recharts area charts.

---

## Architecture

```
Renderer (React)
  azureDashboardPage.tsx
    └── useAzureMetrics.ts          ← new hook, wraps IPC
          └── window.electronAPI.azureMetrics.*

Electron Main Process
  electron/ipc/azure-metrics.cjs   ← new IPC handler
    ├── @azure/identity             (DefaultAzureCredential)
    └── @azure/monitor-query        (MetricsQueryClient)
```

The existing `azure-capture.cjs` IPC handler is left untouched. It is simply no longer wired into the dashboard page.

---

## New Files

| File | Purpose |
|---|---|
| `electron/ipc/azure-metrics.cjs` | IPC handler — credential check + metrics query |
| `shared/types/azureMetrics.types.ts` | Shared types: `AppMetrics`, `AppEntry`, `MetricSeries` |
| `src/hooks/useAzureMetrics.ts` | React hook — credential check state + fetch metrics |
| `src/components/azure/azureMetricChart.tsx` | Recharts `CombinedChart` (CPU+Mem area chart) |
| `src/components/azure/azureAppCard.tsx` | Card: chart + stats + availability + instances |

## Modified Files

| File | Change |
|---|---|
| `electron/main.js` | Register `azure-metrics.cjs` handler |
| `electron/preload.cjs` | Expose `azureMetrics` namespace on `window.electronAPI` |
| `src/pages/azureDashboardPage.tsx` | Full rewrite — remove Puppeteer hooks, add metrics UI |
| `shared/types/azureCapture.types.ts` | No change (Puppeteer types kept for `azure-capture.cjs`) |

---

## IPC Handler: `azure-metrics.cjs`

Two IPC channels:

### `azure-metrics:check-credential`
Attempts `DefaultAzureCredential.getToken('https://management.azure.com/.default')`.  
Returns `{ ok: boolean, error?: string }`.  
Called once on page mount. No retry — user must relaunch after `az login`.

### `azure-metrics:fetch`
Accepts `{ appKeys: string[], range: '1h'|'6h'|'24h'|'7d' }`.  
Queries Azure Monitor for each app in parallel.  
Returns `Record<appKey, AppMetrics>`.

**Metrics queried per app** (ported from StackSentinel `azure.ts` + health `route.ts`):
- CPU: `CpuPercentage` (avg + max series)
- Memory: `MemoryPercentage` (avg + max series)  
- Response time: `HttpResponseTime` (App Service only)
- Availability: `HealthCheckStatus` → `Http5xx/Requests` fallback (App Service) / `RunningReplicas` (Container App)
- Instances: REST call to `/instances` (App Service) or `/replicas` (Container App)
- Plan info: SKU + cores + memoryMB (App Service only, via ARM REST)

**App config** (hardcoded in `azure-metrics.cjs`, same resource IDs as StackSentinel):

| Key | Type | Resource |
|---|---|---|
| `MEDU` | `appservice` | `prdmeduapp` in `prdmedu-rg` |
| `MSP` | `containerapp` | `prdmspapp` in `PRDMSP-RG` |
| `MSP API` | `containerapp` | `prdmspapi` in `PRDMSP-RG` |

Subscription ID hardcoded in `azure-metrics.cjs` alongside the resource IDs (same approach as resource group names). Electron main process does not auto-load `.env` files, and the subscription ID is not a credential — it's already embedded in the resource ID strings. No env var needed.

---

## Shared Types: `azureMetrics.types.ts`

```ts
export interface MetricSeries {
  avg: number
  max: number
  series: Array<{ t: string; v: number; m: number }>
}

export interface InstanceInfo {
  name: string
  zone: string
  healthStatus: string
}

export interface AppMetrics {
  label: string
  type: 'appservice' | 'containerapp'
  cpu: MetricSeries
  memory: MetricSeries
  cpuUnit: string
  memUnit: string
  plan?: { sku: string; cores: number; memoryMB: number } | null
  instances?: InstanceInfo[]
  responseTime?: { avg: number; max: number } | null
  availability?: {
    pct: number
    downtimeMins: number
    incidents: number
    downtimeIntervals: Array<{ start: number; end: number }>
  } | null
}

export interface IAzureMetricsAPI {
  checkCredential: () => Promise<{ ok: boolean; error?: string }>
  fetch: (opts: { appKeys: string[]; range: string }) => Promise<Record<string, AppMetrics>>
}
```

---

## Hook: `useAzureMetrics.ts`

```ts
// State:
credStatus: 'checking' | 'ok' | 'error'
credError: string | null
metrics: Record<string, AppMetrics> | null
loading: boolean

// Actions:
fetchMetrics(appKeys: string[], range: string): Promise<void>
```

- On mount: calls `checkCredential()`, sets `credStatus`.
- `fetchMetrics`: calls `fetch()` IPC, sets `metrics`. Toasts on error.
- If `credStatus === 'error'`, `fetchMetrics` is a no-op.

---

## Components

### `azureMetricChart.tsx` — `CombinedChart`

Direct port of StackSentinel's `metric-chart.tsx`. Renders CPU avg/max + Memory avg/max as overlaid area chart using recharts `AreaChart`. Accepts downtime intervals as `ReferenceArea` overlays. Loading state = shimmer skeleton div. No changes to chart logic.

### `azureAppCard.tsx` — `AzureAppCard`

Props: `{ appKey, metrics: AppMetrics, range, loading }`.

Sections (top to bottom):
1. **Header** — app name + type label + plan info + status badge (`● Healthy / Warning / Critical`)
2. **Chart** — `CombinedChart`
3. **Stats row** — CPU avg, CPU max, Mem avg, Mem max (color-coded)
4. **Secondary row** — response time (App Service) + availability % + downtime mins + incident count
5. **Instances row** — colored dots + machine names

Status logic (ported from StackSentinel `getStatus`):
- Critical: CPU > 90% or Mem > 95%
- Warning: CPU > 70% or Mem > 80%
- Healthy: otherwise

Card border color matches status: default / orange / red.

---

## Page: `azureDashboardPage.tsx` (rewrite)

### Layout

```
┌─ Page header ──────────────────────────────────────────┐
│  ⚡ Azure Health   [subtitle]        [● Authenticated]  │
│  [Error banner — only when credStatus=error]            │
├─ Control bar ──────────────────────────────────────────┤
│  [All apps ▾]   Range: [1h][6h][24h][7d]   [↻ Fetch]  │
├─ Card grid (2 cols) ───────────────────────────────────┤
│  [AzureAppCard: MEDU]   [AzureAppCard: MSP]            │
│  [AzureAppCard: MSP API]                               │
├─ Status legend ────────────────────────────────────────┤
│  Healthy ≤70%/80%   Warning >70%/80%   Critical >90%/95%│
└────────────────────────────────────────────────────────┘
```

### Behavior

- **On mount**: `useAzureMetrics` checks credential. Badge shows `checking...` → `Authenticated` or `Not authenticated`.
- **Credential error**: Banner shown. Fetch button disabled. Displays `az login` command with copy button.
- **App dropdown**: Multi-select checkboxes. "All apps" / "N of 3 apps". Select all / Deselect all.
- **Range**: Clicking a range button while metrics are loaded auto-refetches.
- **Fetch button**: Disabled while loading or cred error. Shows spinner + "Fetching..." while in flight.
- **Empty state**: "Select apps and time range, then click Fetch Metrics."

### Styling

Follows existing `azureDashboardPage.tsx` pattern: `C` color token object + inline styles. Dark theme (`#07090f` background). No Tailwind — matches current page convention.

---

## Removed

| Removed | Replaced by |
|---|---|
| `useAzureAuth` (from page) | `credStatus` from `useAzureMetrics` |
| `useAzureCapture` (from page) | `fetchMetrics` from `useAzureMetrics` |
| `useAzureGallery` (from page) | not needed |
| `AzureCharts` (from page) | `AzureAppCard` grid |
| `LogConsole` component | removed |
| `HARDCODED_WAIT_SECONDS` | removed |
| Puppeteer auth button + flow | credential badge + error banner |

The hooks `useAzureAuth`, `useAzureCapture`, `useAzureGallery` are **not deleted** from `useAzureCapture.ts` — they remain for potential future use. `azure-capture.cjs` IPC handler stays registered in `main.js`.

---

## Dependencies

`@azure/identity` and `@azure/monitor-query` are already installed in StackSentinel. Need to add to devforge:

```bash
npm install @azure/identity @azure/monitor-query recharts
```

`recharts` needed for `CombinedChart`. Check if already present in `package.json` before installing.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `az login` not done | Credential check fails → red badge + error banner + copy-able `az login` command |
| Wrong subscription ID hardcoded | Fetch fails → `toast.error` with Azure ARM error message |
| Individual app query fails | That app's card shows error state; other cards render normally |
| Network timeout | `toast.error` with message from thrown Error |

---

## Out of Scope

- AI insights (StackSentinel's Sparkles/Claude button) — not included
- Custom app config UI — apps hardcoded
- Service principal / client secret auth — `DefaultAzureCredential` only
- Persisted settings for selected apps / range — in-memory only
