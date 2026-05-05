# Azure Dashboard Remodel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Puppeteer screenshot-based Azure dashboard with a live Azure Monitor metrics page using `DefaultAzureCredential` and recharts area charts.

**Architecture:** New IPC handler `azure-metrics.cjs` queries Azure Monitor via `@azure/monitor-query` in the Electron main process. Auth uses `DefaultAzureCredential` (picks up `az login` tokens automatically). React side wires through `window.electronAPI.azureMetrics` with a credential-check hook and a 2-col card grid per spec Approach B.

**Tech Stack:** `@azure/identity`, `@azure/monitor-query`, `recharts`, `vitest` (unit tests for pure helpers), inline styles + `C` color token object (dark theme, no Tailwind — matches current page convention).

---

### Task 1: Install Production Dependencies

**Files:**
- Modify: `package.json` (automated by npm)

- [ ] **Step 1: Check what's already installed**

```bash
npm ls @azure/identity @azure/monitor-query recharts 2>&1 | head -20
```

Expected: all three show `(empty)` — none installed yet.

- [ ] **Step 2: Install production deps**

```bash
npm install @azure/identity @azure/monitor-query recharts
```

Expected: no peer-dep errors. If recharts warns about react version — ignore, runtime is fine.

- [ ] **Step 3: Install vitest for unit tests**

```bash
npm install -D vitest
```

- [ ] **Step 4: Add test scripts to package.json**

Open `package.json`, add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Create vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'electron/**/*.test.cjs',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
  },
})
```

- [ ] **Step 6: Verify vitest runs**

```bash
npm test
```

Expected: `No test files found, exiting with code 0` or similar — no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "feat: install @azure/identity, @azure/monitor-query, recharts; add vitest"
```

---

### Task 2: Shared Types

**Files:**
- Create: `shared/types/azureMetrics.types.ts`

- [ ] **Step 1: Create the types file**

Create `shared/types/azureMetrics.types.ts`:

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
  error?: string
}

export interface IAzureMetricsAPI {
  checkCredential: () => Promise<{ ok: boolean; error?: string }>
  fetch: (opts: { appKeys: string[]; range: string }) => Promise<Record<string, AppMetrics>>
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared/types/azureMetrics.types.ts
git commit -m "feat: add shared AzureMetrics types"
```

---

### Task 3: Update Electron Type Declarations

**Files:**
- Modify: `shared/types/electron.d.ts`

Current content:
```ts
import type { IAzureAPI } from './azureCapture.types';

export interface IElectronAPI {
    runAudit: ...;
    clearLighthouseCache: ...;
    azure: IAzureAPI;
}
```

- [ ] **Step 1: Add azureMetrics to IElectronAPI**

Edit `shared/types/electron.d.ts`:

```ts
import type { IAzureAPI } from './azureCapture.types';
import type { IAzureMetricsAPI } from './azureMetrics.types';

export interface IElectronAPI {
    // PageSpeed / Lighthouse  (existing)
    runAudit: (url: string, strategy: string, visitMode: string, runMode: 'single' | 'average') => Promise<PageSpeedInsightResult>;
    clearLighthouseCache: () => Promise<{ success: boolean }>;

    // Azure Chart Capture  (existing — Puppeteer)
    azure: IAzureAPI;

    // Azure Monitor Metrics  (new)
    azureMetrics: IAzureMetricsAPI;
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
    }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared/types/electron.d.ts
git commit -m "feat: expose azureMetrics namespace on IElectronAPI"
```

---

### Task 4: IPC Handler — Helper Functions + Tests

**Files:**
- Create: `electron/ipc/azure-metrics.cjs`
- Create: `electron/ipc/azure-metrics.test.cjs`

This task writes the pure, testable helper functions and their tests. Task 5 adds the Azure SDK calls.

- [ ] **Step 1: Write the failing tests**

Create `electron/ipc/azure-metrics.test.cjs`:

```cjs
const { describe, it, expect } = require('vitest');
const handler = require('./azure-metrics.cjs');

const { _getGranularity, _summarize } = handler;

describe('getGranularity', () => {
  it('returns PT5M for 1h', () => {
    expect(_getGranularity('1h')).toBe('PT5M');
  });
  it('returns PT15M for 6h', () => {
    expect(_getGranularity('6h')).toBe('PT15M');
  });
  it('returns PT1H for 24h', () => {
    expect(_getGranularity('24h')).toBe('PT1H');
  });
  it('returns PT6H for 7d', () => {
    expect(_getGranularity('7d')).toBe('PT6H');
  });
  it('defaults to PT1H for unknown range', () => {
    expect(_getGranularity('unknown')).toBe('PT1H');
  });
});

describe('summarize', () => {
  it('returns avg and max from timeseries data', () => {
    const data = [
      { timeStamp: new Date('2024-01-01T00:00Z'), average: 10, maximum: 20 },
      { timeStamp: new Date('2024-01-01T00:05Z'), average: 30, maximum: 40 },
    ];
    const result = _summarize(data);
    expect(result.avg).toBe(20);
    expect(result.max).toBe(40);
    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toEqual({
      t: '2024-01-01T00:00:00.000Z',
      v: 10,
      m: 20,
    });
  });

  it('handles empty data', () => {
    const result = _summarize([]);
    expect(result.avg).toBe(0);
    expect(result.max).toBe(0);
    expect(result.series).toHaveLength(0);
  });

  it('handles null average/maximum gracefully', () => {
    const data = [
      { timeStamp: new Date('2024-01-01T00:00Z'), average: null, maximum: null },
    ];
    const result = _summarize(data);
    expect(result.avg).toBe(0);
    expect(result.max).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `Cannot find module './azure-metrics.cjs'`

- [ ] **Step 3: Create azure-metrics.cjs with helper stubs**

Create `electron/ipc/azure-metrics.cjs`:

```cjs
'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────

const SUBSCRIPTION_ID = '044d478b-62ae-4658-a14b-ac179f55b057';

const AZURE_APPS = {
  MEDU: {
    label: 'MEDU',
    type: 'appservice',
    resourceGroup: 'prdmedu-rg',
    name: 'prdmeduapp',
  },
  MSP: {
    label: 'MSP',
    type: 'containerapp',
    resourceGroup: 'PRDMSP-RG',
    name: 'prdmspapp',
  },
  'MSP API': {
    label: 'MSP API',
    type: 'containerapp',
    resourceGroup: 'PRDMSP-RG',
    name: 'prdmspapi',
  },
};

const GRANULARITY_MAP = {
  '1h':  'PT5M',
  '6h':  'PT15M',
  '24h': 'PT1H',
  '7d':  'PT6H',
};

// ─── Pure Helpers (exported for testing) ─────────────────────────────────────

function getGranularity(range) {
  return GRANULARITY_MAP[range] || 'PT1H';
}

function summarize(data) {
  if (!data || data.length === 0) return { avg: 0, max: 0, series: [] };
  const series = data.map(d => ({
    t: d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp),
    v: d.average ?? 0,
    m: d.maximum ?? 0,
  }));
  const avg = series.reduce((s, p) => s + p.v, 0) / series.length;
  const max = Math.max(...series.map(p => p.m));
  return {
    avg: Math.round(avg * 10) / 10,
    max: Math.round(max * 10) / 10,
    series,
  };
}

function resourceId(app) {
  if (app.type === 'appservice') {
    return `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${app.resourceGroup}/providers/Microsoft.Web/sites/${app.name}`;
  }
  return `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${app.resourceGroup}/providers/Microsoft.App/containerApps/${app.name}`;
}

// ─── IPC handler stub (Azure SDK calls added in Task 5) ──────────────────────

const handler = (_mainWindow) => {
  // IPC channels registered in Task 5
};

// Expose helpers for unit tests
handler._getGranularity = getGranularity;
handler._summarize = summarize;

module.exports = handler;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/ipc/azure-metrics.cjs electron/ipc/azure-metrics.test.cjs
git commit -m "feat: add azure-metrics.cjs with helper functions and unit tests"
```

---

### Task 5: IPC Handler — Azure SDK Calls

**Files:**
- Modify: `electron/ipc/azure-metrics.cjs`

This task adds the two IPC channels: `azure-metrics:check-credential` and `azure-metrics:fetch`.

- [ ] **Step 1: Add credential check + metrics fetch to the handler**

Replace the handler function in `electron/ipc/azure-metrics.cjs` (keep all existing helpers above — only replace the `handler` function and `module.exports`):

```cjs
// ─── Azure SDK helpers ────────────────────────────────────────────────────────

async function getToken(credential) {
  const tokenResp = await credential.getToken('https://management.azure.com/.default');
  return tokenResp.token;
}

async function queryMetric(client, resId, metricName, range, granularity) {
  const { Durations } = require('@azure/monitor-query');
  const RANGE_MAP = {
    '1h':  Durations.oneHour,
    '6h':  Durations.sixHours,
    '24h': Durations.oneDay,
    '7d':  Durations.sevenDays,
  };
  const result = await client.queryResource(resId, [metricName], {
    duration: RANGE_MAP[range] || Durations.oneDay,
    granularity,
    aggregations: ['Average', 'Maximum'],
  });
  const data = result.metrics[0]?.timeseries?.[0]?.data || [];
  return summarize(data);
}

async function getInstances(token, resId) {
  const url = `https://management.azure.com${resId}/instances?api-version=2022-03-01`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.value || []).map(i => ({
    name: i.name || '',
    zone: i.properties?.availabilityZone || '',
    healthStatus: i.properties?.healthStatus || 'Unknown',
  }));
}

async function getReplicas(token, resId) {
  const revUrl = `https://management.azure.com${resId}/revisions?api-version=2023-05-01`;
  const revRes = await fetch(revUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!revRes.ok) return [];
  const revData = await revRes.json();
  const active = (revData.value || []).find(r => r.properties?.active) || revData.value?.[0];
  if (!active) return [];
  const repUrl = `https://management.azure.com${resId}/revisions/${active.name}/replicas?api-version=2023-05-01`;
  const repRes = await fetch(repUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!repRes.ok) return [];
  const repData = await repRes.json();
  return (repData.value || []).map(r => ({
    name: r.name || '',
    zone: '',
    healthStatus: r.properties?.runningState || 'Unknown',
  }));
}

async function getPlanInfo(token, resId) {
  const url = `https://management.azure.com${resId}?api-version=2022-03-01`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  const farmId = data.properties?.serverFarmId;
  if (!farmId) return null;
  const planRes = await fetch(`https://management.azure.com${farmId}?api-version=2022-03-01`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!planRes.ok) return null;
  const plan = await planRes.json();
  return {
    sku: plan.sku?.name || '',
    cores: plan.sku?.capacity || 1,
    memoryMB: plan.properties?.maximumElasticWorkerCount || 0,
  };
}

async function getResponseTime(client, resId, range, granularity) {
  try {
    const { Durations } = require('@azure/monitor-query');
    const RANGE_MAP = {
      '1h':  Durations.oneHour,
      '6h':  Durations.sixHours,
      '24h': Durations.oneDay,
      '7d':  Durations.sevenDays,
    };
    const result = await client.queryResource(resId, ['HttpResponseTime'], {
      duration: RANGE_MAP[range] || Durations.oneDay,
      granularity,
      aggregations: ['Average', 'Maximum'],
    });
    const data = result.metrics[0]?.timeseries?.[0]?.data || [];
    if (!data.length) return null;
    const s = summarize(data);
    return { avg: s.avg, max: s.max };
  } catch {
    return null;
  }
}

function extractDowntimeIntervals(series) {
  const intervals = [];
  let start = null;
  for (const p of series) {
    const down = (p.average ?? 100) < 50;
    if (down && start === null) {
      start = new Date(p.timeStamp).getTime();
    } else if (!down && start !== null) {
      intervals.push({ start, end: new Date(p.timeStamp).getTime() });
      start = null;
    }
  }
  if (start !== null) {
    const last = series[series.length - 1];
    intervals.push({ start, end: new Date(last.timeStamp).getTime() });
  }
  return intervals;
}

async function getAvailability(client, token, resId, appType, range, granularity) {
  const { Durations } = require('@azure/monitor-query');
  const RANGE_MAP = {
    '1h':  Durations.oneHour,
    '6h':  Durations.sixHours,
    '24h': Durations.oneDay,
    '7d':  Durations.sevenDays,
  };
  let rawSeries = [];

  if (appType === 'appservice') {
    try {
      const hc = await client.queryResource(resId, ['HealthCheckStatus'], {
        duration: RANGE_MAP[range] || Durations.oneDay,
        granularity,
        aggregations: ['Average'],
      });
      rawSeries = hc.metrics[0]?.timeseries?.[0]?.data || [];
    } catch {
      try {
        const [reqRes, errRes] = await Promise.all([
          client.queryResource(resId, ['Requests'], {
            duration: RANGE_MAP[range] || Durations.oneDay, granularity, aggregations: ['Total'],
          }),
          client.queryResource(resId, ['Http5xx'], {
            duration: RANGE_MAP[range] || Durations.oneDay, granularity, aggregations: ['Total'],
          }),
        ]);
        const reqData = reqRes.metrics[0]?.timeseries?.[0]?.data || [];
        const errData = errRes.metrics[0]?.timeseries?.[0]?.data || [];
        rawSeries = reqData.map((r, i) => {
          const total = r.total ?? 0;
          const errs = errData[i]?.total ?? 0;
          return {
            timeStamp: r.timeStamp,
            average: total > 0 ? (1 - errs / total) * 100 : 100,
          };
        });
      } catch {
        return null;
      }
    }
  } else {
    try {
      const rr = await client.queryResource(resId, ['RunningReplicas'], {
        duration: RANGE_MAP[range] || Durations.oneDay,
        granularity,
        aggregations: ['Average'],
      });
      rawSeries = (rr.metrics[0]?.timeseries?.[0]?.data || []).map(d => ({
        timeStamp: d.timeStamp,
        average: (d.average ?? 0) > 0 ? 100 : 0,
      }));
    } catch {
      return null;
    }
  }

  if (!rawSeries.length) return null;
  const intervals = extractDowntimeIntervals(rawSeries);
  const downPts = rawSeries.filter(d => (d.average ?? 100) < 50).length;
  const granMins = granularity === 'PT5M' ? 5 : granularity === 'PT15M' ? 15 : granularity === 'PT1H' ? 60 : 360;
  const downtimeMins = downPts * granMins;
  const pct = Math.round((1 - downPts / rawSeries.length) * 1000) / 10;
  return { pct, downtimeMins, incidents: intervals.length, downtimeIntervals: intervals };
}

async function fetchAppMetrics(client, token, appKey, range) {
  const app = AZURE_APPS[appKey];
  if (!app) throw new Error(`Unknown app key: ${appKey}`);
  const resId = resourceId(app);
  const gran = getGranularity(range);

  const [cpu, memory] = await Promise.all([
    queryMetric(client, resId, 'CpuPercentage', range, gran),
    queryMetric(client, resId, 'MemoryPercentage', range, gran),
  ]);

  const [instances, availability, responseTime] = await Promise.all([
    app.type === 'appservice' ? getInstances(token, resId) : getReplicas(token, resId),
    getAvailability(client, token, resId, app.type, range, gran),
    app.type === 'appservice' ? getResponseTime(client, resId, range, gran) : Promise.resolve(null),
  ]);

  const plan = app.type === 'appservice' ? await getPlanInfo(token, resId) : null;

  return {
    label: app.label,
    type: app.type,
    cpu,
    memory,
    cpuUnit: '%',
    memUnit: '%',
    plan,
    instances,
    responseTime,
    availability,
  };
}

// ─── IPC handler ─────────────────────────────────────────────────────────────

const handler = (_mainWindow) => {
  const { ipcMain } = require('electron');
  const { DefaultAzureCredential } = require('@azure/identity');
  const { MetricsQueryClient } = require('@azure/monitor-query');

  ipcMain.handle('azure-metrics:check-credential', async () => {
    try {
      const cred = new DefaultAzureCredential();
      await cred.getToken('https://management.azure.com/.default');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('azure-metrics:fetch', async (_event, { appKeys, range }) => {
    const cred = new DefaultAzureCredential();
    const client = new MetricsQueryClient(cred);
    const token = await getToken(cred);

    const results = {};
    await Promise.all(
      appKeys.map(async (key) => {
        try {
          results[key] = await fetchAppMetrics(client, token, key, range);
        } catch (err) {
          results[key] = {
            label: AZURE_APPS[key]?.label || key,
            type: AZURE_APPS[key]?.type || 'appservice',
            cpu: { avg: 0, max: 0, series: [] },
            memory: { avg: 0, max: 0, series: [] },
            cpuUnit: '%',
            memUnit: '%',
            error: err.message || String(err),
          };
        }
      })
    );
    return results;
  });
};

handler._getGranularity = getGranularity;
handler._summarize = summarize;

module.exports = handler;
```

- [ ] **Step 2: Run tests to verify helpers still pass**

```bash
npm test
```

Expected: all 8 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add electron/ipc/azure-metrics.cjs
git commit -m "feat: add azure-metrics IPC handler with credential check and metrics fetch"
```

---

### Task 6: Register Handler in main.js

**Files:**
- Modify: `electron/main.js`

- [ ] **Step 1: Add azure-metrics.cjs registration**

In `electron/main.js`, after the `azure-capture.cjs` registration block, add:

```js
    try {
        require('./ipc/azure-metrics.cjs')(mainWindow);
        console.log('✅ azure-metrics handlers registered');
    } catch (err) {
        console.error('❌ Failed to load azure-metrics.cjs:', err);
    }
```

The result should look like:

```js
app.whenReady().then(() => {
    const mainWindow = createWindow();

    try {
        require('./ipc/pagespeed.cjs')(mainWindow);
        console.log('✅ pagespeed handlers registered');
    } catch (err) {
        console.error('❌ Failed to load pagespeed.cjs:', err);
    }

    try {
        require('./ipc/azure-capture.cjs')(mainWindow);
        console.log('✅ azure-capture handlers registered');
    } catch (err) {
        console.error('❌ Failed to load azure-capture.cjs:', err);
    }

    try {
        require('./ipc/azure-metrics.cjs')(mainWindow);
        console.log('✅ azure-metrics handlers registered');
    } catch (err) {
        console.error('❌ Failed to load azure-metrics.cjs:', err);
    }

    if (!isDev) autoUpdater.checkForUpdatesAndNotify();
    // ...
```

- [ ] **Step 2: Commit**

```bash
git add electron/main.js
git commit -m "feat: register azure-metrics IPC handler in main.js"
```

---

### Task 7: Expose on Preload

**Files:**
- Modify: `electron/preload.cjs`

- [ ] **Step 1: Add azureMetrics namespace**

In `electron/preload.cjs`, add `azureMetrics` after the `azure` namespace:

```cjs
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    runAudit: (url, strategy, visitMode = 'cold', runMode = 'single' || 'average') =>
        ipcRenderer.invoke('run-lighthouse', { url, strategy, visitMode, runMode }),

    clearLighthouseCache: () =>
        ipcRenderer.invoke('clear-lighthouse-cache'),

    azure: {
        saveAuth: (cfg) => ipcRenderer.invoke('azure:save-auth', cfg),
        authExists: () => ipcRenderer.invoke('azure:auth-exists'),
        capture: (cfg) => ipcRenderer.invoke('azure:capture', cfg),
        getSessions: () => ipcRenderer.invoke('azure:get-sessions'),
        getTiles: (session) => ipcRenderer.invoke('azure:get-tiles', session),
        clearSessions: () => ipcRenderer.invoke('azure:clear-sessions'),
        getSettings: () => ipcRenderer.invoke('azure:get-settings'),
        saveSettings: (cfg) => ipcRenderer.invoke('azure:save-settings', cfg),

        onLog: (cb) => {
            const fn = (_e, msg) => cb(msg);
            ipcRenderer.on('azure:log', fn);
            return () => ipcRenderer.removeListener('azure:log', fn);
        },

        onDone: (cb) => {
            const fn = (_e, result) => cb(result);
            ipcRenderer.once('azure:done', fn);
            return () => ipcRenderer.removeListener('azure:done', fn);
        },
    },

    azureMetrics: {
        checkCredential: () => ipcRenderer.invoke('azure-metrics:check-credential'),
        fetch: (opts) => ipcRenderer.invoke('azure-metrics:fetch', opts),
    },

});
```

- [ ] **Step 2: Verify TypeScript still compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add electron/preload.cjs
git commit -m "feat: expose azureMetrics namespace on window.electronAPI"
```

---

### Task 8: React Hook — useAzureMetrics

**Files:**
- Create: `src/hooks/useAzureMetrics.ts`

- [ ] **Step 1: Create the hook**

Create `src/hooks/useAzureMetrics.ts`:

```ts
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { AppMetrics } from '@shared/types/azureMetrics.types';

type CredStatus = 'checking' | 'ok' | 'error';

interface UseAzureMetrics {
  credStatus: CredStatus;
  credError: string | null;
  metrics: Record<string, AppMetrics> | null;
  loading: boolean;
  fetchMetrics: (appKeys: string[], range: string) => Promise<void>;
}

export function useAzureMetrics(): UseAzureMetrics {
  const [credStatus, setCredStatus] = useState<CredStatus>('checking');
  const [credError, setCredError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, AppMetrics> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    window.electronAPI.azureMetrics.checkCredential().then((result) => {
      if (result.ok) {
        setCredStatus('ok');
      } else {
        setCredStatus('error');
        setCredError(result.error ?? 'Authentication failed');
      }
    });
  }, []);

  const fetchMetrics = useCallback(async (appKeys: string[], range: string) => {
    if (credStatus === 'error') return;
    if (!appKeys.length) return;
    setLoading(true);
    try {
      const data = await window.electronAPI.azureMetrics.fetch({ appKeys, range });
      setMetrics(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Azure metrics fetch failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [credStatus]);

  return { credStatus, credError, metrics, loading, fetchMetrics };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useAzureMetrics.ts
git commit -m "feat: add useAzureMetrics hook"
```

---

### Task 9: CombinedChart Component

**Files:**
- Create: `src/components/azure/azureMetricChart.tsx`

Direct port of StackSentinel's `metric-chart.tsx`. Renders CPU avg/max + Memory avg/max as overlaid area chart.

- [ ] **Step 1: Create the component**

Create `src/components/azure/azureMetricChart.tsx`:

```tsx
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  Legend,
} from 'recharts';
import type { MetricSeries } from '@shared/types/azureMetrics.types';

interface DowntimeInterval {
  start: number;
  end: number;
}

interface CombinedChartProps {
  cpu: MetricSeries;
  memory: MetricSeries;
  downtimeIntervals?: DowntimeInterval[];
  loading?: boolean;
}

const COLORS = {
  cpuAvg:  '#58a6ff',
  cpuMax:  '#1f6feb',
  memAvg:  '#3fb950',
  memMax:  '#238636',
};

function formatTick(isoStr: string): string {
  const d = new Date(isoStr);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function CombinedChart({ cpu, memory, downtimeIntervals = [], loading = false }: CombinedChartProps) {
  if (loading) {
    return (
      <div style={{
        height: 200,
        background: 'linear-gradient(90deg, #1a1f2e 25%, #222840 50%, #1a1f2e 75%)',
        backgroundSize: '200% 100%',
        animation: 'shimmer 1.5s infinite',
        borderRadius: 6,
      }} />
    );
  }

  const merged = cpu.series.map((p, i) => ({
    t: p.t,
    cpuAvg: p.v,
    cpuMax: p.m,
    memAvg: memory.series[i]?.v ?? 0,
    memMax: memory.series[i]?.m ?? 0,
  }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <AreaChart data={merged} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
        <defs>
          <linearGradient id="gCpuAvg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={COLORS.cpuAvg} stopOpacity={0.3} />
            <stop offset="95%" stopColor={COLORS.cpuAvg} stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gMemAvg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={COLORS.memAvg} stopOpacity={0.3} />
            <stop offset="95%" stopColor={COLORS.memAvg} stopOpacity={0} />
          </linearGradient>
        </defs>

        <XAxis dataKey="t" tickFormatter={formatTick} tick={{ fill: '#8b9ab3', fontSize: 10 }} minTickGap={40} />
        <YAxis domain={[0, 100]} tick={{ fill: '#8b9ab3', fontSize: 10 }} tickFormatter={(v) => `${v}%`} />
        <Tooltip
          contentStyle={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6, fontSize: 12 }}
          labelStyle={{ color: '#8b9ab3' }}
          formatter={(val: number, name: string) => [`${val.toFixed(1)}%`, name]}
          labelFormatter={(label) => new Date(label).toLocaleTimeString()}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />

        {downtimeIntervals.map((iv, i) => (
          <ReferenceArea
            key={i}
            x1={new Date(iv.start).toISOString()}
            x2={new Date(iv.end).toISOString()}
            fill="rgba(248,81,73,0.15)"
            stroke="none"
          />
        ))}

        <Area type="monotone" dataKey="cpuMax"  name="CPU Max"  stroke={COLORS.cpuMax}  fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="cpuAvg"  name="CPU Avg"  stroke={COLORS.cpuAvg}  fill="url(#gCpuAvg)" strokeWidth={2} dot={false} />
        <Area type="monotone" dataKey="memMax"  name="Mem Max"  stroke={COLORS.memMax}  fill="none" strokeWidth={1} strokeDasharray="3 3" dot={false} />
        <Area type="monotone" dataKey="memAvg"  name="Mem Avg"  stroke={COLORS.memAvg}  fill="url(#gMemAvg)" strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
```

- [ ] **Step 2: Add shimmer keyframe to global CSS**

Open `src/index.css` (or wherever global styles live). Add:

```css
@keyframes shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position:  200% 0; }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/azure/azureMetricChart.tsx src/index.css
git commit -m "feat: add CombinedChart recharts component"
```

---

### Task 10: AzureAppCard Component + Status Tests

**Files:**
- Create: `src/components/azure/azureAppCard.tsx`
- Create: `src/components/azure/azureAppCard.test.ts`

- [ ] **Step 1: Write the failing test for getStatus**

Create `src/components/azure/azureAppCard.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getStatus } from './azureAppCard';

describe('getStatus', () => {
  it('returns critical when cpu > 90', () => {
    expect(getStatus(91, 50)).toBe('critical');
  });
  it('returns critical when mem > 95', () => {
    expect(getStatus(50, 96)).toBe('critical');
  });
  it('returns warning when cpu > 70', () => {
    expect(getStatus(71, 50)).toBe('warning');
  });
  it('returns warning when mem > 80', () => {
    expect(getStatus(50, 81)).toBe('warning');
  });
  it('returns healthy otherwise', () => {
    expect(getStatus(50, 50)).toBe('healthy');
  });
  it('critical takes priority over warning', () => {
    expect(getStatus(91, 81)).toBe('critical');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: FAIL — `getStatus is not exported from azureAppCard`

- [ ] **Step 3: Create AzureAppCard with getStatus**

Create `src/components/azure/azureAppCard.tsx`:

```tsx
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import { CombinedChart } from './azureMetricChart';

type Status = 'healthy' | 'warning' | 'critical';

export function getStatus(cpuAvg: number, memAvg: number): Status {
  if (cpuAvg > 90 || memAvg > 95) return 'critical';
  if (cpuAvg > 70 || memAvg > 80)  return 'warning';
  return 'healthy';
}

const STATUS_COLORS: Record<Status, string> = {
  healthy:  '#3fb950',
  warning:  '#d29922',
  critical: '#f85149',
};

const STATUS_BORDER: Record<Status, string> = {
  healthy:  '#21262d',
  warning:  '#9e6a03',
  critical: '#6e2a28',
};

interface AzureAppCardProps {
  appKey: string;
  metrics: AppMetrics;
  loading: boolean;
}

function StatBadge({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 60 }}>
      <span style={{ fontSize: 10, color: '#8b9ab3', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: color || '#e6edf3', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function cpuColor(val: number): string {
  if (val > 90) return '#f85149';
  if (val > 70) return '#d29922';
  return '#3fb950';
}

function memColor(val: number): string {
  if (val > 95) return '#f85149';
  if (val > 80) return '#d29922';
  return '#3fb950';
}

function InstanceDot({ healthStatus }: { healthStatus: string }) {
  const lower = healthStatus.toLowerCase();
  const color = lower === 'healthy' || lower === 'running' ? '#3fb950'
    : lower === 'unknown' ? '#8b9ab3'
    : '#f85149';
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, marginRight: 4 }} />;
}

export function AzureAppCard({ appKey, metrics, loading }: AzureAppCardProps) {
  const status = getStatus(metrics.cpu.avg, metrics.memory.avg);
  const borderColor = STATUS_BORDER[status];
  const statusColor = STATUS_COLORS[status];

  const downtimeIntervals = metrics.availability?.downtimeIntervals ?? [];

  return (
    <div style={{
      background: '#0d1117',
      border: `1px solid ${borderColor}`,
      borderRadius: 10,
      padding: '16px 20px',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#e6edf3' }}>{metrics.label}</div>
          <div style={{ fontSize: 11, color: '#8b9ab3', marginTop: 2 }}>
            {metrics.type === 'appservice' ? 'App Service' : 'Container App'}
            {metrics.plan && ` · ${metrics.plan.sku}`}
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 10px',
          borderRadius: 20,
          background: `${statusColor}22`,
          border: `1px solid ${statusColor}55`,
          fontSize: 12,
          color: statusColor,
          fontWeight: 600,
          textTransform: 'capitalize',
        }}>
          <span style={{ fontSize: 8 }}>●</span>
          {status}
        </div>
      </div>

      {/* Error state */}
      {metrics.error && (
        <div style={{ padding: '8px 12px', background: '#1c0a0a', border: '1px solid #3d1f1f', borderRadius: 6, fontSize: 12, color: '#f85149' }}>
          {metrics.error}
        </div>
      )}

      {/* Chart */}
      <CombinedChart cpu={metrics.cpu} memory={metrics.memory} downtimeIntervals={downtimeIntervals} loading={loading} />

      {/* Stats row */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <StatBadge label="CPU Avg"  value={`${metrics.cpu.avg}%`}    color={cpuColor(metrics.cpu.avg)} />
        <StatBadge label="CPU Max"  value={`${metrics.cpu.max}%`}    color={cpuColor(metrics.cpu.max)} />
        <StatBadge label="Mem Avg"  value={`${metrics.memory.avg}%`} color={memColor(metrics.memory.avg)} />
        <StatBadge label="Mem Max"  value={`${metrics.memory.max}%`} color={memColor(metrics.memory.max)} />
      </div>

      {/* Secondary row */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', paddingTop: 4, borderTop: '1px solid #21262d' }}>
        {metrics.responseTime != null && (
          <StatBadge label="Response Avg" value={`${metrics.responseTime.avg}s`} />
        )}
        {metrics.availability != null && (
          <>
            <StatBadge label="Availability" value={`${metrics.availability.pct}%`} color={metrics.availability.pct >= 99 ? '#3fb950' : metrics.availability.pct >= 95 ? '#d29922' : '#f85149'} />
            <StatBadge label="Downtime"     value={`${metrics.availability.downtimeMins}m`} />
            <StatBadge label="Incidents"    value={String(metrics.availability.incidents)} />
          </>
        )}
      </div>

      {/* Instances row */}
      {metrics.instances && metrics.instances.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 4, borderTop: '1px solid #21262d' }}>
          {metrics.instances.map((inst) => (
            <div key={inst.name} style={{ display: 'flex', alignItems: 'center', fontSize: 11, color: '#8b9ab3', background: '#161b22', padding: '2px 8px', borderRadius: 4, border: '1px solid #21262d' }}>
              <InstanceDot healthStatus={inst.healthStatus} />
              {inst.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: all 14 tests PASS (8 from azure-metrics + 6 from azureAppCard).

- [ ] **Step 5: Commit**

```bash
git add src/components/azure/azureAppCard.tsx src/components/azure/azureAppCard.test.ts
git commit -m "feat: add AzureAppCard component with getStatus logic and unit tests"
```

---

### Task 11: Rewrite azureDashboardPage.tsx

**Files:**
- Modify: `src/pages/azureDashboardPage.tsx`

**IMPORTANT:** The existing file exports `DASHBOARDS` which is imported by `src/components/azure/azureCharts.tsx`. This export must be kept to avoid breaking that component (even though it's no longer rendered by this page).

- [ ] **Step 1: Read the current page to confirm DASHBOARDS export exists**

Open `src/pages/azureDashboardPage.tsx` and note the `DASHBOARDS` export at the top. It will be preserved at the bottom of the new file.

- [ ] **Step 2: Write the new page**

Replace the entire content of `src/pages/azureDashboardPage.tsx` with:

```tsx
import { useState, useCallback } from 'react';
import { useAzureMetrics } from '@/hooks/useAzureMetrics';
import { AzureAppCard } from '@/components/azure/azureAppCard';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_APP_KEYS = ['MEDU', 'MSP', 'MSP API'] as const;
type AppKey = typeof ALL_APP_KEYS[number];
type Range = '1h' | '6h' | '24h' | '7d';
const RANGES: Range[] = ['1h', '6h', '24h', '7d'];

// ─── Color tokens (dark theme, matches devforge convention) ──────────────────

const C = {
  bg:         '#07090f',
  surface:    '#0d1117',
  border:     '#21262d',
  borderHov:  '#30363d',
  text:       '#e6edf3',
  textSub:    '#8b9ab3',
  textMuted:  '#484f58',
  accent:     '#58a6ff',
  green:      '#3fb950',
  yellow:     '#d29922',
  red:        '#f85149',
  btnBg:      '#21262d',
  btnBgHov:   '#30363d',
  btnActive:  '#1f6feb',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function CredBadge({ status, error }: { status: 'checking' | 'ok' | 'error'; error: string | null }) {
  const cfg = status === 'checking'
    ? { color: C.textSub,  dot: '○', label: 'Checking...' }
    : status === 'ok'
    ? { color: C.green,    dot: '●', label: 'Authenticated' }
    : { color: C.red,      dot: '●', label: 'Not authenticated' };

  return (
    <div title={error ?? undefined} style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 12px',
      borderRadius: 20,
      background: `${cfg.color}18`,
      border: `1px solid ${cfg.color}44`,
      fontSize: 12,
      color: cfg.color,
      fontWeight: 500,
      cursor: error ? 'help' : 'default',
    }}>
      <span style={{ fontSize: 8 }}>{cfg.dot}</span>
      {cfg.label}
    </div>
  );
}

function RangeButton({ range, active, onClick }: { range: Range; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 12px',
        borderRadius: 6,
        border: `1px solid ${active ? C.btnActive : C.border}`,
        background: active ? `${C.btnActive}22` : C.btnBg,
        color: active ? C.accent : C.textSub,
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      {range}
    </button>
  );
}

function AppDropdown({
  selected,
  onChange,
}: {
  selected: AppKey[];
  onChange: (keys: AppKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const allSelected = selected.length === ALL_APP_KEYS.length;
  const label = allSelected ? 'All apps' : selected.length === 0 ? 'No apps' : `${selected.length} of ${ALL_APP_KEYS.length} apps`;

  function toggle(key: AppKey) {
    onChange(selected.includes(key) ? selected.filter(k => k !== key) : [...selected, key]);
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: '5px 14px',
          borderRadius: 6,
          border: `1px solid ${C.border}`,
          background: C.btnBg,
          color: C.text,
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
        }}
      >
        {label}
        <span style={{ fontSize: 10, color: C.textSub }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '110%', left: 0, zIndex: 100,
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
          padding: '6px 0', minWidth: 160,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 12px 8px', borderBottom: `1px solid ${C.border}` }}>
            <button onClick={() => onChange([...ALL_APP_KEYS])} style={{ fontSize: 11, color: C.accent, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Select all</button>
            <button onClick={() => onChange([])}                style={{ fontSize: 11, color: C.textSub, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Deselect all</button>
          </div>
          {ALL_APP_KEYS.map(key => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer', color: C.text, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={selected.includes(key)}
                onChange={() => toggle(key)}
                style={{ accentColor: C.accent }}
              />
              {key}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AzureDashboardPage() {
  const { credStatus, credError, metrics, loading, fetchMetrics } = useAzureMetrics();
  const [selectedApps, setSelectedApps] = useState<AppKey[]>([...ALL_APP_KEYS]);
  const [range, setRange] = useState<Range>('24h');

  const handleFetch = useCallback(() => {
    fetchMetrics(selectedApps, range);
  }, [fetchMetrics, selectedApps, range]);

  const handleRangeChange = useCallback((r: Range) => {
    setRange(r);
    if (metrics) fetchMetrics(selectedApps, r);
  }, [fetchMetrics, metrics, selectedApps]);

  return (
    <div style={{ background: C.bg, minHeight: '100vh', padding: '24px 28px', fontFamily: 'inherit' }}
         onClick={(e) => { if ((e.target as HTMLElement).closest('[data-dropdown]') === null) {} }}>

      {/* Page header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: '-0.01em' }}>
            ⚡ Azure Health
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: C.textSub }}>
            Live metrics from Azure Monitor
          </p>
        </div>
        <CredBadge status={credStatus} error={credError} />
      </div>

      {/* Credential error banner */}
      {credStatus === 'error' && (
        <div style={{
          margin: '16px 0',
          padding: '12px 16px',
          background: '#1c0a0a',
          border: `1px solid #3d1f1f`,
          borderRadius: 8,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span style={{ fontSize: 14, color: C.red }}>✖</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: C.red, fontWeight: 600 }}>Not authenticated with Azure</div>
            <div style={{ fontSize: 12, color: C.textSub, marginTop: 3 }}>
              Run the command below in your terminal, then relaunch DevForge:
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <code style={{ fontSize: 12, color: '#79c0ff', background: '#0d1117', padding: '3px 8px', borderRadius: 4, border: `1px solid ${C.border}` }}>
                az login
              </code>
              <button
                onClick={() => navigator.clipboard.writeText('az login')}
                style={{ fontSize: 11, color: C.textSub, background: C.btnBg, border: `1px solid ${C.border}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}
              >
                Copy
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Control bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '20px 0', flexWrap: 'wrap' }}>
        <div data-dropdown>
          <AppDropdown selected={selectedApps} onChange={setSelectedApps} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 12, color: C.textSub, marginRight: 4 }}>Range:</span>
          {RANGES.map(r => (
            <RangeButton key={r} range={r} active={range === r} onClick={() => handleRangeChange(r)} />
          ))}
        </div>
        <button
          onClick={handleFetch}
          disabled={loading || credStatus === 'error' || selectedApps.length === 0}
          style={{
            marginLeft: 'auto',
            padding: '6px 18px',
            borderRadius: 6,
            border: `1px solid ${loading || credStatus === 'error' ? C.border : C.btnActive}`,
            background: loading || credStatus === 'error' ? C.btnBg : `${C.btnActive}22`,
            color: loading || credStatus === 'error' ? C.textMuted : C.accent,
            fontSize: 13,
            fontWeight: 600,
            cursor: loading || credStatus === 'error' || selectedApps.length === 0 ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', gap: 6,
            opacity: credStatus === 'error' || selectedApps.length === 0 ? 0.5 : 1,
          }}
        >
          {loading ? (
            <>
              <span style={{ display: 'inline-block', width: 10, height: 10, border: `2px solid ${C.textMuted}`, borderTopColor: C.accent, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
              Fetching...
            </>
          ) : '↻ Fetch Metrics'}
        </button>
      </div>

      {/* Card grid */}
      {!metrics && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: C.textSub, fontSize: 14 }}>
          Select apps and time range, then click Fetch Metrics.
        </div>
      )}

      {(metrics || loading) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
          {selectedApps.map(key => {
            const m = metrics?.[key];
            if (!m && !loading) return null;
            return (
              <AzureAppCard
                key={key}
                appKey={key}
                metrics={m ?? {
                  label: key,
                  type: key === 'MEDU' ? 'appservice' : 'containerapp',
                  cpu: { avg: 0, max: 0, series: [] },
                  memory: { avg: 0, max: 0, series: [] },
                  cpuUnit: '%',
                  memUnit: '%',
                }}
                loading={loading && !m}
              />
            );
          })}
        </div>
      )}

      {/* Status legend */}
      <div style={{ marginTop: 24, padding: '10px 16px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, display: 'flex', gap: 20, fontSize: 11, color: C.textSub, flexWrap: 'wrap' }}>
        <span><span style={{ color: C.green }}>● Healthy</span> — CPU ≤70% / Mem ≤80%</span>
        <span><span style={{ color: C.yellow }}>● Warning</span> — CPU &gt;70% / Mem &gt;80%</span>
        <span><span style={{ color: C.red   }}>● Critical</span> — CPU &gt;90% / Mem &gt;95%</span>
      </div>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

// ─── Kept for backward compatibility (azureCharts.tsx imports this) ───────────

export const DASHBOARDS = [
  {
    key: 'MEDU',
    label: 'MEDU',
    portalUrl: `https://portal.azure.com/#@/resource/subscriptions/044d478b-62ae-4658-a14b-ac179f55b057/resourceGroups/prdmedu-rg/providers/Microsoft.Web/sites/prdmeduapp/appServices`,
  },
  {
    key: 'MSP',
    label: 'MSP',
    portalUrl: `https://portal.azure.com/#@/resource/subscriptions/044d478b-62ae-4658-a14b-ac179f55b057/resourceGroups/PRDMSP-RG/providers/Microsoft.App/containerApps/prdmspapp/overview`,
  },
  {
    key: 'MSP API',
    label: 'MSP API',
    portalUrl: `https://portal.azure.com/#@/resource/subscriptions/044d478b-62ae-4658-a14b-ac179f55b057/resourceGroups/PRDMSP-RG/providers/Microsoft.App/containerApps/prdmspapi/overview`,
  },
];
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors. If `AppMetrics` missing fields on the loading-placeholder object, add the remaining optional fields (`plan`, `instances`, etc.) as `undefined` explicitly or mark `AppMetrics` fields optional.

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all 14 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/azureDashboardPage.tsx
git commit -m "feat: rewrite Azure dashboard page with live Monitor metrics UI"
```

---

### Task 12: Manual Smoke Test

No automated test can verify Electron IPC + Azure SDK integration. Follow this checklist manually after starting the app.

- [ ] **Step 1: Start the Electron app**

```bash
npm run electron:dev:live
```

- [ ] **Step 2: Verify credential check (happy path)**

Before launching, confirm `az login` is active in current shell. On the Azure Health page:
- Badge should show `● Authenticated` within 2-3 seconds.
- No error banner.
- Fetch button should be enabled.

- [ ] **Step 3: Verify credential check (error path)**

Run `az logout` in terminal, relaunch app. Expect:
- Badge shows `● Not authenticated`.
- Red error banner with `az login` command and copy button.
- Fetch button disabled.

- [ ] **Step 4: Verify metrics fetch**

Re-login with `az login`, relaunch. Then:
- Select "All apps", range "1h", click Fetch Metrics.
- Spinner shown during fetch.
- After completion: 3 app cards with recharts charts visible.
- CPU/Mem avg and max stats shown with color-coded values.

- [ ] **Step 5: Verify range auto-refetch**

While metrics are loaded, click "6h". Expect: automatic refetch, charts update.

- [ ] **Step 6: Verify app dropdown**

- Click "All apps ▾" — dropdown opens with 3 checkboxes.
- Deselect MEDU. Expect: only MSP and MSP API cards shown.
- Click "Select all". Expect: all 3 selected.

- [ ] **Step 7: Commit if smoke test passes**

```bash
git add .
git commit -m "feat: azure dashboard remodel complete — live Monitor metrics with recharts"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task covering it |
|---|---|
| `azure-metrics:check-credential` IPC | Task 5 |
| `azure-metrics:fetch` IPC | Task 5 |
| App config: MEDU/MSP/MSP API | Task 5 |
| Shared types `azureMetrics.types.ts` | Task 2 |
| `IAzureMetricsAPI` in `electron.d.ts` | Task 3 |
| Register in `main.js` | Task 6 |
| Expose in `preload.cjs` | Task 7 |
| `useAzureMetrics` hook | Task 8 |
| `CombinedChart` recharts component | Task 9 |
| `AzureAppCard` with status logic | Task 10 |
| Page rewrite with layout from spec | Task 11 |
| `DASHBOARDS` export kept | Task 11 |
| Credential badge + error banner + `az login` copy | Task 11 |
| App dropdown multi-select | Task 11 |
| Range auto-refetch | Task 11 |
| Empty state message | Task 11 |
| Status legend | Task 11 |
| Individual app error state | Task 5 + Task 10 |
| Downtime `ReferenceArea` in chart | Task 9 |

**Placeholder scan:** All tasks have complete code. No TBD or TODO left.

**Type consistency:**
- `MetricSeries`, `AppMetrics`, `InstanceInfo`, `IAzureMetricsAPI` defined in Task 2, used consistently throughout Tasks 3, 5, 8, 9, 10, 11.
- `summarize()` defined in Task 4, used in Task 5 — same module, no mismatch.
- `getStatus()` defined and exported in Task 10, tested in Task 10 — consistent.
- `CombinedChart` props use `MetricSeries` type directly — matches Task 2.
