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
  '24h': 'PT15M',
  '7d':  'PT1H',
};

// Raw ISO 8601 durations — avoids relying on Durations.* constants
// which are incomplete in @azure/monitor-query@1.3.3 (e.g. sixHours missing)
const DURATION_MAP = {
  '1h':  'PT1H',
  '6h':  'PT6H',
  '24h': 'P1D',
  '7d':  'P7D',
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

// ─── Azure SDK helpers ────────────────────────────────────────────────────────

async function getToken(credential) {
  const tokenResp = await credential.getToken('https://management.azure.com/.default');
  return tokenResp.token;
}

async function queryMetric(client, resId, metricName, range, granularity) {
  const result = await client.queryResource(resId, [metricName], {
    duration: DURATION_MAP[range] || DURATION_MAP['24h'],
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
  if (!planRes.ok) return { farmId, sku: '', cores: 1, memoryMB: 0 };
  const plan = await planRes.json();
  return {
    farmId,
    sku: plan.sku?.name || '',
    cores: plan.sku?.capacity || 1,
    memoryMB: plan.properties?.maximumElasticWorkerCount || 0,
  };
}

async function getResponseTime(client, resId, range, granularity) {
  try {
    const result = await client.queryResource(resId, ['HttpResponseTime'], {
      duration: DURATION_MAP[range] || DURATION_MAP['24h'],
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
  let rawSeries = [];

  if (appType === 'appservice') {
    try {
      const hc = await client.queryResource(resId, ['HealthCheckStatus'], {
        duration: DURATION_MAP[range] || DURATION_MAP['24h'],
        granularity,
        aggregations: ['Average'],
      });
      rawSeries = hc.metrics[0]?.timeseries?.[0]?.data || [];
    } catch {
      try {
        const [reqRes, errRes] = await Promise.all([
          client.queryResource(resId, ['Requests'], {
            duration: DURATION_MAP[range] || DURATION_MAP['24h'], granularity, aggregations: ['Total'],
          }),
          client.queryResource(resId, ['Http5xx'], {
            duration: DURATION_MAP[range] || DURATION_MAP['24h'], granularity, aggregations: ['Total'],
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
        duration: DURATION_MAP[range] || DURATION_MAP['24h'],
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

  // For App Service, CpuPercentage + MemoryPercentage live on the Plan resource
  // (Microsoft.Web/serverfarms), not the site. Fetch plan ID first.
  let metricsResId = resId;
  let plan = null;
  if (app.type === 'appservice') {
    plan = await getPlanInfo(token, resId);
    if (plan?.farmId) metricsResId = plan.farmId;
  }

  const [cpu, memory] = await Promise.all([
    queryMetric(client, metricsResId, 'CpuPercentage', range, gran),
    queryMetric(client, metricsResId, 'MemoryPercentage', range, gran),
  ]);

  const [instances, availability, responseTime] = await Promise.all([
    app.type === 'appservice' ? getInstances(token, resId) : getReplicas(token, resId),
    getAvailability(client, token, resId, app.type, range, gran),
    app.type === 'appservice' ? getResponseTime(client, resId, range, gran) : Promise.resolve(null),
  ]);

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
