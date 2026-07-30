'use strict';

// ─── Per-app result cache ─────────────────────────────────────────────────────

const _fetchCache = new Map();
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

/** Three-way dependency classification. `internalCondition` is null when the app's
 *  hostnames could not be resolved, in which case everything non-asset is third-party. */
function depClassifyExpr(internalCondition) {
  const rest = internalCondition ? `iff(${internalCondition}, "internal", "thirdParty")` : '"thirdParty"';
  return `extend classification = iff(${ASSET_DEP_MATCH}, "assets", ${rest})`;
}

// ─── Shared signal helpers ───────────────────────────────────────────────────
// Downtime detection and socket metric names live in azure-signals.cjs so the
// incident report detects outages with the same rules — see that file.
const {
  SOCKET_METRIC_NAMES,
  extractDowntimeIntervals,
  classifyDowntimeCause,
  extractDowntimeIntervalsMultiSignal,
} = require('./azure-signals.cjs');

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
async function getAppHostnames(token, resId, type) {
  try {
    if (type === 'containerapp') {
      const res = await fetch(`https://management.azure.com${resId}?api-version=2023-05-01`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return [];
      const data = await res.json();
      const ingress = data.properties?.configuration?.ingress;
      const customDomains = (ingress?.customDomains ?? []).map(d => d.name).filter(Boolean);
      return [ingress?.fqdn, ...customDomains].filter(Boolean);
    }
    const res = await fetch(`https://management.azure.com${resId}?api-version=2022-03-01`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const hostNames = data.properties?.hostNames ?? [];
    return [...new Set([data.properties?.defaultHostName, ...hostNames].filter(Boolean))];
  } catch { return []; }
}

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

async function getResponseTime(client, resId, range, granularity, customStart, customEnd) {
  try {
    const result = await client.queryResource(resId, ['HttpResponseTime'], {
      timespan: buildTimespan(range, customStart, customEnd),
      granularity,
      aggregations: ['Average', 'Maximum'],
    });
    const data = result.metrics[0]?.timeseries?.[0]?.data || [];
    if (!data.length) return null;
    const s = summarize(data);
    const series = data.map(d => ({
      t: d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp),
      avg: Math.round((d.average ?? 0) * 1000) / 1000,
    }));
    return { avg: s.avg, max: s.max, p99: s.p99, series };
  } catch {
    return null;
  }
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
    const queries = [
      `requests | summarize count=count() by bin(timestamp, ${bin}) | order by timestamp asc`,
      `requests | where toint(resultCode) >= 400 and toint(resultCode) < 500 | summarize count=count() by bin(timestamp, ${bin}) | order by timestamp asc`,
      `requests | summarize avgSec=round(avg(duration)/1000,3) by bin(timestamp, ${bin}) | order by timestamp asc`,
      `requests | summarize avgSec=round(avg(duration)/1000,3), maxSec=round(max(duration)/1000,3), p99Sec=round(percentile(duration,99)/1000,3)`,
    ];
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ query: queries.join(';\n'), timespan }) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    const tables = data.tables || [];
    const reqRows  = tables[0]?.rows ?? [];
    const h4xRows  = tables[1]?.rows ?? [];
    const rtRows   = tables[2]?.rows ?? [];
    const summRow  = tables[3]?.rows?.[0];
    const requestsSeries = reqRows.map(([t, count]) => ({ t: new Date(t).toISOString(), count: Number(count) }));
    const http4xxSeries  = h4xRows.map(([t, count]) => ({ t: new Date(t).toISOString(), count: Number(count) }));
    const rtSeries       = rtRows.map(([t, avg]) => ({ t: new Date(t).toISOString(), avg: Number(avg) }));
    const responseTime   = summRow
      ? { avg: Number(summRow[0]) || 0, max: Number(summRow[1]) || 0, p99: Number(summRow[2]) || 0, series: rtSeries }
      : null;
    return { requestsSeries, http4xxSeries, responseTime };
  } catch { return null; }
}

// Distinct users (by IP) per time bucket, summarized into the same {avg, max, p99, series} shape as ARM MetricSeries.
// FE only — never called for the API app's aiAppId.
async function getUserStats(appId, credential, range, customStart, customEnd, gran) {
  try {
    const aiToken = (await credential.getToken('https://api.applicationinsights.io/.default')).token;
    const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
    const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
    const bin = isoGranToKql(gran);
    const query = `requests
| extend dimIp = tostring(customDimensions["Client IP Address"])
| extend ip = iff(isnotempty(dimIp) and dimIp != "::1", dimIp, iff(isnotempty(client_IP) and client_IP != "::1", client_IP, ""))
| where isnotempty(ip)
| summarize count = dcount(ip) by bin(timestamp, ${bin})
| order by timestamp asc`;
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    const rows = data.tables?.[0]?.rows || [];
    const points = rows.map(([t, count]) => ({ timeStamp: t, average: Number(count) || 0, maximum: Number(count) || 0 }));
    return summarize(points);
  } catch { return null; }
}

function kqlLit(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Builds a KQL boolean expression classifying a dependency as internal: either `target`
// matches one of the app's own resource names or real bound hostnames (default + custom
// domains), `target` is hostless (no "." — an in-proc call or bare server name), or (for
// HTTP deps) `name` is a bare path like "GET /api/x" with no "://" scheme — App Insights
// records same-origin/correlated calls this way, vs. a full absolute URL
// ("POST https://px.ads.linkedin.com/...") for genuine third parties.
function buildInternalCondition(app, hostnames = []) {
  const needles = [app?.apiName, app?.dbName, app?.name, ...hostnames].filter(n => n && String(n).trim());
  const conds = [
    `(type has "Http" and name !contains "://")`,
    `target !contains "."`,
    ...needles.map(n => `target contains "${kqlLit(n)}"`),
  ];
  return conds.join(' or ');
}

async function getFailedDependencies(appId, credential, range, customStart, customEnd, internalCondition = null) {
  try {
    const aiToken = await credential.getToken('https://api.applicationinsights.io/.default');
    const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
    const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
    const classifyExpr = depClassifyExpr(internalCondition);
    const query = `dependencies
| extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)
| ${classifyExpr}
| where success == false
| summarize failCount=count(), p95=percentile(duration, 95), p99=percentile(duration, 99), avgDuration=avg(duration) by classification, nameClean, type, target
| join kind=leftouter (dependencies | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | ${classifyExpr} | summarize totalCount=count() by classification, nameClean, type, target) on classification, nameClean, type, target
| project classification, name=nameClean, type, target, totalCount=coalesce(totalCount, failCount), failCount, avgDuration, p95, p99
| order by classification asc, failCount desc
| serialize
| extend rn = row_number(1, prev(classification) != classification)
| where rn <= 25
| project-away rn`;
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = data.tables?.[0]?.rows || [];
    const t = startTime.toISOString();
    return rows.map(([classification, name, depType, depTarget, totalCount, failCount, avgDuration, p95, p99]) => ({
      t,
      classification: classification === 'internal' ? 'internal' : classification === 'assets' ? 'assets' : 'thirdParty',
      name:        name      ?? '(unknown)',
      type:        depType   ?? '(unknown)',
      target:      depTarget ?? '',
      totalCount:  Number(totalCount)  || 0,
      failCount:   Number(failCount)   || 0,
      avgDuration: Math.round(Number(avgDuration) || 0),
      p95:         Math.round(Number(p95) || 0),
      p99:         Math.round(Number(p99) || 0),
    }));
  } catch { return null; }
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

async function getRequestInsights(appId, credential, range, customStart, customEnd, summaryOnly = false, internalCondition = null) {
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
  const depsClassifyExpr = `${depClassifyExpr(internalCondition)} | `;
  const topDepsKql =
    `dependencies | ${depsClassifyExpr}summarize totalCount=count(), failCount=countif(success==false), avgDuration=round(avg(duration),0), p95=round(percentile(duration,95),0), p99=round(percentile(duration,99),0) by classification, name, type, target ` +
    `| order by classification asc, totalCount desc | serialize | extend rn=row_number(1, prev(classification) != classification) | where rn <= 10 | project-away rn`;
  const groupAKqls = [
    `requests | summarize n=count() by name | top 10 by n desc | project url=name, count=n, rpm=round(todouble(n)/${spanMins},2)`,
    `requests | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | where success == false | summarize failCount=count(), p95=percentile(duration,95), p99=percentile(duration,99) by nameClean | join kind=leftouter (requests | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize totalCount=count() by nameClean) on nameClean | project url=nameClean, totalCount=coalesce(totalCount,failCount), failCount, p95, p99 | order by failCount desc | take 10`,
    `requests | summarize avgMs=avg(duration), p99Ms=percentile(duration,99), maxMs=max(duration), n=count() by name | top 10 by maxMs desc | project url=name, avgMs=round(avgMs,1), p99Ms=round(p99Ms,1), maxMs=round(maxMs,1), count=n`,
    `requests | extend rc=toint(resultCode) | where rc >= 400 and rc < 500 | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize failCount=count(), p95=percentile(duration,95), p99=percentile(duration,99) by nameClean | join kind=leftouter (requests | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize totalCount=count() by nameClean) on nameClean | project url=nameClean, totalCount=coalesce(totalCount,failCount), failCount, p95, p99 | order by failCount desc | take 10`,
    `requests | extend rc=toint(resultCode) | where rc >= 500 or (success == false and (isempty(resultCode) or rc == 0 or isnull(rc))) | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize failCount=count(), p95=percentile(duration,95), p99=percentile(duration,99) by nameClean | join kind=leftouter (requests | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize totalCount=count() by nameClean) on nameClean | project url=nameClean, totalCount=coalesce(totalCount,failCount), failCount, p95, p99 | order by failCount desc | take 10`,
    `requests | extend rc=toint(resultCode) | where rc >= 400 and rc < 500 | count`,
    `requests | extend rc=toint(resultCode) | where rc >= 500 or (success == false and (isempty(resultCode) or rc == 0 or isnull(rc))) | count`,
    topDepsKql,
    `exceptions | summarize count=count() by type | order by count desc | take 10`,
    `exceptions | project timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack=tostring(details[0].parsedStack) | top 50 by timestamp desc`,
    `dependencies | where success == false | where resultCode in (${TIMEOUT_RESULT_CODES}) | extend nameClean = iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize timeoutCount=sum(itemCount), p95=round(percentile(duration,95),0), maxMs=round(max(duration),0) by nameClean, resultCode, type | project name=nameClean, resultCode, type, p95, maxMs, timeoutCount | order by timeoutCount desc | take 15`,
  ];

  // Group B: client-based + SNAT + SQL/HTTP timeouts (6 queries → 1 HTTP call)
  const groupBKqls = [
    `requests | extend dimIp=tostring(customDimensions["Client IP Address"]) | extend ip=iff(isnotempty(dimIp) and dimIp != "::1", dimIp, iff(isnotempty(client_IP) and client_IP != "::1", client_IP, "")) | where isnotempty(ip) | summarize n=count() by ip | top 10 by n desc | project ip, count=n, rpm=round(todouble(n)/${spanMins},2)`,
    `requests | extend ua=coalesce(tostring(customDimensions["User-Agent"]), tostring(customDimensions["user-agent"]), tostring(customDimensions["http.user_agent"]), client_Browser) | where isnotempty(ua) | summarize n=count() by ua | top 10 by n desc | project userAgent=ua, count=n, rpm=round(todouble(n)/${spanMins},2)`,
    `requests | extend ua=coalesce(tostring(customDimensions["User-Agent"]), tostring(customDimensions["user-agent"]), tostring(customDimensions["http.user_agent"]), client_Browser) | where isnotempty(ua) and (ua contains "bot" or ua contains "crawl" or ua contains "spider" or ua contains "facebookexternalhit" or ua contains "Scrapy" or ua contains "python-requests" or ua contains "Go-http" or ua contains "curl" or ua contains "wget" or ua contains "HeadlessChrome" or ua contains "PhantomJS") | summarize n=count() by ua | top 10 by n desc | project userAgent=ua, count=n, rpm=round(todouble(n)/${spanMins},2)`,
    `requests | extend dimIp=tostring(customDimensions["Client IP Address"]), ua=coalesce(tostring(customDimensions["User-Agent"]), tostring(customDimensions["user-agent"]), tostring(customDimensions["http.user_agent"]), client_Browser) | extend rawIp=iff(isnotempty(dimIp) and dimIp != "::1", dimIp, iff(isnotempty(client_IP) and client_IP != "::1", client_IP, "")) | extend identifier=iff(isempty(rawIp), ua, rawIp) | where isnotempty(identifier) | summarize requestCount=count() by bin(timestamp,1m), identifier, client_CountryOrRegion, ua | summarize totalCount=sum(requestCount), peakRpm=max(requestCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by identifier, client_CountryOrRegion, ua | where peakRpm > 5 | top 5 by totalCount desc | project timestamp=firstSeen, lastSeen, ip=identifier, country=client_CountryOrRegion, userAgent=ua, count=totalCount, rpm=todouble(peakRpm)`,
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

  let urlRows, failedUrlRows, slowUrlRows, failed4xxRows, failed5xxRows, total4xxRows, total5xxRows, topDepRows, errorTypeRows, errorDetailRows;
  let ipRows, uaRows, botRows, hfRows, snatDetailRows, sqlHttpDetailRows;
  let depTimeoutRows;
  let insightResult;
  let groupCRows = null;

  if (summaryOnly) {
    // Only fetch summary aggregates needed for collapsed badges (2 HTTP calls)
    const [[t4xx, t5xx, etRows, dtRows], ins] = await Promise.all([
      runBatch([groupAKqls[5], groupAKqls[6], groupAKqls[8], groupAKqls[10]]),
      runQueryFull(insightKql),
    ]);
    total4xxRows = t4xx; total5xxRows = t5xx; errorTypeRows = etRows; depTimeoutRows = dtRows;
    insightResult = ins;
    urlRows = null; failedUrlRows = null; slowUrlRows = null; failed4xxRows = null; failed5xxRows = null;
    topDepRows = null; errorDetailRows = null;
    ipRows = null; uaRows = null; botRows = null; hfRows = null; snatDetailRows = null; sqlHttpDetailRows = null;
  } else {
    [[urlRows, failedUrlRows, slowUrlRows, failed4xxRows, failed5xxRows, total4xxRows, total5xxRows, topDepRows, errorTypeRows, errorDetailRows, depTimeoutRows], [ipRows, uaRows, botRows, hfRows, snatDetailRows, sqlHttpDetailRows], insightResult, groupCRows] = await Promise.all([
      runBatch(groupAKqls),
      runBatch(groupBKqls),
      runQueryFull(insightKql),
      runBatch(groupCKqls),
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
    urls:        parseOrErr(urlRows,       ([url, count, rpm])    => ({ url: String(url),       count: Number(count), rpm: Number(rpm) })),
    ips:         parseOrErr(ipRows,        ([ip, count, rpm])     => ({ ip: String(ip),         count: Number(count), rpm: Number(rpm) })),
    userAgents:  parseOrErr(uaRows,        ([ua, count, rpm])     => ({ userAgent: String(ua),  count: Number(count), rpm: Number(rpm) })),
    bots:        parseOrErr(botRows,       ([ua, count, rpm])     => ({ userAgent: String(ua),  count: Number(count), rpm: Number(rpm) })),
    highFreq:    parseOrErr(hfRows,        ([ts, lastSeen, ip, country, ua, count, rpm]) => ({ timestamp: String(ts), lastSeen: String(lastSeen), ip: String(ip), country: String(country), userAgent: String(ua), count: Number(count), rpm: Number(rpm) })),
    failedUrls:  parseOrErr(failedUrlRows, ([url, totalCount, failCount, p95, p99]) => ({ url: String(url), totalCount: Number(totalCount) || 0, count: Number(failCount) || 0, p95: Math.round(Number(p95) || 0), p99: Math.round(Number(p99) || 0) })),
    failed4xxUrls: parseOrErr(failed4xxRows, ([url, totalCount, failCount, p95, p99]) => ({ url: String(url), totalCount: Number(totalCount) || 0, count: Number(failCount) || 0, p95: Math.round(Number(p95) || 0), p99: Math.round(Number(p99) || 0) })),
    failed5xxUrls: parseOrErr(failed5xxRows, ([url, totalCount, failCount, p95, p99]) => ({ url: String(url), totalCount: Number(totalCount) || 0, count: Number(failCount) || 0, p95: Math.round(Number(p95) || 0), p99: Math.round(Number(p99) || 0) })),
    slowUrls:    parseOrErr(slowUrlRows,   ([url, avgMs, p99Ms, maxMs, count]) => ({ url: String(url), avgMs: Number(avgMs), p99Ms: Number(p99Ms), maxMs: Number(maxMs), count: Number(count) })),
    total4xx: Array.isArray(total4xxRows) && total4xxRows[0] ? Number(total4xxRows[0][0]) || 0 : null,
    total5xx: Array.isArray(total5xxRows) && total5xxRows[0] ? Number(total5xxRows[0][0]) || 0 : null,
    snatDetails: Array.isArray(snatDetailRows) ? snatDetailRows.map(([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, innermostType, innermostMethod, parsedStack]) => ({ timestamp: String(timestamp ?? ''), type: String(type ?? 'Unknown'), outerMessage: String(outerMessage ?? ''), method: String(method ?? ''), assembly: String(assembly ?? ''), operation_Name: String(operation_Name ?? ''), innermostMessage: String(innermostMessage ?? ''), severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: String(handledAt ?? ''), cloud_RoleName: String(cloud_RoleName ?? ''), innermostType: String(innermostType ?? ''), innermostMethod: String(innermostMethod ?? ''), parsedStack: String(parsedStack ?? '') })) : null,
    sqlHttpDetails: Array.isArray(sqlHttpDetailRows) ? sqlHttpDetailRows.map(([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, innermostType, innermostMethod, parsedStack]) => ({ timestamp: String(timestamp ?? ''), type: String(type ?? 'Unknown'), outerMessage: String(outerMessage ?? ''), method: String(method ?? ''), assembly: String(assembly ?? ''), operation_Name: String(operation_Name ?? ''), innermostMessage: String(innermostMessage ?? ''), severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: String(handledAt ?? ''), cloud_RoleName: String(cloud_RoleName ?? ''), innermostType: String(innermostType ?? ''), innermostMethod: String(innermostMethod ?? ''), parsedStack: String(parsedStack ?? '') })) : null,
    topDependencies: Array.isArray(topDepRows) ? topDepRows.map(([classification, name, type, target, totalCount, failCount, avgDuration, p95, p99]) => ({ classification: classification === 'internal' ? 'internal' : classification === 'assets' ? 'assets' : 'thirdParty', name: String(name), type: String(type), target: String(target), totalCount: Number(totalCount) || 0, failCount: Number(failCount) || 0, avgDuration: Math.round(Number(avgDuration) || 0), p95: Math.round(Number(p95) || 0), p99: Math.round(Number(p99) || 0) })) : null,
    errorTypes: Array.isArray(errorTypeRows) ? errorTypeRows.map(([type, count]) => ({ type: String(type || 'Unknown'), count: Number(count) || 0 })) : null,
    errorCount: Array.isArray(errorTypeRows) ? errorTypeRows.reduce((s, [, c]) => s + (Number(c) || 0), 0) : null,
    errorDetails: Array.isArray(errorDetailRows) ? errorDetailRows.map(([timestamp, type, outerMessage, method, assembly, operation_Name, innermostMessage, severityLevel, handledAt, cloud_RoleName, client_Browser, client_OS, innermostType, innermostMethod, parsedStack]) => ({ timestamp: String(timestamp ?? ''), type: String(type ?? 'Unknown'), outerMessage: String(outerMessage ?? ''), method: String(method ?? ''), assembly: String(assembly ?? ''), operation_Name: String(operation_Name ?? ''), innermostMessage: String(innermostMessage ?? ''), severityLevel: severityLevel != null ? Number(severityLevel) : null, handledAt: String(handledAt ?? ''), cloud_RoleName: String(cloud_RoleName ?? ''), client_Browser: String(client_Browser ?? ''), client_OS: String(client_OS ?? ''), innermostType: String(innermostType ?? ''), innermostMethod: String(innermostMethod ?? ''), parsedStack: String(parsedStack ?? '') })) : null,
    dependencyTimeouts: Array.isArray(depTimeoutRows) ? depTimeoutRows.map(([name, resultCode, depType, p95, maxMs, count]) => ({ name: String(name ?? ''), resultCode: String(resultCode ?? ''), type: String(depType ?? ''), p95: Math.round(Number(p95) || 0), maxMs: Math.round(Number(maxMs) || 0), count: Number(count) || 0 })) : null,
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
    instances, availability, responseTime, requests, failedRequests, failedRequestsSeries,
    instanceHealthSeries, instanceProbeSeries, requestInsights, http4xxSeries, requestSeries,
    aiFailedByInstance, caTimeSeries, connections, userStats,
    dbCpu, dbMemory,
  ] = await Promise.all([
    queryMetric(client, metricsResId, 'CpuPercentage', range, gran, customStart, customEnd),
    fetchMemory(),
    isAppService ? getInstances(token, resId, range, gran, customStart, customEnd) : getReplicas(token, resId),
    getAvailability(client, token, resId, app.type, range, gran, customStart, customEnd, aiAppId, credential),
    isAppService ? getResponseTime(client, resId, range, gran, customStart, customEnd) : Promise.resolve(null),
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
    isAppService ? queryMetric(client, resId, 'AppConnections', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    aiAppId ? getUserStats(aiAppId, credential, range, customStart, customEnd, gran).catch(() => null) : Promise.resolve(null),
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
  let apiFailedDependencies = null;
  let apiAppInsightsConfigured = false;
  let apiConnections = null;
  if (app.apiName) {
    const apiResId = resourceId(subscriptionId, {
      type: app.apiType || 'appservice',
      resourceGroup: app.resourceGroup,
      name: app.apiName,
    });

    const apiIsContainerApp = (app.apiType || 'appservice') === 'containerapp';
    // Resolve apiAiAppId in parallel with instances + health
    const [apiInst, apiHealth, apiAiAppId, apiConn] = await Promise.all([
      apiIsContainerApp ? getReplicas(token, apiResId) : getInstances(token, apiResId, range, gran, customStart, customEnd).catch(() => null),
      apiIsContainerApp ? Promise.resolve(null) : getInstanceHealthSeries(client, apiResId, range, gran, customStart, customEnd).catch(() => null),
      app.apiInsightsAppId
        ? Promise.resolve(app.apiInsightsAppId)
        : (apiIsContainerApp ? Promise.resolve(null) : findAppInsightsAppId(token, subscriptionId, app.resourceGroup, app.apiName).catch(() => null)),
      apiIsContainerApp ? Promise.resolve(null) : queryMetric(client, apiResId, 'AppConnections', range, gran, customStart, customEnd).catch(() => null),
    ]);
    apiInstances = apiInst;
    apiInstanceHealthSeries = apiHealth;
    apiConnections = apiConn;

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
      apiFailedDependencies = null;

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
    connections: isAppService ? connections : null,
    apiConnections: apiConnections ?? null,
    plan,
    instances,
    apiInstances,
    responseTime: isAppService ? responseTime : (caTimeSeries?.responseTime ?? null),
    availability: refinedAvailability,
    requests: isAppService ? requests : (caInsight?.totalRequests != null ? { total: caInsight.totalRequests } : null),
    failedRequests: isAppService ? failedRequests : (caInsight?.failedRequests != null ? { total: caInsight.failedRequests } : null),
    failedRequestsSeries: effectiveFailedSeries,
    http4xxSeries: isAppService ? (http4xxSeries ?? null) : (caTimeSeries?.http4xxSeries ?? null),
    requestsSeries: isAppService ? requestSeries : (caTimeSeries?.requestsSeries ?? null),
    instanceHealthSeries: effectiveInstanceHealth,
    apiInstanceHealthSeries: apiInstanceHealthSeries ?? null,
    instanceProbeSeries: (instanceProbeSeries && instanceProbeSeries.length) ? instanceProbeSeries : null,
    requestInsights,
    failedDependencies: null,
    appInsightsConfigured: !!aiAppId,
    apiRequestInsights: apiRequestInsights ?? null,
    apiFailedDependencies: apiFailedDependencies ?? null,
    apiAppInsightsConfigured,
    users: userStats ?? null,
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

  if (!aiAppId) return { requestInsights: null, apiRequestInsights: null, failedDependencies: null, apiFailedDependencies: null, socketMetrics, apiSocketMetrics };

  const apiIsContainerApp = apiIsContainerAppEarly;
  const [appHostnames, apiHostnames] = await Promise.all([
    getAppHostnames(token, resourceId(subscriptionId, app), app.type),
    app.apiName
      ? getAppHostnames(token, resourceId(subscriptionId, { name: app.apiName, resourceGroup: app.resourceGroup, type: apiIsContainerApp ? 'containerapp' : 'appservice' }), apiIsContainerApp ? 'containerapp' : 'appservice')
      : Promise.resolve([]),
  ]);
  const internalCondition = buildInternalCondition(app, [...appHostnames, ...apiHostnames]);

  const [requestInsights, apiRequestInsights, failedDependencies, apiFailedDependencies] = await Promise.all([
    getRequestInsights(aiAppId, credential, range, customStart, customEnd, false, internalCondition).catch(() => null),
    apiAiAppId ? getRequestInsights(apiAiAppId, credential, range, customStart, customEnd, false, internalCondition).catch(() => null) : Promise.resolve(null),
    getFailedDependencies(aiAppId, credential, range, customStart, customEnd, internalCondition).catch(() => null),
    apiAiAppId ? getFailedDependencies(apiAiAppId, credential, range, customStart, customEnd, internalCondition).catch(() => null) : Promise.resolve(null),
  ]);

  return { requestInsights, apiRequestInsights, failedDependencies: failedDependencies ?? null, apiFailedDependencies: apiFailedDependencies ?? null, socketMetrics, apiSocketMetrics };
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

module.exports = handler;
