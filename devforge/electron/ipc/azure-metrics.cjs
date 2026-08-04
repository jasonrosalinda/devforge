'use strict';

// ─── Per-app result cache ─────────────────────────────────────────────────────

const _fetchCache = new Map();
// Latency objective used when an app sets none. Mirrors DEFAULT_SLO_MS in
// src/types/settings.types.ts — the main process cannot import the TS module.
const DEFAULT_SLO_MS = 1000;

const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

function getCached(cacheKey) {
  const h = _fetchCache.get(cacheKey);
  return h && Date.now() < h.expiresAt ? h.data : null;
}

function setCached(cacheKey, data) {
  _fetchCache.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL });
}

// ─── Granularity / Duration maps ─────────────────────────────────────────────

const GRANULARITY_MAP = {
  '30m': 'PT5M',
  '1h':  'PT5M',
  '6h':  'PT15M',
  '12h': 'PT15M',
  '1d':  'PT15M',
  '3d':  'PT1H',
  '7d':  'PT1H',
  '30d': 'PT6H',
};

const DURATION_MAP = {
  '30m': 'PT30M',
  '1h':  'PT1H',
  '6h':  'PT6H',
  '12h': 'PT12H',
  '1d':  'P1D',
  '3d':  'P3D',
  '7d':  'P7D',
  '30d': 'P30D',
};

// ─── Exception bucket classifiers ────────────────────────────────────────────
// Shared with the incident report — see exception-buckets.cjs for the rules.
const {
  SOCKET_MATCH,
  TIMEOUT_ONLY_MATCH,
  OOM_ONLY_MATCH,
  GENERIC_MATCH,
  TIMEOUT_RESULT_CODES,
} = require('./exception-buckets.cjs');

// ─── Dependency classification ───────────────────────────────────────────────
// Static asset fetches — Blazor framework files and Razor class library content.
// They dominate a browser-side app's dependency list by volume while saying
// nothing about service health, so they get their own bucket instead of crowding
// out real calls in the internal / third-party top-10s.
// `contains`, not `has`: these are path fragments, not whole terms.
const ASSET_DEP_MATCH = '(name contains "_framework/" or name contains "_content/")';


// ─── Shared signal helpers ───────────────────────────────────────────────────
// Downtime detection and socket metric names live in azure-signals.cjs so the
// incident report detects outages with the same rules — see that file.
const {
  SOCKET_METRIC_NAMES,
  extractDowntimeIntervals,
  classifyDowntimeCause,
  extractDowntimeIntervalsMultiSignal,
} = require('./azure-signals.cjs');

// SNAT port charts come from the App Service detector API — see azure-snat.cjs.
const { fetchSnatCharts } = require('./azure-snat.cjs');
// Restart events — same detector plumbing, but per site rather than per plan.
const { fetchRestartCharts } = require('./azure-restarts.cjs');

// ─── Pure Helpers (exported for testing) ─────────────────────────────────────

function getGranularity(range) {
  return GRANULARITY_MAP[range] || 'PT1H';
}

function summarize(data) {
  if (!data || data.length === 0) return { avg: 0, max: 0, p99: 0, series: [] };
  const series = data.map(d => ({
    t: d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp),
    v: d.average ?? 0,
    m: d.maximum ?? 0,
  }));
  const avg = series.reduce((s, p) => s + p.v, 0) / series.length;
  const max = Math.max(...series.map(p => p.m));
  const sorted = [...series.map(p => p.v)].sort((a, b) => a - b);
  const p99 = sorted.length ? sorted[Math.ceil(sorted.length * 0.99) - 1] : 0;
  return {
    avg: Math.round(avg * 10) / 10,
    max: Math.round(max * 10) / 10,
    p99: Math.round(p99 * 100) / 100,
    series,
  };
}

function resourceId(subscriptionId, app) {
  if (app.type === 'appservice') {
    return `/subscriptions/${subscriptionId}/resourceGroups/${app.resourceGroup}/providers/Microsoft.Web/sites/${app.name}`;
  }
  return `/subscriptions/${subscriptionId}/resourceGroups/${app.resourceGroup}/providers/Microsoft.App/containerApps/${app.name}`;
}

function sqlDbResourceId(subscriptionId, app) {
  return `/subscriptions/${subscriptionId}/resourceGroups/${app.resourceGroup}` +
    `/providers/Microsoft.Sql/servers/${app.dbServerName}/databases/${app.dbName}`;
}

// Fetches the real hostnames (default + custom domains) bound to an App Service or Container App,
// so dependency `target` classification can match the app's actual domain, not just its Azure resource name.

// ─── Azure SDK helpers ────────────────────────────────────────────────────────

async function getToken(credential) {
  const tokenResp = await credential.getToken('https://management.azure.com/.default');
  return tokenResp.token;
}

function buildTimespan(range, customStart, customEnd) {
  if (customStart && customEnd) {
    return { startTime: new Date(customStart), endTime: new Date(customEnd) };
  }
  const endTime = new Date();
  const ms = {
    '30m': 30 * 60_000,
    '1h':   1 * 3_600_000,
    '6h':   6 * 3_600_000,
    '12h': 12 * 3_600_000,
    '1d':  24 * 3_600_000,
    '3d':  72 * 3_600_000,
    '7d': 168 * 3_600_000,
    '30d': 720 * 3_600_000,
  };
  const startTime = new Date(endTime.getTime() - (ms[range] || ms['1d']));
  return { startTime, endTime };
}

function isoGranToKql(gran) {
  const m = gran.match(/P(?:T)?(\d+)([MHD])/i);
  if (!m) return '5m';
  const unit = { M: 'm', H: 'h', D: 'd' }[m[2].toUpperCase()] ?? 'm';
  return `${m[1]}${unit}`;
}

function getCustomGranularity(customStart, customEnd) {
  const spanHours = (new Date(customEnd) - new Date(customStart)) / 3_600_000;
  if (spanHours <= 2)   return 'PT1M';
  if (spanHours <= 4)   return 'PT5M';
  if (spanHours <= 48)  return 'PT15M';
  if (spanHours <= 336) return 'PT1H';
  return 'PT6H';
}

async function queryMetric(client, resId, metricName, range, granularity, customStart, customEnd, divisor = 1) {
  const result = await client.queryResource(resId, [metricName], {
    timespan: buildTimespan(range, customStart, customEnd),
    granularity,
    aggregations: ['Average', 'Maximum'],
  });
  const data = result.metrics[0]?.timeseries?.[0]?.data || [];
  if (divisor === 1) return summarize(data);
  const scaled = data.map(d => ({
    ...d,
    average: d.average != null ? d.average / divisor : null,
    maximum: d.maximum != null ? d.maximum / divisor : null,
  }));
  return summarize(scaled);
}

async function getInstances(token, resId, range, gran, customStart, customEnd) {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetch(`https://management.azure.com${resId}/instances?api-version=2022-03-01`, { headers });
  if (!res.ok) return [];
  const data = await res.json();

  // Build timespan string for ARM metrics query
  const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
  const timespanStr = `${startTime.toISOString()}/${endTime.toISOString()}`;
  const interval = gran || 'PT5M';

  // healthPctMap: instance name → health % averaged across all buckets in the selected window
  const healthPctMap = {};
  try {
    const hcRes = await fetch(
      `https://management.azure.com${resId}/providers/microsoft.insights/metrics` +
      `?api-version=2023-10-01&metricnames=HealthCheckStatus` +
      `&timespan=${encodeURIComponent(timespanStr)}&interval=${encodeURIComponent(interval)}` +
      `&aggregation=average&$filter=Instance+eq+%27*%27`,
      { headers }
    );
    if (hcRes.ok) {
      const hd = await hcRes.json();
      const timeseries = hd?.value?.[0]?.timeseries ?? [];
      for (const ts of timeseries) {
        const key = ts.metadatavalues?.find(m => m.name?.value === 'instance')?.value?.toLowerCase() ?? '';
        if (!key) continue;
        const vals = (ts.data ?? []).map(d => d.average).filter(v => v != null);
        if (vals.length) {
          const avgHealth = vals.reduce((s, v) => s + v, 0) / vals.length;
          healthPctMap[key] = Math.round(avgHealth * 1000) / 10; // 0–100 %
        }
      }
    }
  } catch { /* ignore */ }

  const seen = new Set();
  const result = [];
  for (const i of (data.value || [])) {
    const props = i.properties ?? {};
    const machineName = props.machineName || i.name || '';
    if (!machineName || seen.has(machineName.toLowerCase())) continue;
    seen.add(machineName.toLowerCase());
    const zone = props.physicalZone || props.availabilityZone || '';
    const state = props.state || '';
    const key = (i.name?.toLowerCase() ?? '');
    const keyMachine = machineName.toLowerCase();
    const healthPct = healthPctMap[key] ?? healthPctMap[keyMachine] ?? null;
    const healthStatus = healthPct != null
      ? (healthPct >= 90 ? 'Healthy' : healthPct >= 50 ? 'Degraded' : 'Unhealthy')
      : (state === 'READY' ? 'Healthy' : state === 'STOPPED' ? 'Stopped' : 'Unknown');
    result.push({ name: machineName, zone, healthStatus, healthPct });
  }
  return result;
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
    healthPct: null,
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

async function queryCountMetrics(client, resId, metricNames, range, granularity, customStart, customEnd) {
  const ts = buildTimespan(range, customStart, customEnd);
  let total = 0;
  await Promise.all(metricNames.map(async (name) => {
    try {
      const result = await client.queryResource(resId, [name], { timespan: ts, granularity, aggregations: ['Total'] });
      const data = result.metrics[0]?.timeseries?.[0]?.data || [];
      total += data.reduce((sum, d) => sum + (d.total ?? 0), 0);
    } catch { /* ignore missing metric */ }
  }));
  return { total: Math.round(total) };
}

async function getInstanceHealthSeries(client, resId, range, granularity, customStart, customEnd) {
  const ts = buildTimespan(range, customStart, customEnd);
  try {
    const [reqRes, errRes] = await Promise.all([
      client.queryResource(resId, ['Requests'], {
        timespan: ts, granularity, aggregations: ['Total'],
        filter: "Instance ne 'N/A'",
      }),
      client.queryResource(resId, ['Http5xx'], {
        timespan: ts, granularity, aggregations: ['Total'],
        filter: "Instance ne 'N/A'",
      }),
    ]);

    const reqSeries = reqRes.metrics[0]?.timeseries || [];
    const errSeries = errRes.metrics[0]?.timeseries || [];
if (!reqSeries.length) return null;

    // Build 5xx map: instance -> timestamp -> count
    const errMap = new Map();
    for (const ts_ of errSeries) {
      const name = ts_.metadataValues?.find(m => (m.name?.value ?? m.name)?.toLowerCase() === 'instance')?.value ?? 'unknown';
      const byTime = new Map();
      for (const d of ts_.data || []) {
        const t = d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp);
        byTime.set(t, d.total ?? 0);
      }
      errMap.set(name, byTime);
    }

    return reqSeries.map(ts_ => {
      const name = ts_.metadataValues?.find(m => (m.name?.value ?? m.name)?.toLowerCase() === 'instance')?.value ?? 'unknown';
      const errByTime = errMap.get(name) ?? new Map();
      // Buckets with no requests are OMITTED, not scored 100%.
      //
      // Azure returns a data point for every bucket in the timespan for each
      // instance dimension, with `total` absent where the instance served nothing —
      // including every bucket before it was created. Scoring those 100% made all
      // instances look like they existed for the whole window (so scale-out was
      // invisible and first-seen was always the range start), inflated the average
      // for short-lived instances, and — worst — let an instance that was DOWN and
      // therefore serving no traffic read as perfectly healthy.
      //
      // No requests means no request-derived health signal. A gap is the honest
      // answer; the ARM instance list still reports that the instance exists.
      const series = [];
      for (const d of ts_.data || []) {
        const total = d.total ?? 0;
        if (total <= 0) continue;
        const t = d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp);
        const failed = errByTime.get(t) ?? 0;
        series.push({ t, v: Math.round((total - failed) / total * 1000) / 10 });
      }
      return { name, series };
    });
  } catch { return null; }
}

async function getInstanceProbeSeries(client, resId, range, granularity, customStart, customEnd) {
  try {
    const result = await client.queryResource(resId, ['HealthCheckStatus'], {
      timespan: buildTimespan(range, customStart, customEnd),
      granularity,
      aggregations: ['Average'],
      filter: "Instance ne 'N/A'",
    });
    const timeseries = result.metrics[0]?.timeseries || [];
    if (!timeseries.length) return null;
    return timeseries.map(ts => {
      const name = ts.metadataValues?.find(m => (m.name?.value ?? m.name)?.toLowerCase() === 'instance')?.value ?? 'unknown';
      const series = (ts.data || []).map(d => ({
        t: d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp),
        v: Math.round((d.average ?? 100) * 10) / 10,
      }));
      return { name, series };
    });
  } catch { return null; }
}


async function queryCountSeries(client, resId, metricName, range, granularity, customStart, customEnd) {
  try {
    const ts = buildTimespan(range, customStart, customEnd);
    const result = await client.queryResource(resId, [metricName], { timespan: ts, granularity, aggregations: ['Total'] });
    const data = result.metrics[0]?.timeseries?.[0]?.data || [];
    return data.map(d => ({
      t: d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp),
      count: Math.round(d.total ?? 0),
    }));
  } catch { return null; }
}

async function queryFailedRequestsSeries(client, resId, range, granularity, customStart, customEnd) {
  return queryCountSeries(client, resId, 'Http5xx', range, granularity, customStart, customEnd);
}

async function getAvailabilityFromAppInsights(appId, credential, range, granularity, customStart, customEnd) {
  try {
    const aiToken = await credential.getToken('https://api.applicationinsights.io/.default');
    const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
    const granMins = granularity === 'PT5M' ? 5 : granularity === 'PT15M' ? 15 : granularity === 'PT1H' ? 60 : 5;
    // Chart series: same granularity as main metrics for consistent x-axis
    const chartQuery = `requests | summarize total=count(), errors=countif(toint(resultCode) >= 500) by bin(timestamp,${granMins}m) | extend average=iif(total>0, todouble(total-errors)/todouble(total)*100.0, 100.0) | project timeStamp=timestamp, average | order by timeStamp asc`;
    // Interval detection: 1-min resolution for accurate timestamps
    const intervalQuery = `requests | summarize total=count(), errors=countif(toint(resultCode) >= 500) by bin(timestamp,1m) | where total > 0 | extend average=iif(todouble(errors)/todouble(total)*100>=50, 0.0, 100.0) | project timeStamp=timestamp, average | order by timeStamp asc`;
    const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
    const [chartRes, intervalRes] = await Promise.all([
      fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aiToken.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: chartQuery, timespan }),
      }),
      fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${aiToken.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: intervalQuery, timespan }),
      }),
    ]);
    if (!chartRes.ok) return null;
    const chartData = await chartRes.json();
    const chartRows = chartData.tables?.[0]?.rows || [];
    if (!chartRows.length) return null;
    const chartSeries = chartRows.map(([ts, avg]) => ({ timeStamp: new Date(ts), average: Number(avg) }));

    let downtimeIntervals = [];
    if (intervalRes.ok) {
      const intervalData = await intervalRes.json();
      const intervalRows = intervalData.tables?.[0]?.rows || [];
      if (intervalRows.length) {
        const intervalSeries = intervalRows.map(([ts, avg]) => ({ timeStamp: new Date(ts), average: Number(avg) }));
        downtimeIntervals = extractDowntimeIntervals(intervalSeries);
      }
    }
    return { chartSeries, downtimeIntervals };
  } catch { return null; }
}

/**
 * App Insights: failed requests per instance per minute.
 * Returns flat array {t, instance, count} — 1-min resolution.
 * Used as high-fidelity replacement for Azure Monitor Http5xx series.
 */
async function getFailedRequestsByInstance(appId, credential, range, customStart, customEnd) {
  try {
    const aiToken = await credential.getToken('https://api.applicationinsights.io/.default');
    const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
    const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
    const query = `requests
| summarize total=count(), failedCount=countif(success==false) by cloud_RoleInstance, cloud_RoleName, bin(timestamp, 1m)
| extend healthPct=iif(total>0, round(todouble(total-failedCount)/todouble(total)*100.0, 1), 100.0)
| project timestamp, cloud_RoleInstance, cloud_RoleName, total, failedCount, healthPct
| order by timestamp asc`;
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = data.tables?.[0]?.rows || [];
    // rows: [timestamp, cloud_RoleInstance, cloud_RoleName, total, failedCount, healthPct]
    return rows.map(([ts, instance, roleName, total, failedCount, healthPct]) => ({
      t:          new Date(ts).toISOString(),
      instance:   instance ?? 'unknown',
      roleName:   roleName ?? null,
      count:      Number(failedCount) || 0,
      totalCount: Number(total) || 0,
      healthPct:  Math.round(Number(healthPct) * 10) / 10,
    }));
  } catch { return null; }
}

async function getContainerAppTimeSeries(appId, credential, range, customStart, customEnd, gran) {
  try {
    const aiToken = (await credential.getToken('https://api.applicationinsights.io/.default')).token;
    const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
    const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
    const bin = isoGranToKql(gran);
    const headers = { Authorization: `Bearer ${aiToken}`, 'Content-Type': 'application/json' };
    const endpoint = `https://api.applicationinsights.io/v1/apps/${appId}/query`;
    // Response time is no longer read from here: it comes from the per-site
    // response breakdown in getRequestInsights, which Container Apps get too.
    const queries = [
      `requests | summarize count=count() by bin(timestamp, ${bin}) | order by timestamp asc`,
      `requests | where toint(resultCode) >= 400 and toint(resultCode) < 500 | summarize count=count() by bin(timestamp, ${bin}) | order by timestamp asc`,
    ];
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: queries.join(';\n'), timespan }) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    const tables = data.tables || [];
    const reqRows  = tables[0]?.rows ?? [];
    const h4xRows  = tables[1]?.rows ?? [];
    const requestsSeries = reqRows.map(([t, count]) => ({ t: new Date(t).toISOString(), count: Number(count) }));
    const http4xxSeries  = h4xRows.map(([t, count]) => ({ t: new Date(t).toISOString(), count: Number(count) }));
    return { requestsSeries, http4xxSeries };
  } catch { return null; }
}

// getUserStats lived here: distinct clients per bucket, frontend only, its own HTTP
// call. It is now Group F inside getRequestInsights, which runs per App Insights
// resource — so the API gets the same figures instead of none, at no extra round trip.

/**
 * The downstream calls made by one endpoint, ranked by the time they cost it.
 *
 * Ranked by total time (calls x average), not by the worst single call: a 38ms query run
 * 750 times costs the endpoint more than one 2s outlier, and it is the row worth acting on.
 *
 * `count()` rather than `sum(itemCount)`, matching the app-wide Dependencies row — under
 * adaptive sampling both undercount equally, but this way a per-endpoint figure can never
 * exceed the app-wide total it is a part of, which is the confusing failure.
 */
/** How many of an endpoint's calls get a timeline. The rest still list, just unplottable. */
const TIMELINE_DEPS = 8;

/**
 * Bucket width for a dependency timeline, sized so any window yields ~120 buckets.
 *
 * Mirrors the request timelines' `topUrlBin` rather than reusing it — that one is computed
 * inside getRequestInsights, and this runs in its own handler.
 */
function depTimelineBin(range, customStart, customEnd) {
  const msMap = { '30m': 30*60e3, '1h': 3600e3, '6h': 6*3600e3, '12h': 12*3600e3, '1d': 24*3600e3, '3d': 72*3600e3, '7d': 168*3600e3, '30d': 720*3600e3 };
  const spanMs = customStart && customEnd ? new Date(customEnd) - new Date(customStart) : (msMap[range] || msMap['1d']);
  const spanMins = spanMs / 60000;
  return spanMins <= 120   ? '1m'
       : spanMins <= 600   ? '5m'
       : spanMins <= 1800  ? '15m'
       : spanMins <= 7200  ? '1h'
       : spanMins <= 43200 ? '6h'
       : '1d';
}

async function fetchEndpointDetail(appId, credential, endpoint, range, customStart, customEnd) {
  let aiToken;
  try {
    aiToken = (await credential.getToken('https://api.applicationinsights.io/.default')).token;
  } catch (e) {
    return { series: null, deps: null, error: `Token error: ${e.message}` };
  }

  const timespanMap = { '30m':'PT30M','1h':'PT1H','6h':'PT6H','12h':'PT12H','1d':'P1D','3d':'P3D','7d':'P7D','30d':'P30D' };
  const timespan = customStart && customEnd
    ? `${new Date(customStart).toISOString()}/${new Date(customEnd).toISOString()}`
    : (timespanMap[range] || 'P1D');

  // The endpoint is a literal, so it is escaped rather than interpolated raw — an
  // endpoint name carrying a quote would otherwise change the shape of the query.
  const runQuery = async (query) => {
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${txt}`.slice(0, 300));
    }
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return data.tables?.[0]?.rows ?? [];
  };

  // A dependency is only identified by all three of type, target and name together — two
  // targets commonly serve a call of the same name, and charting them as one would merge
  // a healthy database with a failing one.
  const depKeyExpr = 'strcat(type, "|", target, "|", name)';
  const opClean = `extend opClean=iif(operation_Name has "?", substring(operation_Name, 0, indexof(operation_Name, "?")), operation_Name)`;
  const forEndpoint = `dependencies | ${opClean} | where opClean == "${kqlLit(endpoint)}"`;
  const bin = depTimelineBin(range, customStart, customEnd);

  try {
    // The endpoint's own request timeline. Fetched here, per endpoint, rather than for every
    // merged endpoint inside the details batch: the chart only ever shows one at a time, so
    // the batch version was shipping ~60 timelines to draw one — the single largest thing in
    // that payload, and it had to be parsed and held in state for every card.
    const reqSeriesRows = await runQuery(
      `requests | extend rc=toint(resultCode) | ${NAME_CLEAN_EXPR} ` +
      `| where nameClean == "${kqlLit(endpoint)}" ` +
      `| summarize count=count(), c4=countif(${RC_4XX_EXPR}), c5=countif(${RC_5XX_EXPR}), ` +
        `avgMs=round(avg(duration),1), p95=round(percentile(duration,95),1) by bin(timestamp, ${bin}) ` +
      `| project t=timestamp, count, c4, c5, avgMs, p95 | order by t asc`);
    const series = reqSeriesRows.map(([t, count, c4, c5, avgMs, p95]) => ({
      t: String(t ?? ''),
      count: Number(count) || 0, c4: Number(c4) || 0, c5: Number(c5) || 0,
      avgMs: Number(avgMs) || 0, p95: Number(p95) || 0,
    }));

    const rows = await runQuery(
      `${forEndpoint} ` +
      `| summarize count=count(), failCount=countif(success == false), avgMs=round(avg(duration),1), ` +
        `p95=round(percentile(duration,95),1), totalMs=round(sum(duration),0) by type, target, name ` +
      `| order by totalMs desc | take 20`);

    const deps = rows.map(([type, target, name, count, failCount, avgMs, p95, totalMs]) => ({
      type: String(type ?? ''), target: String(target ?? ''), name: String(name ?? '') || '(unnamed)',
      count: Number(count) || 0, failCount: Number(failCount) || 0,
      avgMs: Number(avgMs) || 0, p95: Number(p95) || 0, totalMs: Number(totalMs) || 0,
    }));
    if (!deps.length) return { series, deps, bin };

    // Timelines for the costliest calls only. The filter is built from the rows just
    // returned rather than re-ranking in KQL, so a charted line always belongs to a row
    // that exists — a second `top` could disagree with the first on a tie.
    const charted = deps.slice(0, TIMELINE_DEPS);
    const keyOf = (d) => `${d.type}|${d.target}|${d.name}`;
    const keyList = charted.map(d => `"${kqlLit(keyOf(d))}"`).join(', ');

    let seriesRows = [];
    try {
      seriesRows = await runQuery(
        `${forEndpoint} | extend depKey=${depKeyExpr} | where depKey in (${keyList}) ` +
        `| summarize count=count(), failCount=countif(success == false), avgMs=round(avg(duration),1), ` +
          `p95=round(percentile(duration,95),1) by bin(timestamp, ${bin}), depKey ` +
        `| project t=timestamp, depKey, count, failCount, avgMs, p95 | order by t asc`);
    } catch {
      // The list is the useful part and it already succeeded. A timeline failure leaves
      // rows unplottable rather than failing the whole block.
      seriesRows = [];
    }

    const byKey = new Map();
    for (const row of seriesRows) {
      if (!Array.isArray(row)) continue;
      const [t, depKey, count, failCount, avgMs, p95] = row;
      const key = String(depKey ?? '');
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({
        t: String(t ?? ''),
        count: Number(count) || 0, failCount: Number(failCount) || 0,
        avgMs: Number(avgMs) || 0, p95: Number(p95) || 0,
      });
    }
    for (const d of deps) {
      const pts = byKey.get(keyOf(d));
      if (pts) d.series = pts.sort((a, b) => a.t.localeCompare(b.t));
    }

    return { series, deps, bin };
  } catch (e) {
    return { series: null, deps: null, error: e.message || String(e) };
  }
}

/** Query string stripped, so '/order?id=1' and '/order?id=2' are one endpoint. */
const NAME_CLEAN_EXPR = `extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)`;

// The status-class predicates as bare boolean expressions, so a `where` filter and a
// `countif` aggregate can never disagree on what counts as a 4xx or a 5xx. A 5xx includes
// failures with no usable result code: a request killed mid-flight reports success == false
// with an empty code, and dropping those undercounts every outage.
const RC_4XX_EXPR = `rc >= 400 and rc < 500`;
const RC_5XX_EXPR = `rc >= 500 or (success == false and (isempty(resultCode) or rc == 0 or isnull(rc)))`;

function kqlLit(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}



async function getAvailabilityFromAzureMonitor(client, resId, appType, granularity, ts) {
  if (appType === 'appservice') {
    try {
      const hc = await client.queryResource(resId, ['HealthCheckStatus'], {
        timespan: ts, granularity, aggregations: ['Average'],
      });
      const data = hc.metrics[0]?.timeseries?.[0]?.data || [];
      if (data.length) return data;
    } catch {}
    try {
      const [reqRes, errRes] = await Promise.all([
        client.queryResource(resId, ['Requests'], { timespan: ts, granularity, aggregations: ['Total'] }),
        client.queryResource(resId, ['Http5xx'],  { timespan: ts, granularity, aggregations: ['Total'] }),
      ]);
      const reqData = reqRes.metrics[0]?.timeseries?.[0]?.data || [];
      const errData = errRes.metrics[0]?.timeseries?.[0]?.data || [];
      if (reqData.length) return reqData.map((r, i) => ({
        timeStamp: r.timeStamp,
        average: (r.total ?? 0) > 0 ? (1 - (errData[i]?.total ?? 0) / r.total) * 100 : 100,
      }));
    } catch {}
    return [];
  } else {
    try {
      const rr = await client.queryResource(resId, ['RunningReplicas'], {
        timespan: ts, granularity, aggregations: ['Average'],
      });
      return (rr.metrics[0]?.timeseries?.[0]?.data || []).map(d => ({
        timeStamp: d.timeStamp,
        average: (d.average ?? 0) > 0 ? 100 : 0,
      }));
    } catch { return []; }
  }
}

async function getAvailability(client, token, resId, appType, range, granularity, customStart, customEnd, aiAppId, credential) {
  const ts = buildTimespan(range, customStart, customEnd);
  const granMins = granularity === 'PT5M' ? 5 : granularity === 'PT15M' ? 15 : granularity === 'PT1H' ? 60 : 360;

  const rawSeries = await getAvailabilityFromAzureMonitor(client, resId, appType, granularity, ts);
  if (!rawSeries.length) return null;

  const settledSeries = rawSeries.length > 2 ? rawSeries.slice(0, -2) : rawSeries;
  const downPts = settledSeries.filter(d => (d.average ?? 100) < 95).length;
  const downtimeMins = downPts * granMins;
  const pct = Math.round((1 - downPts / settledSeries.length) * 1000) / 10;
  const series = rawSeries.map(d => ({
    t: d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp),
    v: Math.round((d.average ?? 100) * 10) / 10,
  }));

  // Use App Insights for accurate interval timestamps when configured
  let downtimeIntervals = extractDowntimeIntervals(settledSeries);
  if (aiAppId && credential && downtimeIntervals.length) {
    const ai = await getAvailabilityFromAppInsights(aiAppId, credential, range, granularity, customStart, customEnd);
    if (ai && ai.downtimeIntervals.length) downtimeIntervals = ai.downtimeIntervals;
  }

  return { pct, downtimeMins, incidents: downtimeIntervals.length, downtimeIntervals, series };
}

async function findAppInsightsAppId(token, subscriptionId, resourceGroup, appName) {
  try {
    // 1. Try reading app settings for instrumentation key
    let ikey = null;
    try {
      const settingsRes = await fetch(
        `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${appName}/config/appsettings/list?api-version=2022-03-01`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' }
      );
      if (settingsRes.ok) {
        const { properties = {} } = await settingsRes.json();
        ikey = properties['APPINSIGHTS_INSTRUMENTATIONKEY'];
        if (!ikey) {
          const m = (properties['APPLICATIONINSIGHTS_CONNECTION_STRING'] || '').match(/InstrumentationKey=([^;]+)/i);
          if (m) ikey = m[1];
        }
      }
    } catch { /* continue */ }

    // 2. List all App Insights in subscription
    const componentsRes = await fetch(
      `https://management.azure.com/subscriptions/${subscriptionId}/providers/microsoft.insights/components?api-version=2020-02-02`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!componentsRes.ok) return null;
    const { value = [] } = await componentsRes.json();

    // Match by instrumentation key first, then by name (prefer same resource group)
    let component = ikey
      ? value.find(c => c.properties?.InstrumentationKey?.toLowerCase() === ikey.toLowerCase())
      : null;
    if (!component) {
      const rgLower = resourceGroup.toLowerCase();
      component = value.find(c =>
        c.name?.toLowerCase() === appName.toLowerCase() &&
        c.id?.toLowerCase().includes(`/resourcegroups/${rgLower}/`)
      ) || value.find(c => c.name?.toLowerCase() === appName.toLowerCase());
    }
    return component ? component.properties.AppId : null;
  } catch { return null; }
}

/**
 * Flat `[t, url, count]` rows from the per-endpoint timeline query → one series per
 * endpoint. Buckets with no traffic are simply absent rather than zero-filled: the
 * chart draws them as gaps (connectNulls={false}), which reads as "no requests in
 * this bucket" instead of implying the endpoint returned zero.
 */
function groupUrlSeries(rows) {
  const byUrl = new Map();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const [t, url, count] = row;
    const key = String(url ?? '(unknown)');
    let entry = byUrl.get(key);
    if (!entry) { entry = { url: key, total: 0, series: [] }; byUrl.set(key, entry); }
    const n = Number(count) || 0;
    entry.total += n;
    entry.series.push({ t: String(t ?? ''), count: n });
  }
  return [...byUrl.values()]
    .sort((a, b) => b.total - a.total)
    .map(({ url, series }) => ({ url, series: series.sort((a, b) => a.t.localeCompare(b.t)) }));
}


async function getRequestInsights(appId, credential, range, customStart, customEnd, summaryOnly = false, sloMs = DEFAULT_SLO_MS) {
  const msMap = { '30m': 30*60e3, '1h': 3600e3, '6h': 6*3600e3, '12h': 12*3600e3, '1d': 24*3600e3, '3d': 72*3600e3, '7d': 168*3600e3, '30d': 720*3600e3 };
  const spanMs = customStart && customEnd ? new Date(customEnd) - new Date(customStart) : (msMap[range] || msMap['1d']);
  const spanMins = spanMs / 60000;
  const timespanMap = { '30m':'PT30M','1h':'PT1H','6h':'PT6H','12h':'PT12H','1d':'P1D','3d':'P3D','7d':'P7D','30d':'P30D' };
  const timespan = customStart && customEnd
    ? `${new Date(customStart).toISOString()}/${new Date(customEnd).toISOString()}`
    : (timespanMap[range] || 'P1D');

  let aiToken;
  try {
    aiToken = (await credential.getToken('https://api.applicationinsights.io/.default')).token;
  } catch (e) {
    return { error: `Token error: ${e.message}` };
  }

  const headers = { Authorization: `Bearer ${aiToken}`, 'Content-Type': 'application/json' };
  const endpoint = `https://api.applicationinsights.io/v1/apps/${appId}/query`;

  async function runQuery(query) {
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query, timespan }) });
      if (!res.ok) { const t = await res.text().catch(() => ''); return { error: `${res.status}: ${t}` }; }
      const data = await res.json();
      if (data.error) return { error: data.error.message || JSON.stringify(data.error) };
      return data.tables?.[0]?.rows || [];
    } catch (e) { return { error: e.message }; }
  }

  const rpm = (n) => Math.round((n / spanMins) * 100) / 100;

  async function runQueryFull(query) {
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query, timespan }) });
      if (!res.ok) { const t = await res.text().catch(() => ''); return { error: `${res.status}: ${t}` }; }
      const data = await res.json();
      if (data.error) return { error: data.error.message || JSON.stringify(data.error) };
      const table = data.tables?.[0];
      return { columns: table?.columns?.map(c => c.name) ?? [], rows: table?.rows ?? [] };
    } catch (e) { return { error: e.message }; }
  }

  // Batch multiple KQL statements into one HTTP call.
  // App Insights returns tables[0..N] matching statement order.
  async function runBatch(queries) {
    const combined = queries.join(';\n');
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: combined, timespan }) });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return queries.map(() => ({ error: `${res.status}: ${txt}` }));
      }
      const data = await res.json();
      if (data.error) return queries.map(() => ({ error: data.error.message || JSON.stringify(data.error) }));
      const tables = data.tables || [];
      return tables.map(t => t?.rows || []);
    } catch (e) {
      return queries.map(() => ({ error: e.message }));
    }
  }

  const insightKql = `let deps=dependencies|summarize TotalDependencies=count(),FailedDependencies=countif(success==false),DependencyFailureRate=todouble(countif(success==false))/count()*100,DependencyP95=percentile(duration,95),DependencyP99=percentile(duration,99);let reqs=requests|summarize TotalRequests=count(),FailedRequests=countif(success==false),RequestFailureRate=todouble(countif(success==false))/count()*100,RequestP95=percentile(duration,95),RequestP99=percentile(duration,99);let ex=exceptions|summarize SocketLayerExceptions=sumif(itemCount,${SOCKET_MATCH}),TimeoutExceptions=sumif(itemCount,${TIMEOUT_ONLY_MATCH}),OomExceptions=sumif(itemCount,${OOM_ONLY_MATCH}),GenericExceptions=sumif(itemCount,${GENERIC_MATCH}),TotalExceptions=sum(itemCount);let users=requests|extend dimIp=tostring(customDimensions["Client IP Address"])|extend ip=iff(isnotempty(dimIp) and dimIp != "::1", dimIp, iff(isnotempty(client_IP) and client_IP != "::1", client_IP, ""))|where isnotempty(ip)|summarize UniqueUsers=dcount(ip);deps|extend JoinKey=1|join kind=inner(reqs|extend JoinKey=1) on JoinKey|join kind=inner(ex|extend JoinKey=1) on JoinKey|join kind=inner(users|extend JoinKey=1) on JoinKey|project-away JoinKey,JoinKey1,JoinKey2|extend IncidentSummary=case(DependencyFailureRate>15 and DependencyP99>15000 and SocketLayerExceptions>0,"Critical: Severe dependency degradation with SNAT/socket exhaustion. Connections are being rejected at the network layer. Immediate action required.",DependencyFailureRate>10 and SocketLayerExceptions>0,"High: Elevated dependency failures combined with socket pressure. Likely SNAT port depletion or connection pool saturation causing fast-fail rejections.",DependencyFailureRate>15 and DependencyP99>10000,"High: Severe dependency latency and high failure rate. Downstream services are degraded — check DB, cache, and external API health.",DependencyFailureRate>10 and DependencyP99>8000,"Elevated dependency failures with significant latency spikes. Downstream services intermittently unresponsive — possible connection exhaustion or resource contention.",RequestP99>60000 and RequestFailureRate<5,"Warning: Extreme request latency (P99 > 1 min) with low failure rate. App is serving requests but resource saturation is causing severe queuing — possible CPU/memory pressure or slow dependency.",RequestP99>30000,"Warning: Severe request latency detected (P99 > 30s). Likely intermittent outages or resource saturation impacting tail requests.",DependencyFailureRate>5 and DependencyP95>5000,"Warning: Partial dependency degradation with elevated latency and intermittent failures. Downstream services are slow — investigate DB query performance or external API timeouts.",DependencyFailureRate>5,"Warning: Elevated dependency failure rate without major latency spike. Dependencies are rejecting connections quickly — possible quota exhaustion, misconfiguration, or fast-fail circuit breaker.",RequestP95>3000 and RequestFailureRate<2,"Info: Performance degradation with elevated response latency but low failure rates. App is under load — monitor for worsening.",RequestFailureRate>20,"Critical: Major application failure with high request failure rate. Immediate investigation required.",RequestFailureRate>5,"Warning: Elevated request failure rate. Application is returning errors — check exception logs and dependency health.","No significant degradation pattern detected in the selected time range.")`;

  // Group A: request/dependency-based (8 queries → 1 HTTP call)
  // Bucket width for the per-endpoint timelines (groupA[11..13]). Sized so any
  // window yields ~120 buckets per endpoint: ten endpoints × 1440 one-minute
  // buckets would put 14k rows on the wire for a single day.
  const topUrlBin = spanMins <= 120   ? '1m'
                  : spanMins <= 600   ? '5m'
                  : spanMins <= 1800  ? '15m'
                  : spanMins <= 7200  ? '1h'
                  : spanMins <= 43200 ? '6h'
                  : '1d';
  // Shared by each failure list and its matching timeline. Held in one place because
  // the timeline is only meaningful if it selects exactly the endpoints the list
  // ranks — a predicate that drifts between the two silently plots the wrong set.
  const nameCleanExpr = NAME_CLEAN_EXPR;
  const rc4xxExpr = RC_4XX_EXPR;
  const rc5xxExpr = RC_5XX_EXPR;
  const is4xx = `extend rc=toint(resultCode) | where ${rc4xxExpr}`;
  const is5xx = `extend rc=toint(resultCode) | where ${rc5xxExpr}`;
  const groupAKqls = [
    `requests | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | where success == false | summarize failCount=count(), p95=percentile(duration,95), p99=percentile(duration,99) by nameClean | join kind=leftouter (requests | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize totalCount=count() by nameClean) on nameClean | project url=nameClean, totalCount=coalesce(totalCount,failCount), failCount, p95, p99 | order by failCount desc | take 10`,
    `requests | summarize avgMs=avg(duration), p99Ms=percentile(duration,99), maxMs=max(duration), n=count() by name | top 10 by maxMs desc | project url=name, avgMs=round(avgMs,1), p99Ms=round(p99Ms,1), maxMs=round(maxMs,1), count=n`,
    `requests | ${is4xx} | count`,
    `requests | ${is5xx} | count`,
    `exceptions | summarize count=count() by type | order by count desc | take 10`,
    `exceptions | project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack=tostring(details[0].parsedStack) | top 50 by timestamp desc`,
    `dependencies | where success == false | where resultCode in (${TIMEOUT_RESULT_CODES}) | extend nameClean = iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize timeoutCount=sum(itemCount), p95=round(percentile(duration,95),0), maxMs=round(max(duration),0) by nameClean, resultCode, type | project name=nameClean, resultCode, type, p95, maxMs, timeoutCount | order by timeoutCount desc | take 15`,
  ];

  // Who counts as a distinct client. App Insights records the caller in two places and
  // neither is reliable alone: `customDimensions["Client IP Address"]` is set when the
  // app forwards it, `client_IP` is Azure's own view. '::1' is the loopback a warm-up
  // ping arrives as, and counting it would put one fake user in every bucket.
  //
  // Held in one const because "unique users", "top clients" and the Group B ranking all
  // have to agree on it — a definition that drifts between them produces a top-10 list
  // whose counts cannot be reconciled with the unique-user line above it.
  const clientIpExpr =
    `extend dimIp=tostring(customDimensions["Client IP Address"]) ` +
    `| extend ip=iff(isnotempty(dimIp) and dimIp != "::1", dimIp, iff(isnotempty(client_IP) and client_IP != "::1", client_IP, "")) ` +
    `| where isnotempty(ip)`;

  // Where the caller's user agent lives. App Insights spells the header three ways
  // depending on SDK version and falls back to its own parsed `client_Browser`, so all
  // four are tried in order. Hoisted for the same reason as clientIpExpr: the top-agent
  // ranking, the bot filter and the per-client agent list have to agree on it, or a
  // client's agents cannot be reconciled with the agent list beside them.
  const clientUaExpr =
    `extend ua=coalesce(tostring(customDimensions["User-Agent"]), tostring(customDimensions["user-agent"]), tostring(customDimensions["http.user_agent"]), client_Browser)`;

  // Group B: client-based + SNAT + SQL/HTTP timeouts (6 queries → 1 HTTP call)
  const groupBKqls = [
    `requests | ${clientUaExpr} | where isnotempty(ua) | summarize n=count() by ua | top 10 by n desc | project userAgent=ua, count=n, rpm=round(todouble(n)/${spanMins},2)`,
    `requests | ${clientUaExpr} | where isnotempty(ua) and (ua contains "bot" or ua contains "crawl" or ua contains "spider" or ua contains "facebookexternalhit" or ua contains "Scrapy" or ua contains "python-requests" or ua contains "Go-http" or ua contains "curl" or ua contains "wget" or ua contains "HeadlessChrome" or ua contains "PhantomJS") | summarize n=count() by ua | top 10 by n desc | project userAgent=ua, count=n, rpm=round(todouble(n)/${spanMins},2)`,
    // High-frequency bursts identify by IP OR agent, unlike clientIpExpr which requires
    // an IP — a caller Azure could not resolve an address for is still a burst worth
    // seeing, so this one falls back to the agent as the identifier.
    `requests | ${clientUaExpr} | extend dimIp=tostring(customDimensions["Client IP Address"]) | extend rawIp=iff(isnotempty(dimIp) and dimIp != "::1", dimIp, iff(isnotempty(client_IP) and client_IP != "::1", client_IP, "")) | extend identifier=iff(isempty(rawIp), ua, rawIp) | where isnotempty(identifier) | summarize requestCount=count() by bin(timestamp,1m), identifier, client_CountryOrRegion, ua | summarize totalCount=sum(requestCount), peakRpm=max(requestCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by identifier, client_CountryOrRegion, ua | where peakRpm > 5 | top 5 by totalCount desc | project timestamp=firstSeen, lastSeen, ip=identifier, country=client_CountryOrRegion, userAgent=ua, count=totalCount, rpm=todouble(peakRpm)`,
    `exceptions | where outerMessage has_any ("SocketException","No buffer space available","ENOBUFS","actively refused","Connection refused","timed out","ETIMEDOUT","SNAT") | project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, innermostType, innermostMethod, parsedStack=tostring(details[0].parsedStack) | top 50 by timestamp desc`,
    `exceptions | where outerMessage has_any ("timeout","Timeout","timed out","SqlException","SqlTimeout","TaskCanceledException","HttpRequestException","TimeoutException") | where not(outerMessage has_any ("SocketException","ENOBUFS","No buffer space available","actively refused","Connection refused","ETIMEDOUT","SNAT")) | project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, innermostType, innermostMethod, parsedStack=tostring(details[0].parsedStack) | top 50 by timestamp desc`,
  ];

  // Group C: socket-exception deep dive + socket-excluded generic exceptions
  // (8 queries → 1 HTTP call). Kept in its own batch so a failure here (e.g. an
  // unsupported column) cannot take down groups A/B.
  const socketBin = spanMins <= 60 ? '1m' : spanMins <= 360 ? '5m' : spanMins <= 1440 ? '15m' : spanMins <= 10080 ? '1h' : '6h';
  const socketProject = `project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, cloud_RoleInstance, innermostType, innermostMethod, operation_Id, itemCount, parsedStack=tostring(details[0].parsedStack)`;
  const groupCKqls = [
    // C0 — totals. trueCount uses sum(itemCount) so ingestion sampling does not undercount.
    `exceptions | where ${SOCKET_MATCH} | summarize records=count(), trueCount=sum(itemCount), instances=dcount(cloud_RoleInstance), operations=dcount(operation_Name), firstSeen=min(timestamp), lastSeen=max(timestamp)`,
    // C1 — which exception type / client library
    `exceptions | where ${SOCKET_MATCH} | extend exType=iff(isempty(innermostType), type, innermostType) | summarize records=count(), trueCount=sum(itemCount) by exType, assembly | order by trueCount desc | take 12`,
    // C2 — per instance: SNAT ports are allocated per worker, so skew matters
    `exceptions | where ${SOCKET_MATCH} | summarize records=count(), trueCount=sum(itemCount), operations=dcount(operation_Name), firstSeen=min(timestamp), lastSeen=max(timestamp) by instance=cloud_RoleInstance, roleName=cloud_RoleName | order by trueCount desc | take 20`,
    // C3 — burst vs steady leak
    `exceptions | where ${SOCKET_MATCH} | summarize trueCount=sum(itemCount) by bin(timestamp, ${socketBin}) | order by timestamp asc`,
    // C4 — which downstream target ate the ports (correlated via operation_Id)
    `exceptions | where ${SOCKET_MATCH} | distinct operation_Id | join kind=inner (dependencies | where success == false | project operation_Id, depTarget=target, depType=type, resultCode, duration, itemCount) on operation_Id | summarize count=sum(itemCount), avgDuration=round(avg(duration),0), p95=round(percentile(duration,95),0) by target=depTarget, depType, resultCode | order by count desc | take 15`,
    // C5 — raw records, full field set
    `exceptions | where ${SOCKET_MATCH} | ${socketProject} | top 50 by timestamp desc`,
    // C6 — generic types: neither socket-layer nor timeout (own tab)
    `exceptions | where ${GENERIC_MATCH} | summarize count=count(), trueCount=sum(itemCount) by type | order by count desc | take 10`,
    // C7 — generic records
    `exceptions | where ${GENERIC_MATCH} | project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack=tostring(details[0].parsedStack) | top 50 by timestamp desc`,
    // C8 — timeout totals
    `exceptions | where ${TIMEOUT_ONLY_MATCH} | summarize records=count(), trueCount=sum(itemCount), instances=dcount(cloud_RoleInstance), operations=dcount(operation_Name), firstSeen=min(timestamp), lastSeen=max(timestamp)`,
    // C9 — timeout types: which layer is timing out (SQL vs HTTP vs custom)
    `exceptions | where ${TIMEOUT_ONLY_MATCH} | summarize count=count(), trueCount=sum(itemCount) by type | order by count desc | take 10`,
    // C10 — timeout records
    `exceptions | where ${TIMEOUT_ONLY_MATCH} | project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack=tostring(details[0].parsedStack) | top 50 by timestamp desc`,
    // C11 — timeout over time
    `exceptions | where ${TIMEOUT_ONLY_MATCH} | summarize trueCount=sum(itemCount) by bin(timestamp, ${socketBin}) | order by timestamp asc`,
    // C12 — exact per-endpoint timeout totals and windows. Needed because the
    // detail records (C10) are capped at 50: counting groups from them understates
    // any endpoint with more than 50 records, and the summary's first/last seen is
    // the union across every endpoint, which cannot say which one started it.
    `exceptions | where ${TIMEOUT_ONLY_MATCH} | summarize records=count(), trueCount=sum(itemCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by endpoint=operation_Name | order by trueCount desc | take 20`,
    // C13 — OOM totals
    `exceptions | where ${OOM_ONLY_MATCH} | summarize records=count(), trueCount=sum(itemCount), instances=dcount(cloud_RoleInstance), operations=dcount(operation_Name), firstSeen=min(timestamp), lastSeen=max(timestamp)`,
    // C14 — OOM records
    `exceptions | where ${OOM_ONLY_MATCH} | project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack=tostring(details[0].parsedStack) | top 50 by timestamp desc`,
  ];

  // Group D: response-time breakdown (5 queries → 1 HTTP call). The Response row
  // only had avg / P99 / max for the whole app, which says a tail exists but not
  // where it comes from. These answer that: which endpoints own the time, how the
  // distribution is shaped, whether one worker is slow, and how much of the wait
  // is spent in downstream calls rather than in our own code.
  const groupDKqls = [
    // D0 — full percentile spread. Avg 200ms with P99 1.3s is a tail problem;
    // P50 sitting near P99 means everything is slow. Different investigations.
    `requests | summarize count=count(), avgMs=round(avg(duration),1), p50=round(percentile(duration,50),1), p75=round(percentile(duration,75),1), p95=round(percentile(duration,95),1), p99=round(percentile(duration,99),1), maxMs=round(max(duration),1)`,
    // D1 — total time contribution: count × avg, not max. Top-by-max finds one
    // freak request; this finds the endpoint actually costing users seconds.
    `requests | ${nameCleanExpr} | summarize count=count(), avgMs=round(avg(duration),1), p95=round(percentile(duration,95),1), totalMs=round(sum(duration),0) by nameClean | top 10 by totalMs desc | project url=nameClean, count, avgMs, p95, totalMs`,
    // D2 — App Insights stamps every request with a performanceBucket, so the whole
    // distribution shape is one summarize rather than a histogram query.
    `requests | where isnotempty(performanceBucket) | summarize count=count() by bucket=performanceBucket`,
    // D3 — per worker. Separates one bad instance from plan-wide degradation.
    `requests | where isnotempty(cloud_RoleInstance) | summarize count=count(), avgMs=round(avg(duration),1), p95=round(percentile(duration,95),1), p99=round(percentile(duration,99),1), maxMs=round(max(duration),1) by instance=cloud_RoleInstance | order by p95 desc | take 20`,
    // D4 — how much of the response was spent waiting on dependencies. Answers
    // "is this us or downstream" without opening a single trace.
    `requests | where isnotempty(operation_Id) | summarize reqMs=sum(duration) by operation_Id | join kind=leftouter (dependencies | summarize depMs=sum(duration) by operation_Id) on operation_Id | summarize totalReqMs=round(sum(reqMs),0), totalDepMs=round(sum(coalesce(depMs, 0.0)),0)`,
    // D5 — this site's own response timeline. The Response chart used to come from
    // the frontend's ARM metric, which has no API equivalent; querying it per App
    // Insights resource is what lets the FE and the API each have one.
    `requests | summarize avgMs=round(avg(duration),1), p95=round(percentile(duration,95),1) by bin(timestamp, ${topUrlBin}) | order by timestamp asc`,
    // D6 — the distributions split by outcome. Averaging successes together with
    // failures is how a burst of instant 500s makes a latency graph improve while
    // the service is down; this is the query that makes that visible.
    `requests | summarize count=count(), p50=round(percentile(duration,50),1), p95=round(percentile(duration,95),1), p99=round(percentile(duration,99),1), maxMs=round(max(duration),1) by success`,
    // D7 — error taxonomy. overSlo counts only successful responses, so a slow 500
    // is one explicit failure rather than one explicit plus one policy failure.
    `requests | summarize total=count(), failed=countif(success == false), fourXx=countif(toint(resultCode) >= 400 and toint(resultCode) < 500), fiveXx=countif(toint(resultCode) >= 500), overSlo=countif(success == true and duration > ${sloMs})`,
  ];

  // Group E: the Performance section (2 queries → 1 HTTP call).
  //
  // The existing Top / 4xx / 5xx lists answer three separate questions and cannot be
  // read together: an endpoint that is busy AND failing AND slow appears three times,
  // with a different metric each time and a different key each time (`urls` groups on
  // the raw name, the failure lists on nameClean). This merges them into one endpoint
  // set carrying all three golden signals — rate, errors, duration — so one row is
  // one endpoint and one chart can show whether its latency moved with its errors.
  //
  // Keyed on nameClean throughout. Merging the raw-name list with the nameClean lists
  // would emit '/order?id=1' and '/order' as two unrelated rows for one endpoint.
  const PERF_5XX_CAP = 50;
  // Every endpoint the section covers: the ten busiest, the ten worst 4xx, and every
  // endpoint with a 5xx up to the cap. Held in one const and joined by BOTH queries
  // below, because a row list and a timeline built from separately-derived key sets
  // drift silently — the chart plots endpoints no row can select, and vice versa.
  const perfKeyUnion =
    `union (requests | ${nameCleanExpr} | summarize c=count() by nameClean | top 10 by c desc | project nameClean), ` +
          `(requests | ${is4xx} | ${nameCleanExpr} | summarize c=count() by nameClean | top 10 by c desc | project nameClean), ` +
          `(requests | ${is5xx} | ${nameCleanExpr} | summarize c=count() by nameClean | top ${PERF_5XX_CAP} by c desc | project nameClean) ` +
    `| distinct nameClean`;
  const perfAggregates =
    `count=count(), c4=countif(${rc4xxExpr}), c5=countif(${rc5xxExpr}), ` +
    `avgMs=round(avg(duration),1), p95=round(percentile(duration,95),1)`;
  const groupEKqls = [
    // E0 — one row per endpoint, whole window. Ordered so a broken endpoint outranks a
    // busy one: an endpoint taking three requests and 500ing all three is the first
    // thing to look at, and sorting by traffic would bury it below fifty healthy rows.
    `requests | extend rc=toint(resultCode) | ${nameCleanExpr} ` +
    `| join kind=inner (${perfKeyUnion}) on nameClean ` +
    `| summarize ${perfAggregates}, p99=round(percentile(duration,99),1), maxMs=round(max(duration),1) by nameClean ` +
    `| project url=nameClean, count, rpm=round(todouble(count)/${spanMins},2), fourXx=c4, fiveXx=c5, avgMs, p95, p99, maxMs ` +
    `| order by fiveXx desc, fourXx desc, count desc`,
  ];

  // Group F: the Users section (2 queries → 1 HTTP call).
  //
  // Per App Insights resource, which is the whole point: the card's old app-level Users
  // row came from a frontend-only query, so an app's API had no user figures at all.
  const TOP_CLIENTS = 10;
  // The client ranking, in one place so F1's figures and F2's agents describe the same
  // ten addresses. Both join against it rather than each applying its own `top 10`.
  const topClientKey = `requests | ${clientIpExpr} | summarize n=count() by ip | top ${TOP_CLIENTS} by n desc | project ip`;
  // The agent ranking, matching Group B's userAgents list (also top 10 by count) — that
  // list supplies the rows the agent tab renders, and this supplies their lines.
  const topAgentKey = `requests | ${clientUaExpr} | where isnotempty(ua) | summarize n=count() by ua | top ${TOP_CLIENTS} by n desc | project ua`;
  const groupFKqls = [
    // F0 — distinct clients per bucket. dcount is approximate by design in KQL; that is
    // fine for a shape-of-traffic line and is why the figures below it are counts.
    `requests | ${clientIpExpr} | summarize users=dcount(ip) by bin(timestamp, ${topUrlBin}) | order by timestamp asc`,
    // F1 — the busiest clients, with enough detail to judge each one: how long it was
    // around, how many distinct endpoints it touched, and what it got back. One address
    // hitting one endpoint for an hour and collecting 404s is a prober; the same volume
    // spread over forty endpoints is a person.
    //
    // Country comes from max() rather than a group key: Azure's geo lookup can resolve one
    // IP to different regions across a window, and grouping on it would split a single
    // client into two rows that each look half as busy.
    `requests | ${clientIpExpr} | extend rc=toint(resultCode) ` +
    `| summarize n=count(), country=max(client_CountryOrRegion), firstSeen=min(timestamp), lastSeen=max(timestamp), ` +
      `urlCount=dcount(name), c4=countif(${rc4xxExpr}), c5=countif(${rc5xxExpr}) by ip ` +
    `| join kind=inner (${topClientKey}) on ip ` +
    `| project ip, country, count=n, rpm=round(todouble(n)/${spanMins},2), firstSeen, lastSeen, urlCount, fourXx=c4, fiveXx=c5 ` +
    `| order by count desc`,
    // F2 — each top client's dominant user agent, plus how many it presented.
    //
    // arg_max over a per-(ip, agent) count, not max(ua): max() on a string returns the
    // lexically largest agent, which is an arbitrary one. The dominant agent is the one
    // that identifies the client. `agents` counts the rest — a single address arriving
    // under a dozen agents is one machine rotating them, which is worth seeing.
    `requests | ${clientIpExpr} | ${clientUaExpr} | where isnotempty(ua) ` +
    `| join kind=inner (${topClientKey}) on ip ` +
    `| summarize uaN=count() by ip, ua ` +
    `| summarize arg_max(uaN, ua), agents=count() by ip ` +
    `| project ip, userAgent=ua, agents`,
    // F3 / F4 — per-client and per-agent request timelines, for the same ten of each that
    // the lists rank. These are what let a row be clicked and charted: the unique-user
    // line says traffic doubled, and only one client's own line says whether that was
    // everyone or one address.
    //
    // Inner-joined against the shared ranking consts rather than re-ranking, so every
    // listed row has a line and no line exists that no row can select.
    `requests | ${clientIpExpr} | join kind=inner (${topClientKey}) on ip ` +
    `| summarize n=count() by bin(timestamp, ${topUrlBin}), ip ` +
    `| project t=timestamp, key=ip, count=n | order by t asc`,
    `requests | ${clientUaExpr} | where isnotempty(ua) | join kind=inner (${topAgentKey}) on ua ` +
    `| summarize n=count() by bin(timestamp, ${topUrlBin}), ua ` +
    `| project t=timestamp, key=ua, count=n | order by t asc`,
  ];


  let failedUrlRows, slowUrlRows, total4xxRows, total5xxRows, errorTypeRows, errorDetailRows;
  let uaRows, botRows, hfRows, snatDetailRows, sqlHttpDetailRows;
  let depTimeoutRows;
  let insightResult;
  let groupCRows = null;
  let groupDRows = null;
  let groupERows = null;
  let groupFRows = null;

  if (summaryOnly) {
    // Only fetch summary aggregates needed for collapsed badges (2 HTTP calls)
    const [[t4xx, t5xx, etRows, dtRows], ins] = await Promise.all([
      runBatch([groupAKqls[2], groupAKqls[3], groupAKqls[4], groupAKqls[6]]),
      runQueryFull(insightKql),
    ]);
    total4xxRows = t4xx; total5xxRows = t5xx; errorTypeRows = etRows; depTimeoutRows = dtRows;
    insightResult = ins;
    failedUrlRows = null; slowUrlRows = null; errorDetailRows = null;
    uaRows = null; botRows = null; hfRows = null; snatDetailRows = null; sqlHttpDetailRows = null;
  } else {
    [[failedUrlRows, slowUrlRows, total4xxRows, total5xxRows, errorTypeRows, errorDetailRows, depTimeoutRows], [uaRows, botRows, hfRows, snatDetailRows, sqlHttpDetailRows], insightResult, groupCRows, groupDRows, groupERows, groupFRows] = await Promise.all([
      runBatch(groupAKqls),
      runBatch(groupBKqls),
      runQueryFull(insightKql),
      runBatch(groupCKqls),
      runBatch(groupDKqls),
      runBatch(groupEKqls),
      runBatch(groupFKqls),
    ]);
  }

  const parseOrErr = (rows, mapper) => Array.isArray(rows) ? rows.map(mapper) : rows;

  // ── Group C parse ──────────────────────────────────────────────────────────
  const cRows = (i) => (Array.isArray(groupCRows) && Array.isArray(groupCRows[i]) ? groupCRows[i] : null);
  const str = (v) => String(v ?? '');
  const num = (v) => Number(v) || 0;

  const socketDetailMapper = ([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, cloud_RoleInstance, innermostType, innermostMethod, operation_Id, itemCount, parsedStack]) => ({
    timestamp: str(timestamp), type: str(type) || 'Unknown', outerMessage: str(outerMessage), method: str(method),
    assembly: str(assembly), operation_Name: str(operation_Name), innermostMessage: str(innermostMessage),
    severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: str(handledAt),
    cloud_RoleName: str(cloud_RoleName), cloud_RoleInstance: str(cloud_RoleInstance),
    innermostType: str(innermostType), innermostMethod: str(innermostMethod),
    operation_Id: str(operation_Id), itemCount: itemCount != null ? Number(itemCount) : 1,
    parsedStack: str(parsedStack),
  });

  const socketSummaryRow = cRows(0)?.[0] ?? null;
  const socketInsights = groupCRows == null ? null : {
    summary: socketSummaryRow ? {
      records:    num(socketSummaryRow[0]),
      trueCount:  num(socketSummaryRow[1]),
      instances:  num(socketSummaryRow[2]),
      operations: num(socketSummaryRow[3]),
      firstSeen:  str(socketSummaryRow[4]),
      lastSeen:   str(socketSummaryRow[5]),
    } : null,
    byType:     (cRows(1) ?? []).map(([exType, assembly, records, trueCount]) => ({ exType: str(exType) || 'Unknown', assembly: str(assembly), records: num(records), trueCount: num(trueCount) })),
    byInstance: (cRows(2) ?? []).map(([instance, roleName, records, trueCount, operations, firstSeen, lastSeen]) => ({ instance: str(instance) || 'unknown', roleName: str(roleName), records: num(records), trueCount: num(trueCount), operations: num(operations), firstSeen: str(firstSeen), lastSeen: str(lastSeen) })),
    timeline:   (cRows(3) ?? []).map(([t, count]) => ({ t: str(t), count: num(count) })),
    targets:    (cRows(4) ?? []).map(([target, depType, resultCode, count, avgDuration, p95]) => ({ target: str(target) || '(unknown)', depType: str(depType), resultCode: str(resultCode), count: num(count), avgDuration: num(avgDuration), p95: num(p95) })),
    details:    (cRows(5) ?? []).map(socketDetailMapper),
  };

  // ── Group D parse ──────────────────────────────────────────────────────────
  const dRows = (i) => (Array.isArray(groupDRows) && Array.isArray(groupDRows[i]) ? groupDRows[i] : null);
  const spreadRow = dRows(0)?.[0] ?? null;
  const depShareRow = dRows(4)?.[0] ?? null;
  const totalReqMs = depShareRow ? num(depShareRow[0]) : 0;
  const totalDepMs = depShareRow ? num(depShareRow[1]) : 0;
  const responseInsights = groupDRows == null ? null : {
    spread: spreadRow ? {
      count: num(spreadRow[0]),
      avgMs: num(spreadRow[1]),
      p50:   num(spreadRow[2]),
      p75:   num(spreadRow[3]),
      p95:   num(spreadRow[4]),
      p99:   num(spreadRow[5]),
      maxMs: num(spreadRow[6]),
    } : null,
    byTotalTime: (dRows(1) ?? []).map(([url, count, avgMs, p95, totalMs]) => ({
      url: str(url) || '(unknown)', count: num(count), avgMs: num(avgMs), p95: num(p95), totalMs: num(totalMs),
    })),
    buckets: (dRows(2) ?? []).map(([bucket, count]) => ({ bucket: str(bucket), count: num(count) })),
    byInstance: (dRows(3) ?? []).map(([instance, count, avgMs, p95, p99, maxMs]) => ({
      instance: str(instance) || 'unknown', count: num(count), avgMs: num(avgMs), p95: num(p95), p99: num(p99), maxMs: num(maxMs),
    })),
    // Dependency time can exceed request time when calls run in parallel, so the
    // share is capped — over 100% would read as a data error rather than as
    // "this endpoint fans out".
    dependencyShare: totalReqMs > 0 ? Math.min(100, Math.round(totalDepMs / totalReqMs * 1000) / 10) : null,
    series: (dRows(5) ?? []).map(([t, avgMs, p95]) => ({ t: str(t), avgMs: num(avgMs), p95: num(p95) })),
    seriesBin: Array.isArray(dRows(5)) ? topUrlBin : null,
    bySuccess: (() => {
      // KQL returns `success` as a bool or as the string "True" depending on the
      // schema version, so both spellings are accepted rather than assumed.
      const pick = (want) => {
        const row = (dRows(6) ?? []).find(r => String(r[0]).toLowerCase() === String(want));
        return row ? { count: num(row[1]), p50: num(row[2]), p95: num(row[3]), p99: num(row[4]), maxMs: num(row[5]) } : null;
      };
      return { ok: pick(true), failed: pick(false) };
    })(),
    errors: (() => {
      const row = dRows(7)?.[0];
      if (!row) return null;
      return { total: num(row[0]), failed: num(row[1]), fourXx: num(row[2]), fiveXx: num(row[3]), overSlo: num(row[4]) };
    })(),
    sloMs,
  };

  // ── Group E parse ──────────────────────────────────────────────────────────
  const eRows = (i) => (Array.isArray(groupERows) && Array.isArray(groupERows[i]) ? groupERows[i] : null);
  const perfEndpoints = (eRows(0) ?? []).map(([url, count, rpmVal, fourXx, fiveXx, avgMs, p95, p99, maxMs]) => ({
    url: str(url) || '(unknown)',
    count: num(count), rpm: num(rpmVal),
    fourXx: num(fourXx), fiveXx: num(fiveXx),
    avgMs: num(avgMs), p95: num(p95), p99: num(p99), maxMs: num(maxMs),
  }));
  const performance = groupERows == null ? null : {
    endpoints: perfEndpoints,
    // The 5xx arm of the key set is capped, so a wide outage can be trimmed. Reported
    // rather than silently truncated: a list that stops at exactly the cap reads as
    // "these are all of them" when it is not.
    fiveXxCap: PERF_5XX_CAP,
    fiveXxCapped: perfEndpoints.filter(e => e.fiveXx > 0).length >= PERF_5XX_CAP,
  };

  // ── Group F parse ──────────────────────────────────────────────────────────
  const fRows = (i) => (Array.isArray(groupFRows) && Array.isArray(groupFRows[i]) ? groupFRows[i] : null);
  // F2's agents are folded onto F1's rows here rather than shipped as a second list:
  // both describe the same ten clients, and one flat row is what the UI renders.
  const agentByIp = new Map((fRows(2) ?? []).map(([ip, userAgent, agents]) => [
    str(ip), { userAgent: str(userAgent), agents: num(agents) },
  ]));
  const userInsights = groupFRows == null ? null : {
    bin: Array.isArray(fRows(0)) ? topUrlBin : null,
    series: (fRows(0) ?? []).map(([t, users]) => ({ t: str(t), users: num(users) })),
    topIps: (fRows(1) ?? []).map(([ip, country, count, rpmVal, firstSeen, lastSeen, urlCount, fourXx, fiveXx]) => {
      const key = str(ip);
      const agent = agentByIp.get(key);
      return {
        ip: key || '(unknown)', country: str(country),
        count: num(count), rpm: num(rpmVal),
        firstSeen: str(firstSeen), lastSeen: str(lastSeen),
        urlCount: num(urlCount), fourXx: num(fourXx), fiveXx: num(fiveXx),
        userAgent: agent?.userAgent ?? '', agents: agent?.agents ?? 0,
      };
    }),
    // groupUrlSeries already turns flat [t, key, count] rows into one gap-preserving
    // series per key; only the field name differs, since these keys are addresses and
    // agents rather than URLs.
    clientSeries: (Array.isArray(fRows(3)) ? groupUrlSeries(fRows(3)) : []).map(({ url, series }) => ({ key: url, series })),
    agentSeries:  (Array.isArray(fRows(4)) ? groupUrlSeries(fRows(4)) : []).map(({ url, series }) => ({ key: url, series })),
  };

  const genericDetailMapper = ([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack]) => ({
    timestamp: str(timestamp), type: str(type) || 'Unknown', outerMessage: str(outerMessage), method: str(method),
    assembly: str(assembly), operation_Name: str(operation_Name), innermostMessage: str(innermostMessage),
    severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: str(handledAt),
    cloud_RoleName: str(cloud_RoleName), client_Browser: str(client_Browser), client_OS: str(client_OS),
    innermostType: str(innermostType), innermostMethod: str(innermostMethod), parsedStack: str(parsedStack),
  });

  const timeoutSummaryRow = cRows(8)?.[0] ?? null;
  const timeoutInsights = groupCRows == null ? null : {
    summary: timeoutSummaryRow ? {
      records:    num(timeoutSummaryRow[0]),
      trueCount:  num(timeoutSummaryRow[1]),
      instances:  num(timeoutSummaryRow[2]),
      operations: num(timeoutSummaryRow[3]),
      firstSeen:  str(timeoutSummaryRow[4]),
      lastSeen:   str(timeoutSummaryRow[5]),
    } : null,
    types:    (cRows(9) ?? []).map(([type, count, trueCount]) => ({ type: str(type) || 'Unknown', count: num(count), trueCount: num(trueCount) })),
    details:  (cRows(10) ?? []).map(genericDetailMapper),
    timeline: (cRows(11) ?? []).map(([t, count]) => ({ t: str(t), count: num(count) })),
    byEndpoint: (cRows(12) ?? []).map(([endpoint, records, trueCount, firstSeen, lastSeen]) => ({ endpoint: str(endpoint) || '(unknown endpoint)', records: num(records), trueCount: num(trueCount), firstSeen: str(firstSeen), lastSeen: str(lastSeen) })),
  };

  const oomSummaryRow = cRows(13)?.[0] ?? null;
  const oomInsights = groupCRows == null ? null : {
    summary: oomSummaryRow ? {
      records:    num(oomSummaryRow[0]),
      trueCount:  num(oomSummaryRow[1]),
      instances:  num(oomSummaryRow[2]),
      operations: num(oomSummaryRow[3]),
      firstSeen:  str(oomSummaryRow[4]),
      lastSeen:   str(oomSummaryRow[5]),
    } : null,
    details: (cRows(14) ?? []).map(genericDetailMapper),
  };

  const errorTypesGeneric = cRows(6)
    ? cRows(6).map(([type, count, trueCount]) => ({ type: str(type) || 'Unknown', count: num(count), trueCount: num(trueCount) }))
    : null;
  const errorDetailsGeneric = cRows(7) ? cRows(7).map(genericDetailMapper) : null;

  let insight = null;
  if (insightResult && !insightResult.error && insightResult.rows?.length > 0) {
    const cols = insightResult.columns;
    const row = insightResult.rows[0];
    const get = (name) => { const i = cols.indexOf(name); return i >= 0 ? row[i] : null; };
    insight = {
      summary:               String(get('IncidentSummary') ?? ''),
      totalDependencies:     Number(get('TotalDependencies')     ?? 0),
      failedDependencies:    Number(get('FailedDependencies')    ?? 0),
      dependencyFailureRate: Number(get('DependencyFailureRate') ?? 0),
      dependencyP95:         Number(get('DependencyP95')         ?? 0),
      dependencyP99:         Number(get('DependencyP99')         ?? 0),
      totalRequests:         Number(get('TotalRequests')         ?? 0),
      failedRequests:        Number(get('FailedRequests')        ?? 0),
      requestFailureRate:    Number(get('RequestFailureRate')    ?? 0),
      requestP95:            Number(get('RequestP95')            ?? 0),
      requestP99:            Number(get('RequestP99')            ?? 0),
      socketLayerExceptions: Number(get('SocketLayerExceptions') ?? 0),
      timeoutExceptions:     Number(get('TimeoutExceptions')     ?? 0),
      oomExceptions:         Number(get('OomExceptions')         ?? 0),
      genericExceptions:     Number(get('GenericExceptions')     ?? 0),
      // Exact count of every exception row. errorCount only sums the top 10
      // types, so it undercounts whenever an app has more than 10 distinct types.
      totalExceptions:       Number(get('TotalExceptions')       ?? 0),
      uniqueUsers:           Number(get('UniqueUsers')           ?? 0),
    };
  }

  return {
    userAgents:  parseOrErr(uaRows,        ([ua, count, rpm])     => ({ userAgent: String(ua),  count: Number(count), rpm: Number(rpm) })),
    bots:        parseOrErr(botRows,       ([ua, count, rpm])     => ({ userAgent: String(ua),  count: Number(count), rpm: Number(rpm) })),
    highFreq:    parseOrErr(hfRows,        ([ts, lastSeen, ip, country, ua, count, rpm]) => ({ timestamp: String(ts), lastSeen: String(lastSeen), ip: String(ip), country: String(country), userAgent: String(ua), count: Number(count), rpm: Number(rpm) })),
    failedUrls:  parseOrErr(failedUrlRows, ([url, totalCount, failCount, p95, p99]) => ({ url: String(url), totalCount: Number(totalCount) || 0, count: Number(failCount) || 0, p95: Math.round(Number(p95) || 0), p99: Math.round(Number(p99) || 0) })),
    slowUrls:    parseOrErr(slowUrlRows,   ([url, avgMs, p99Ms, maxMs, count]) => ({ url: String(url), avgMs: Number(avgMs), p99Ms: Number(p99Ms), maxMs: Number(maxMs), count: Number(count) })),
    total4xx: Array.isArray(total4xxRows) && total4xxRows[0] ? Number(total4xxRows[0][0]) || 0 : null,
    total5xx: Array.isArray(total5xxRows) && total5xxRows[0] ? Number(total5xxRows[0][0]) || 0 : null,
    snatDetails: Array.isArray(snatDetailRows) ? snatDetailRows.map(([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, innermostType, innermostMethod, parsedStack]) => ({ timestamp: String(timestamp ?? ''), type: String(type ?? 'Unknown'), outerMessage: String(outerMessage ?? ''), method: String(method ?? ''), assembly: String(assembly ?? ''), operation_Name: String(operation_Name ?? ''), innermostMessage: String(innermostMessage ?? ''), severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: String(handledAt ?? ''), cloud_RoleName: String(cloud_RoleName ?? ''), innermostType: String(innermostType ?? ''), innermostMethod: String(innermostMethod ?? ''), parsedStack: String(parsedStack ?? '') })) : null,
    sqlHttpDetails: Array.isArray(sqlHttpDetailRows) ? sqlHttpDetailRows.map(([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, innermostType, innermostMethod, parsedStack]) => ({ timestamp: String(timestamp ?? ''), type: String(type ?? 'Unknown'), outerMessage: String(outerMessage ?? ''), method: String(method ?? ''), assembly: String(assembly ?? ''), operation_Name: String(operation_Name ?? ''), innermostMessage: String(innermostMessage ?? ''), severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: String(handledAt ?? ''), cloud_RoleName: String(cloud_RoleName ?? ''), innermostType: String(innermostType ?? ''), innermostMethod: String(innermostMethod ?? ''), parsedStack: String(parsedStack ?? '') })) : null,
    errorTypes: Array.isArray(errorTypeRows) ? errorTypeRows.map(([type, count]) => ({ type: String(type || 'Unknown'), count: Number(count) || 0 })) : null,
    errorCount: Array.isArray(errorTypeRows) ? errorTypeRows.reduce((s, [, c]) => s + (Number(c) || 0), 0) : null,
    errorDetails: Array.isArray(errorDetailRows) ? errorDetailRows.map(([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack]) => ({ timestamp: String(timestamp ?? ''), type: String(type ?? 'Unknown'), outerMessage: String(outerMessage ?? ''), method: String(method ?? ''), assembly: String(assembly ?? ''), operation_Name: String(operation_Name ?? ''), innermostMessage: String(innermostMessage ?? ''), severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: String(handledAt ?? ''), cloud_RoleName: String(cloud_RoleName ?? ''), client_Browser: String(client_Browser ?? ''), client_OS: String(client_OS ?? ''), innermostType: String(innermostType ?? ''), innermostMethod: String(innermostMethod ?? ''), parsedStack: String(parsedStack ?? '') })) : null,
    dependencyTimeouts: Array.isArray(depTimeoutRows) ? depTimeoutRows.map(([name, resultCode, depType, p95, maxMs, count]) => ({ name: String(name ?? ''), resultCode: String(resultCode ?? ''), type: String(depType ?? ''), p95: Math.round(Number(p95) || 0), maxMs: Math.round(Number(maxMs) || 0), count: Number(count) || 0 })) : null,
    responseInsights,
    performance,
    userInsights,
    socketInsights,
    timeoutInsights,
    oomInsights,
    errorTypesGeneric,
    errorDetailsGeneric,
    insight,
  };
}

// Outbound socket / TCP state counters. These are published on the App Service
// PLAN (Microsoft.Web/serverfarms), not the site — querying a site returns
// HTTP 400 "Failed to find metric configuration". Because they are plan-scoped
// they cover every site sharing the plan, which the UI states explicitly.
// Returns null when nothing reported (Container Apps, plans without the counters).
async function getSocketMetrics(client, token, siteResId, range, granularity, customStart, customEnd) {
  const plan = await getPlanInfo(token, siteResId).catch(() => null);
  if (!plan?.farmId) return null;
  const ts = buildTimespan(range, customStart, customEnd);
  const results = await Promise.all(SOCKET_METRIC_NAMES.map(async (name) => {
    try {
      const res = await client.queryResource(plan.farmId, [name], { timespan: ts, granularity, aggregations: ['Average', 'Maximum'] });
      const data = res.metrics[0]?.timeseries?.[0]?.data || [];
      if (!data.length) return null;
      const s = summarize(data);
      if (!s.series.length || s.series.every(p => p.v === 0 && p.m === 0)) return null;
      return { name, avg: s.avg, max: s.max, series: s.series.map(p => ({ t: p.t, v: p.v, m: p.m })) };
    } catch { return null; }
  }));
  const metrics = results.filter(Boolean);
  if (!metrics.length) return null;
  return { planName: plan.farmId.split('/').pop() || '', metrics };
}

async function fetchAppMetrics(client, token, credential, app, subscriptionId, range, customStart, customEnd, granularityOverride) {
  const resId = resourceId(subscriptionId, app);
  const spanHours = (customStart && customEnd) ? (new Date(customEnd) - new Date(customStart)) / 3_600_000 : Infinity;
  const gran = spanHours <= 2
    ? 'PT1M'
    : (granularityOverride || ((customStart && customEnd) ? getCustomGranularity(customStart, customEnd) : getGranularity(range)));

  const isAppService = app.type === 'appservice';
  const hasDb = !!(app.dbName && app.dbServerName);
  const dbResId = hasDb ? sqlDbResourceId(subscriptionId, app) : null;

  // Resolve plan (needed for metricsResId) and aiAppId in parallel
  const [planResult, aiAppId] = await Promise.all([
    isAppService ? getPlanInfo(token, resId).catch(() => null) : Promise.resolve(null),
    app.appInsightsAppId
      ? Promise.resolve(app.appInsightsAppId)
      : isAppService
        ? findAppInsightsAppId(token, subscriptionId, app.resourceGroup, app.name).catch(() => null)
        : Promise.resolve(null),
  ]);

  const plan = planResult;
  const metricsResId = (isAppService && plan?.farmId) ? plan.farmId : resId;

  async function fetchMemory() {
    if (!isAppService) return { metric: await queryMetric(client, metricsResId, 'MemoryPercentage', range, gran, customStart, customEnd), unit: '%' };
    try {
      const m = await queryMetric(client, metricsResId, 'MemoryPercentage', range, gran, customStart, customEnd);
      if (m && m.series.length > 0) return { metric: m, unit: '%' };
    } catch {}
    const m = await queryMetric(client, resId, 'MemoryWorkingSet', range, gran, customStart, customEnd, 1024 * 1024);
    return { metric: m, unit: 'MB' };
  }

  const [
    cpu, { metric: memory, unit: memUnit },
    instances, availability, httpQueue, requests, failedRequests, failedRequestsSeries,
    instanceHealthSeries, instanceProbeSeries, requestInsights, http4xxSeries, requestSeries,
    aiFailedByInstance, caTimeSeries,
    dbCpu, dbMemory,
  ] = await Promise.all([
    queryMetric(client, metricsResId, 'CpuPercentage', range, gran, customStart, customEnd),
    fetchMemory(),
    isAppService ? getInstances(token, resId, range, gran, customStart, customEnd) : getReplicas(token, resId),
    getAvailability(client, token, resId, app.type, range, gran, customStart, customEnd, aiAppId, credential),
    // Queue length is the one saturation signal that is not a utilization percentage:
    // requests waiting for a worker. Published on the plan, Windows only, null elsewhere.
    isAppService ? queryMetric(client, metricsResId, 'HttpQueueLength', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? queryCountMetrics(client, resId, ['Requests'], range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? queryCountMetrics(client, resId, ['Http4xx', 'Http5xx'], range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? queryFailedRequestsSeries(client, resId, range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? getInstanceHealthSeries(client, resId, range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? getInstanceProbeSeries(client, resId, range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    aiAppId ? getRequestInsights(aiAppId, credential, range, customStart, customEnd, true) : Promise.resolve(null),
    isAppService ? queryCountSeries(client, resId, 'Http4xx', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? queryCountSeries(client, resId, 'Requests', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    aiAppId ? getFailedRequestsByInstance(aiAppId, credential, range, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    (!isAppService && aiAppId) ? getContainerAppTimeSeries(aiAppId, credential, range, customStart, customEnd, gran).catch(() => null) : Promise.resolve(null),
    hasDb ? queryMetric(client, dbResId, 'cpu_percent', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    hasDb ? queryMetric(client, dbResId, 'sql_instance_memory_percent', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
  ]);

  // Collapse aiFailedByInstance into {t, count}[] — sum across instances per minute bucket
  // Prefer App Insights (1-min resolution, per-instance) over Azure Monitor Http5xx when available
  const effectiveFailedSeries = (() => {
    if (!aiFailedByInstance || !aiFailedByInstance.length) return failedRequestsSeries;
    const byMinute = new Map();
    for (const row of aiFailedByInstance) {
      const existing = byMinute.get(row.t) ?? 0;
      byMinute.set(row.t, existing + row.count);
    }
    return Array.from(byMinute.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, count]) => ({ t, count }));
  })();

  // Azure Monitor Requests/Http5xx per-instance gives real request health %.
  // Falls back to App Insights KQL if Azure Monitor returns nothing, then null.
  const effectiveInstanceHealth = (() => {
    if (instanceHealthSeries && instanceHealthSeries.length) return instanceHealthSeries;
    if (aiFailedByInstance && aiFailedByInstance.length) {
      const instMap = new Map();
      const instRole = new Map();
      for (const row of aiFailedByInstance) {
        if (!instMap.has(row.instance)) instMap.set(row.instance, []);
        instMap.get(row.instance).push({ t: row.t, v: row.healthPct });
        if (row.roleName && !instRole.has(row.instance)) instRole.set(row.instance, row.roleName);
      }
      return Array.from(instMap.entries()).map(([name, series]) => ({
        name,
        roleName: instRole.get(name) ?? null,
        series,
      }));
    }
    return null;
  })();

  // Refine downtime intervals using all 3 signals with hysteresis, then classify cause
  let refinedAvailability = availability;
  if (availability && availability.series && availability.series.length) {
    const granMins = gran === 'PT5M' ? 5 : gran === 'PT15M' ? 15 : gran === 'PT1H' ? 60 : 360;
    const settledSeries = availability.series.length > 2 ? availability.series.slice(0, -2) : availability.series;
    const rawIntervals = extractDowntimeIntervalsMultiSignal(settledSeries, effectiveFailedSeries, http4xxSeries, instanceProbeSeries);
    const multiIntervals = rawIntervals
      .map(iv => ({ ...iv, cause: classifyDowntimeCause(iv, { instanceHealthSeries: effectiveInstanceHealth }) }));
    const downtimeMins = multiIntervals.reduce((sum, iv) => sum + Math.round((iv.end - iv.start) / 60_000), 0) || availability.downtimeMins;
    refinedAvailability = {
      ...availability,
      downtimeMins,
      incidents: multiIntervals.length,
      downtimeIntervals: multiIntervals,
    };
  }

  // Supplement ARM instances with any instance names only in instanceHealthSeries
  // (ARM only returns currently running VMs; Azure Monitor retains historical per-instance data)
  if (effectiveInstanceHealth && instances) {
    const knownNames = new Map(instances.map((i, idx) => [i.name.toLowerCase(), idx]));
    for (const s of effectiveInstanceHealth) {
      const n = s.name;
      if (!n || n === 'unknown') continue;
      const vals = s.series.map(p => p.v).filter(v => v != null);
      const healthPct = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
      const existingIdx = knownNames.get(n.toLowerCase());
      if (existingIdx !== undefined) {
        if (instances[existingIdx].healthPct === null && healthPct !== null) {
          instances[existingIdx].healthPct = healthPct;
          instances[existingIdx].healthStatus = healthPct >= 90 ? 'Healthy' : healthPct >= 50 ? 'Degraded' : 'Unhealthy';
        }
      } else {
        instances.push({
          name: n,
          zone: '',
          healthStatus: healthPct != null ? (healthPct >= 90 ? 'Healthy' : healthPct >= 50 ? 'Degraded' : 'Unhealthy') : 'Unknown',
          healthPct,
        });
        knownNames.set(n.toLowerCase(), instances.length - 1);
      }
    }
  }

  // Fetch API instances + health series + App Insights if apiName configured
  let apiInstances = null;
  let apiInstanceHealthSeries = null;
  let apiRequestInsights = null;
  let apiAppInsightsConfigured = false;
  // Whether the API runs on the same App Service plan as the frontend. SNAT ports
  // are allocated per worker instance on the plan, so when it is shared both sites
  // report the same figures and the card shows them once instead of twice.
  let apiSharesPlan = null;
  if (app.apiName) {
    const apiResId = resourceId(subscriptionId, {
      type: app.apiType || 'appservice',
      resourceGroup: app.resourceGroup,
      name: app.apiName,
    });

    const apiIsContainerApp = (app.apiType || 'appservice') === 'containerapp';
    // Resolve apiAiAppId in parallel with instances + health

    const [apiInst, apiHealth, apiAiAppId] = await Promise.all([
      apiIsContainerApp ? getReplicas(token, apiResId) : getInstances(token, apiResId, range, gran, customStart, customEnd).catch(() => null),
      apiIsContainerApp ? Promise.resolve(null) : getInstanceHealthSeries(client, apiResId, range, gran, customStart, customEnd).catch(() => null),
      app.apiInsightsAppId
        ? Promise.resolve(app.apiInsightsAppId)
        : (apiIsContainerApp ? Promise.resolve(null) : findAppInsightsAppId(token, subscriptionId, app.resourceGroup, app.apiName).catch(() => null)),
    ]);
    apiInstances = apiInst;
    apiInstanceHealthSeries = apiHealth;

    if (!apiIsContainerApp && isAppService) {
      const apiPlan = await getPlanInfo(token, apiResId).catch(() => null);
      apiSharesPlan = !!(plan?.farmId && apiPlan?.farmId &&
        plan.farmId.toLowerCase() === apiPlan.farmId.toLowerCase());
    }

    // Supplement API instances with historical entries from apiInstanceHealthSeries
    if (apiInstanceHealthSeries && apiInstances) {
      const knownApi = new Map(apiInstances.map((i, idx) => [i.name.toLowerCase(), idx]));
      for (const s of apiInstanceHealthSeries) {
        const n = s.name;
        if (!n || n === 'unknown') continue;
        const vals = s.series.map(p => p.v).filter(v => v != null);
        const healthPct = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
        const existingIdx = knownApi.get(n.toLowerCase());
        if (existingIdx !== undefined) {
          // Backfill healthPct from series data when ARM returned null (no HealthCheckStatus metric)
          if (apiInstances[existingIdx].healthPct === null && healthPct !== null) {
            apiInstances[existingIdx].healthPct = healthPct;
            apiInstances[existingIdx].healthStatus = healthPct >= 90 ? 'Healthy' : healthPct >= 50 ? 'Degraded' : 'Unhealthy';
          }
        } else {
          apiInstances.push({
            name: n, zone: '',
            healthStatus: healthPct != null ? (healthPct >= 90 ? 'Healthy' : healthPct >= 50 ? 'Degraded' : 'Unhealthy') : 'Unknown',
            healthPct,
          });
          knownApi.set(n.toLowerCase(), apiInstances.length - 1);
        }
      }
    }

    // Fetch API App Insights data
    if (apiAiAppId) {
      apiAppInsightsConfigured = true;
      const [apiRI, apiAiFBI] = await Promise.all([
        getRequestInsights(apiAiAppId, credential, range, customStart, customEnd, true).catch(() => null),
        getFailedRequestsByInstance(apiAiAppId, credential, range, customStart, customEnd).catch(() => null),
      ]);
      apiRequestInsights = apiRI;

      // Enrich apiInstanceHealthSeries with AI fallback if Azure Monitor returned nothing
      if (!apiInstanceHealthSeries?.length && apiAiFBI?.length) {
        const instMap = new Map();
        const instRole = new Map();
        for (const row of apiAiFBI) {
          if (!instMap.has(row.instance)) instMap.set(row.instance, []);
          instMap.get(row.instance).push({ t: row.t, v: row.healthPct });
          if (row.roleName && !instRole.has(row.instance)) instRole.set(row.instance, row.roleName);
        }
        apiInstanceHealthSeries = Array.from(instMap.entries()).map(([name, series]) => ({
          name, roleName: instRole.get(name) ?? null, series,
        }));
      }
    }
  }

  const caInsight = !isAppService ? (requestInsights?.insight ?? null) : null;

  return {
    label: app.name,
    type: app.type,
    cpu,
    memory,
    cpuUnit: '%',
    memUnit,
    dbCpu: dbCpu ?? null,
    dbMemory: dbMemory ?? null,
    plan,
    instances,
    apiInstances,
    availability: refinedAvailability,
    requests: isAppService ? requests : (caInsight?.totalRequests != null ? { total: caInsight.totalRequests } : null),
    failedRequests: isAppService ? failedRequests : (caInsight?.failedRequests != null ? { total: caInsight.failedRequests } : null),
    failedRequestsSeries: effectiveFailedSeries,
    http4xxSeries: isAppService ? (http4xxSeries ?? null) : (caTimeSeries?.http4xxSeries ?? null),
    requestsSeries: isAppService ? requestSeries : (caTimeSeries?.requestsSeries ?? null),
    httpQueue: httpQueue ?? null,
    instanceHealthSeries: effectiveInstanceHealth,
    apiInstanceHealthSeries: apiInstanceHealthSeries ?? null,
    instanceProbeSeries: (instanceProbeSeries && instanceProbeSeries.length) ? instanceProbeSeries : null,
    requestInsights,
    appInsightsConfigured: !!aiAppId,
    apiRequestInsights: apiRequestInsights ?? null,
    apiAppInsightsConfigured,
    apiSharesPlan,
  };
}

// ─── On-demand detail fetch ───────────────────────────────────────────────────

async function fetchAppDetailsData(app, subscriptionId, credential, range, customStart, customEnd) {
  const isAppService = app.type === 'appservice';
  const token = await getToken(credential);

  const aiAppId = app.appInsightsAppId ||
    (isAppService ? await findAppInsightsAppId(token, subscriptionId, app.resourceGroup, app.name).catch(() => null) : null);

  let apiAiAppId = null;
  const apiIsContainerAppEarly = (app.apiType || 'appservice') === 'containerapp';
  if (app.apiName) {
    apiAiAppId = app.apiInsightsAppId ||
      (!apiIsContainerAppEarly && isAppService ? await findAppInsightsAppId(token, subscriptionId, app.resourceGroup, app.apiName).catch(() => null) : null);
  }

  // Platform socket/TCP counters — independent of App Insights, so fetched even
  // when the app has no AI component wired up.
  const { MetricsQueryClient } = require('@azure/monitor-query');
  const metricsClient = new MetricsQueryClient(credential);
  const gran = (customStart && customEnd) ? getCustomGranularity(customStart, customEnd) : getGranularity(range);
  const [socketMetrics, apiSocketMetrics] = await Promise.all([
    isAppService
      ? getSocketMetrics(metricsClient, token, resourceId(subscriptionId, app), range, gran, customStart, customEnd).catch(() => null)
      : Promise.resolve(null),
    (app.apiName && !apiIsContainerAppEarly)
      ? getSocketMetrics(metricsClient, token, resourceId(subscriptionId, { type: 'appservice', resourceGroup: app.resourceGroup, name: app.apiName }), range, gran, customStart, customEnd).catch(() => null)
      : Promise.resolve(null),
  ]);




  if (!aiAppId) return { requestInsights: null, apiRequestInsights: null, socketMetrics, apiSocketMetrics };

  const [requestInsights, apiRequestInsights] = await Promise.all([
    getRequestInsights(aiAppId, credential, range, customStart, customEnd, false, app.sloMs || DEFAULT_SLO_MS).catch(() => null),
    apiAiAppId ? getRequestInsights(apiAiAppId, credential, range, customStart, customEnd, false, app.sloMs || DEFAULT_SLO_MS).catch(() => null) : Promise.resolve(null),
  ]);

  return { requestInsights, apiRequestInsights, socketMetrics, apiSocketMetrics };


}

// ─── Detector KQL helpers ─────────────────────────────────────────────────────

function makeRunQuery(appId, token, timespan) {
  const endpoint = `https://api.applicationinsights.io/v1/apps/${appId}/query`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-ms-app': 'devforge',
  };
  return async function runQuery(query) {
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query, timespan }) });
      if (!res.ok) { const t = await res.text().catch(() => ''); return { error: `${res.status}: ${t}` }; }
      const data = await res.json();
      if (data.error) return { error: data.error.message || JSON.stringify(data.error) };
      const table = data.tables?.[0];
      return { columns: (table?.columns ?? []).map(c => c.name), rows: table?.rows || [] };
    } catch (e) { return { error: e.message }; }
  };
}

const DETECTOR_QUERIES = [
  { id: 'web_app_down', label: 'Web App Down', color: '#f85149', queries: [
    { name: 'Request Failure Rate',
      kql: `requests | where {BETWEEN} | summarize Total=count(), Failed=countif(success==false) by bin(timestamp,5m) | extend FailureRate=todouble(Failed)/Total*100 | order by timestamp asc` },
    { name: 'Near-Zero Traffic',
      kql: `requests | where {BETWEEN} | summarize Requests=count() by bin(timestamp,5m) | order by timestamp asc` },
  ]},
  { id: 'web_app_slow', label: 'Web App Slow', color: '#d29922', queries: [
    { name: 'Request Duration P95/P99',
      kql: `requests | where {BETWEEN} | summarize AvgDuration=avg(duration), P95=percentile(duration,95), P99=percentile(duration,99) by bin(timestamp,5m) | order by timestamp asc` },
    { name: 'Slow Dependencies',
      kql: `dependencies | where {BETWEEN} | summarize AvgDuration=avg(duration), P95=percentile(duration,95) by target | order by P95 desc | take 10` },
  ]},
  { id: 'snat', label: 'SNAT Port Exhaustion', color: '#a371f7', queries: [
    { name: 'Connection Errors',
      kql: `exceptions | where {BETWEEN} | where outerMessage has_any ("SocketException","timeout","No buffer space available","actively refused","ENOBUFS") | summarize Count=count() by outerMessage | order by Count desc` },
    { name: 'Dependency Duration Spike',
      kql: `dependencies | where {BETWEEN} | summarize Total=count(), Failed=countif(success==false), DurationP95=percentile(duration,95), DurationP99=percentile(duration,99) by target | extend FailureRate=todouble(Failed)/Total*100 | order by DurationP99 desc` },
  ]},
  { id: 'memory', label: 'Memory Analysis', color: '#58a6ff', queries: [
    { name: 'OOM Exceptions',
      kql: `exceptions | where {BETWEEN} | where outerMessage has_any ("OutOfMemory","OOM","memory") | summarize Count=count() by outerMessage` },
  ]},
  { id: 'crashes', label: 'Application Crashes', color: '#f85149', queries: [
    { name: 'Critical Exceptions',
      kql: `exceptions | where {BETWEEN} | where severityLevel >= 3 | summarize Count=count() by type, outerMessage | order by Count desc | take 10` },
    { name: 'Crash Traces',
      kql: `traces | where {BETWEEN} | where message has_any ("crash","terminated","shutdown","stopped") | project timestamp, message | order by timestamp desc | take 20` },
  ]},
  { id: 'restart', label: 'Web App Restarted', color: '#d29922', queries: [
    { name: 'Restart Detection',
      kql: `traces | where {BETWEEN} | where message has_any ("restart","restarted","Starting","Stopping") | project timestamp, message | order by timestamp desc | take 20` },
  ]},
  { id: 'http4xx', label: 'HTTP 4xx Errors', color: '#d29922', queries: [
    { name: 'Client Error Breakdown',
      kql: `requests | where {BETWEEN} | where toint(resultCode) between (400 .. 499) | summarize Count=count() by resultCode, url | order by Count desc | take 10` },
    { name: 'Top Failing Endpoints',
      kql: `requests | where {BETWEEN} | where success == false | summarize Failures=count() by name | order by Failures desc | take 10` },
  ]},
];

// ─── IPC handler ─────────────────────────────────────────────────────────────

const handler = (_mainWindow) => {
  const { ipcMain } = require('electron');
  const { DefaultAzureCredential } = require('@azure/identity');
  const { MetricsQueryClient } = require('@azure/monitor-query');

  ipcMain.handle('azure-metrics:check-credential', async () => {
    const { AzureCliCredential } = require('@azure/identity');
    const scope = 'https://management.azure.com/.default';
    const withTimeout = (promise, ms, label) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
      ]);

    try {
      const cliCred = new AzureCliCredential();
      await withTimeout(cliCred.getToken(scope), 6000, 'AzureCliCredential');
      return { ok: true, source: 'azure-cli' };
    } catch (cliErr) {
      try {
        const cred = new DefaultAzureCredential();
        await withTimeout(cred.getToken(scope), 8000, 'DefaultAzureCredential');
        return { ok: true, source: 'default' };
      } catch (err) {
        const msg = (err.message || String(err)).includes('timed out')
          ? 'Azure credential check timed out. Run `az login` in your terminal, then click Re-check.'
          : (cliErr.message || err.message || String(err));
        return { ok: false, error: msg };
      }
    }
  });

  ipcMain.handle('azure-metrics:fetch', async (_event, { appKeys, range, config, customStart, customEnd, granularity }) => {
    if (!config?.subscriptionId || !config?.apps?.length) {
      return { _error: 'No Azure configuration. Open Settings and configure your subscription and apps.' };
    }

    const cred = new DefaultAzureCredential();
    const client = new MetricsQueryClient(cred);
    const token = await getToken(cred);

    const appsMap = Object.fromEntries(config.apps.map(a => [a.name, a]));

    const results = {};
    await Promise.all(
      appKeys.map(async (key) => {
        const cacheKey = `${key}:${customStart ?? range}:${customEnd ?? ''}:${granularity ?? ''}`;
        const cached = getCached(cacheKey);
        if (cached) {
          results[key] = cached;
          _event.sender.send('azure-metrics:partial', { key, result: cached });
          return;
        }

        const app = appsMap[key];
        if (!app) {
          const errorResult = {
            label: key,
            type: 'appservice',
            cpu: { avg: 0, max: 0, series: [] },
            memory: { avg: 0, max: 0, series: [] },
            cpuUnit: '%',
            memUnit: '%',
            error: `App "${key}" not found in configuration.`,
          };
          results[key] = errorResult;
          _event.sender.send('azure-metrics:partial', { key, result: errorResult });
          return;
        }
        try {
          const result = await fetchAppMetrics(client, token, cred, app, config.subscriptionId, range, customStart, customEnd, granularity);
          setCached(cacheKey, result);
          results[key] = result;
          _event.sender.send('azure-metrics:partial', { key, result });
        } catch (err) {
          const errorResult = {
            label: app.name,
            type: app.type || 'appservice',
            cpu: { avg: 0, max: 0, series: [] },
            memory: { avg: 0, max: 0, series: [] },
            cpuUnit: '%',
            memUnit: '%',
            error: err.message || String(err),
          };
          results[key] = errorResult;
          _event.sender.send('azure-metrics:partial', { key, result: errorResult });
        }
      })
    );
    return results;
  });

  ipcMain.handle('azure-metrics:fetch-app-details', async (_event, { appKey, range, config, customStart, customEnd }) => {
    if (!config?.subscriptionId || !config?.apps?.length) return { error: 'No config' };
    const cacheKey = `${appKey}:details:${customStart ?? range}:${customEnd ?? ''}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;
    const app = config.apps.find(a => a.name === appKey);
    if (!app) return { error: `App "${appKey}" not found` };
    try {
      const cred = new DefaultAzureCredential();
      const result = await fetchAppDetailsData(app, config.subscriptionId, cred, range, customStart, customEnd);
      setCached(cacheKey, result);
      return result;
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });

  /**
   * One endpoint's downstream calls.
   *
   * Its own handler, fetched per endpoint on selection, rather than a top-8-for-every-
   * endpoint query inside the details batch. Three reasons:
   *
   *  - The details response is cached, so folding this in meant a card fetched before the
   *    feature existed served a payload with no dependency data and no way to ask for it.
   *  - Inside runBatch a rejected query comes back as an error object, which the parse
   *    turned into an empty list — a KQL failure was indistinguishable from "this endpoint
   *    called nothing". Here the error travels to the UI and is shown.
   *  - Only one endpoint is ever on screen, so fetching sixty endpoints' calls to render
   *    one was most of the work wasted.
   *
   * Attribution is by `operation_Name`, the request that made the call, cleaned exactly
   * like request `name` so a query string cannot split one endpoint in two. A dependency
   * raised outside a request (startup, a background job) has no operation_Name and is
   * therefore absent rather than attributed to an arbitrary endpoint.
   */
  ipcMain.handle('azure-metrics:fetch-endpoint-detail', async (_event, { appKey, endpoint, site, config, range, customStart, customEnd }) => {
    if (!config?.subscriptionId || !config?.apps?.length) return { series: null, deps: null, error: 'No config' };
    if (!endpoint) return { series: null, deps: null, error: 'No endpoint' };
    const app = config.apps.find(a => a.name === appKey);
    if (!app) return { series: null, deps: null, error: `App "${appKey}" not found` };

    const cacheKey = `${appKey}:epdeps:${site}:${endpoint}:${customStart ?? range}:${customEnd ?? ''}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
      const cred = new DefaultAzureCredential();
      const token = await getToken(cred);
      const isAppService = app.type === 'appservice';
      const appId = site === 'api'
        ? (app.apiInsightsAppId
            || ((app.apiType || 'appservice') === 'appservice' && isAppService
                 ? await findAppInsightsAppId(token, config.subscriptionId, app.resourceGroup, app.apiName).catch(() => null)
                 : null))
        : (app.appInsightsAppId
            || (isAppService
                 ? await findAppInsightsAppId(token, config.subscriptionId, app.resourceGroup, app.name).catch(() => null)
                 : null));
      if (!appId) return { series: null, deps: null, error: 'No App Insights resource for this site' };

      const result = await fetchEndpointDetail(appId, cred, endpoint, range, customStart, customEnd);
      // Only a real answer is cached. Caching an error would pin a transient failure for
      // the whole TTL and make the retry look broken.
      if (Array.isArray(result.deps)) setCached(cacheKey, result);
      return result;
    } catch (err) {
      return { series: null, deps: null, error: err.message || String(err) };
    }
  });

  // SNAT port allocations come from App Service Diagnostics, not Azure Monitor, so
  // they have their own handler rather than riding along with fetch-app-details:
  // the detector round trip is slow and the section is only loaded when expanded.
  ipcMain.handle('azure-metrics:fetch-snat', async (_event, { appKey, range, config, customStart, customEnd, granularity }) => {
    if (!config?.subscriptionId || !config?.apps?.length) return { fe: { charts: null, error: 'No config' }, api: null, shared: false };
    const app = config.apps.find(a => a.name === appKey);
    if (!app) return { fe: { charts: null, error: `App "${appKey}" not found` }, api: null, shared: false };

    // The grain is part of the key: the same window at 1m and at 15m are different
    // answers, and the finer one must not be served from a coarser cached fetch.
    const gran = granularity || ((customStart && customEnd) ? getCustomGranularity(customStart, customEnd) : getGranularity(range));
    const cacheKey = `${appKey}:snat:${customStart ?? range}:${customEnd ?? ''}:${gran}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
      const cred = new DefaultAzureCredential();
      const token = await getToken(cred);
      const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
      const startIso = startTime.toISOString();
      const endIso = endTime.toISOString();

      // Container Apps do not run on an App Service plan, so there is no detector
      // for them — the site is skipped rather than reported as an error.
      const forSite = async (siteApp, isAppService) => {
        if (!isAppService) return { charts: null };
        try {
          const parsed = await fetchSnatCharts(token, resourceId(config.subscriptionId, siteApp), startIso, endIso, gran);
          // requestedGrain travels with the data so the UI can say when the detector
          // served a coarser bucket than the interval the user picked.
          return { charts: parsed?.charts ?? null, detector: parsed?.detector ?? null, grainMs: parsed?.grainMs ?? null, requestedGrain: gran };
        } catch (err) {
          return { charts: null, error: err.message || String(err) };
        }
      };

      // Ports are allocated per worker instance on the plan, so a shared plan means
      // both detectors return the same numbers — the API call is skipped and the
      // card shows one section instead of two identical ones.
      const apiIsAppService = !!app.apiName && (app.apiType || 'appservice') === 'appservice';
      const apiSite = { type: 'appservice', resourceGroup: app.resourceGroup, name: app.apiName };
      const shared = apiIsAppService && await (async () => {
        const [fePlan, apiPlan] = await Promise.all([
          getPlanInfo(token, resourceId(config.subscriptionId, app)).catch(() => null),
          getPlanInfo(token, resourceId(config.subscriptionId, apiSite)).catch(() => null),
        ]);
        return !!(fePlan?.farmId && apiPlan?.farmId &&
          fePlan.farmId.toLowerCase() === apiPlan.farmId.toLowerCase());
      })();

      const [fe, api] = await Promise.all([
        forSite(app, (app.type || 'appservice') === 'appservice'),
        apiIsAppService && !shared ? forSite(apiSite, true) : Promise.resolve(null),
      ]);

      const result = { fe, api, shared };
      // Only a result with charts is worth keeping. Caching an empty one pins a
      // transient detector failure to the card for the whole TTL, and re-running
      // the fetch is the obvious thing a user does when the section looks wrong.
      if (fe?.charts?.length) setCached(cacheKey, result);
      return result;
    } catch (err) {
      return { fe: { charts: null, error: err.message || String(err) }, api: null, shared: false };
    }
  });

  // Restart events are per site: a frontend restarting while its API stays up is
  // the distinction worth seeing, so unlike SNAT this is never collapsed into one.
  ipcMain.handle('azure-metrics:fetch-restarts', async (_event, { appKey, range, config, customStart, customEnd, granularity }) => {
    if (!config?.subscriptionId || !config?.apps?.length) return { fe: null, api: null };
    const app = config.apps.find(a => a.name === appKey);
    if (!app) return { fe: null, api: null };

    const gran = granularity || ((customStart && customEnd) ? getCustomGranularity(customStart, customEnd) : getGranularity(range));
    const cacheKey = `${appKey}:restarts:${customStart ?? range}:${customEnd ?? ''}:${gran}`;
    const cached = getCached(cacheKey);
    if (cached) return cached;

    try {
      const cred = new DefaultAzureCredential();
      const token = await getToken(cred);
      const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
      const startIso = startTime.toISOString();
      const endIso = endTime.toISOString();

      const forSite = async (siteApp, isAppService) => {
        if (!isAppService) return null;
        try {
          return await fetchRestartCharts(token, resourceId(config.subscriptionId, siteApp), startIso, endIso, gran);
        } catch { return null; }
      };

      const apiIsAppService = !!app.apiName && (app.apiType || 'appservice') === 'appservice';
      const [fe, api] = await Promise.all([
        forSite(app, (app.type || 'appservice') === 'appservice'),
        apiIsAppService
          ? forSite({ type: 'appservice', resourceGroup: app.resourceGroup, name: app.apiName }, true)
          : Promise.resolve(null),
      ]);

      const result = { fe, api };
      // Same reasoning as the SNAT cache: pinning a transient detector failure for
      // the whole TTL makes a re-fetch look broken.
      if (fe?.charts?.length || api?.charts?.length) setCached(cacheKey, result);
      return result;
    } catch (err) {
      return { fe: null, api: null, error: err.message || String(err) };
    }
  });

  ipcMain.handle('azure-metrics:fetch-detectors', async (_event, { appInsightsAppId, startIso, endIso }) => {
    if (!appInsightsAppId) return { categories: [], error: 'No App Insights App ID' };
    let token;
    try {
      const cred = new DefaultAzureCredential();
      token = (await cred.getToken('https://api.applicationinsights.io/.default')).token;
    } catch (e) { return { categories: [], error: `Token error: ${e.message}` }; }

    const timespan = `${startIso}/${endIso}`;
    const between = `timestamp between (datetime(${startIso}) .. datetime(${endIso}))`;
    const runQuery = makeRunQuery(appInsightsAppId, token, timespan);
    const sub = (kql) => kql
      .replace(/\{BETWEEN\}/g, between)
      .replace(/\{START\}/g, `datetime(${startIso})`)
      .replace(/\{END\}/g,   `datetime(${endIso})`);

    const categories = await Promise.all(
      DETECTOR_QUERIES.map(async (cat) => ({
        id: cat.id, label: cat.label, color: cat.color,
        queries: await Promise.all(cat.queries.map(async (q) => {
          const raw = await runQuery(sub(q.kql));
          return { name: q.name, result: raw.error ? { columns: [], rows: [], error: raw.error } : { columns: raw.columns ?? [], rows: raw.rows ?? [] } };
        })),
      }))
    );
    return { categories };
  });
};

handler._getGranularity = getGranularity;
handler._summarize = summarize;
handler._groupUrlSeries = groupUrlSeries;

module.exports = handler;
