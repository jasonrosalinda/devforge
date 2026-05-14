'use strict';

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

function resourceId(subscriptionId, app) {
  if (app.type === 'appservice') {
    return `/subscriptions/${subscriptionId}/resourceGroups/${app.resourceGroup}/providers/Microsoft.Web/sites/${app.name}`;
  }
  return `/subscriptions/${subscriptionId}/resourceGroups/${app.resourceGroup}/providers/Microsoft.App/containerApps/${app.name}`;
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

async function getInstances(token, resId) {
  const headers = { Authorization: `Bearer ${token}` };
  const res = await fetch(`https://management.azure.com${resId}/instances?api-version=2022-03-01`, { headers });
  if (!res.ok) return [];
  const data = await res.json();

  const healthMap = {};
  try {
    const hcRes = await fetch(
      `https://management.azure.com${resId}/providers/microsoft.insights/metrics` +
      `?api-version=2023-10-01&metricnames=HealthCheckStatus&timespan=PT1H&interval=PT5M` +
      `&aggregation=average&$filter=Instance+eq+%27*%27`,
      { headers }
    );
    if (hcRes.ok) {
      const hd = await hcRes.json();
      const timeseries = hd?.value?.[0]?.timeseries ?? [];
      for (const ts of timeseries) {
        const key = ts.metadatavalues?.find(m => m.name?.value === 'instance')?.value?.toLowerCase() ?? '';
        const lastVal = ts.data?.filter(d => d.average != null).at(-1)?.average;
        if (key) healthMap[key] = lastVal === 1 ? 'Healthy' : lastVal === 0 ? 'Degraded' : 'Unknown';
      }
    }
  } catch { /* ignore */ }

  return (data.value || []).map(i => {
    const props = i.properties ?? {};
    const machineName = props.machineName || i.name || '';
    const zone = props.physicalZone || props.availabilityZone || '';
    const state = props.state || '';
    const healthStatus =
      healthMap[i.name?.toLowerCase()] ??
      healthMap[machineName.toLowerCase()] ??
      (state === 'READY' ? 'Healthy' : state === 'STOPPED' ? 'Stopped' : 'Unknown');
    return { name: machineName, zone, healthStatus };
  });
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
      const series = (ts_.data || []).map(d => {
        const t = d.timeStamp instanceof Date ? d.timeStamp.toISOString() : String(d.timeStamp);
        const total = d.total ?? 0;
        const failed = errByTime.get(t) ?? 0;
        const v = total > 0 ? Math.round((total - failed) / total * 1000) / 10 : 100;
        return { t, v };
      });
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
    return { avg: s.avg, max: s.max, series };
  } catch {
    return null;
  }
}

function extractDowntimeIntervals(series) {
  const intervals = [];
  let start = null;
  for (const p of series) {
    const down = (p.average ?? 100) < 95;
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

/**
 * Classify confirmed downtime by instance impact.
 * one instance affected → instance_crash
 * all instances affected → full_outage
 * instances healthy      → dependency_failure
 */
function classifyDowntimeCause(interval, { instanceHealthSeries }) {
  const { start, end } = interval;
  const total = instanceHealthSeries?.length ?? 0;
  if (total === 0) return 'outage';
  let affected = 0;
  for (const inst of instanceHealthSeries) {
    const bad = inst.series.some(p => {
      const t = new Date(p.t).getTime();
      return t >= start && t <= end && p.v < 50;
    });
    if (bad) affected++;
  }
  if (affected === total) return 'full_outage';
  if (affected >= 1)      return 'instance_crash';
  return 'dependency_failure';
}

/**
 * Strict 4-condition downtime detection.
 * DOWN only when ALL are true for 2+ consecutive points:
 *   1. availability < 100%
 *   2. failed (5xx) requests > 0
 *   3. 5xx dominant over 4xx (not auth/client errors)
 *   4. at least one probe failure (if probe data available)
 * Closes after 3+ consecutive clean points.
 */
function extractDowntimeIntervalsMultiSignal(availSeries, failedSeries5xx, http4xxSeries, probeSeries) {
  if (!availSeries || !availSeries.length) return [];

  const OPEN_THRESHOLD  = 2;
  const CLOSE_THRESHOLD = 3;

  const granMs = availSeries.length > 1
    ? new Date(availSeries[1].t).getTime() - new Date(availSeries[0].t).getTime()
    : 15 * 60_000;

  const fail5xxMap = new Map((failedSeries5xx || []).map(p => [p.t, p.count]));
  const fail4xxMap = new Map((http4xxSeries   || []).map(p => [p.t, p.count]));

  function probeFailAt(tMs) {
    if (!probeSeries || !probeSeries.length) return false;
    return probeSeries.some(inst => {
      if (!inst.series.length) return false;
      const closest = inst.series.reduce((best, s) =>
        Math.abs(new Date(s.t).getTime() - tMs) < Math.abs(new Date(best.t).getTime() - tMs) ? s : best
      , inst.series[0]);
      return Math.abs(new Date(closest.t).getTime() - tMs) < granMs && closest.v < 50;
    });
  }

  const intervals = [];
  let consecBad   = 0;
  let consecGood  = 0;
  let incidentStart = null;

  for (const p of availSeries) {
    const tMs    = new Date(p.t).getTime();
    const fail5  = fail5xxMap.get(p.t) ?? 0;
    const fail4  = fail4xxMap.get(p.t) ?? 0;
    const cond1  = p.v < 100;
    const cond2  = fail5 > 0;
    const cond3  = fail5 > 0 && (fail4 === 0 || fail5 >= fail4);
    const cond4  = (probeSeries && probeSeries.length) ? probeFailAt(tMs) : true;
    const isDown = cond1 && cond2 && cond3 && cond4;

    if (isDown) {
      consecBad++;
      consecGood = 0;
      if (consecBad === OPEN_THRESHOLD && incidentStart === null) {
        incidentStart = tMs - (OPEN_THRESHOLD - 1) * granMs;
      }
    } else {
      consecGood++;
      consecBad = 0;
      if (consecGood >= CLOSE_THRESHOLD && incidentStart !== null) {
        intervals.push({ start: incidentStart, end: tMs - (CLOSE_THRESHOLD - 1) * granMs });
        incidentStart = null;
      }
    }
  }

  if (incidentStart !== null) {
    intervals.push({ start: incidentStart, end: new Date(availSeries[availSeries.length - 1].t).getTime() });
  }

  return intervals;
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
| summarize total=count(), failedCount=countif(success==false) by cloud_RoleInstance, bin(timestamp, 1m)
| extend healthPct=iif(total>0, round(todouble(total-failedCount)/todouble(total)*100.0, 1), 100.0)
| order by timestamp asc`;
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = data.tables?.[0]?.rows || [];
    // rows: [cloud_RoleInstance, timestamp, total, failedCount, healthPct]
    return rows.map(([instance, ts, total, failedCount, healthPct]) => ({
      t:          new Date(ts).toISOString(),
      instance:   instance ?? 'unknown',
      count:      Number(failedCount) || 0,
      totalCount: Number(total) || 0,
      healthPct:  Math.round(Number(healthPct) * 10) / 10,
    }));
  } catch { return null; }
}

async function getFailedDependencies(appId, credential, range, customStart, customEnd) {
  try {
    const aiToken = await credential.getToken('https://api.applicationinsights.io/.default');
    const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
    const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
    const query = `dependencies
| where success == false
| extend depType = type, depTarget = target
| summarize failCount=count(), avgDuration=avg(duration) by name, depType, depTarget, bin(timestamp, 1m)
| order by timestamp asc`;
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rows = data.tables?.[0]?.rows || [];
    return rows.map(([name, depType, depTarget, ts, failCount, avgDuration]) => ({
      t:           new Date(ts).toISOString(),
      name:        name      ?? '(unknown)',
      type:        depType   ?? '(unknown)',
      target:      depTarget ?? '',
      failCount:   Number(failCount)   || 0,
      avgDuration: Math.round(Number(avgDuration) || 0),
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

    // Match by instrumentation key first, then by name
    let component = ikey
      ? value.find(c => c.properties?.InstrumentationKey?.toLowerCase() === ikey.toLowerCase())
      : null;
    if (!component) {
      component = value.find(c => c.name?.toLowerCase() === appName.toLowerCase());
    }
    return component ? component.properties.AppId : null;
  } catch { return null; }
}

async function getRequestInsights(appId, credential, range, customStart, customEnd) {
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

  const [urlRows, ipRows, uaRows, botRows, hfRows, failedUrlRows, slowUrlRows] = await Promise.all([
    runQuery(`requests | summarize n=count() by name | top 10 by n desc | project url=name, count=n, rpm=round(todouble(n)/${spanMins},2)`),
    runQuery(`requests | extend ip=iff(isnotempty(client_IP) and client_IP != "::1", client_IP, tostring(customDimensions["Client IP Address"])) | where isnotempty(ip) | summarize n=count() by ip | top 10 by n desc | project ip, count=n, rpm=round(todouble(n)/${spanMins},2)`),
    runQuery(`requests | extend ua=tostring(customDimensions["User-Agent"]) | summarize n=count() by ua | top 10 by n desc | project userAgent=ua, count=n, rpm=round(todouble(n)/${spanMins},2)`),
    runQuery(`requests | extend ua=tostring(customDimensions["User-Agent"]) | where ua contains "bot" or ua contains "crawl" or ua contains "spider" or ua contains "facebookexternalhit" | summarize n=count() by ua | top 10 by n desc | project userAgent=ua, count=n, rpm=round(todouble(n)/${spanMins},2)`),
    runQuery(`requests | extend dimIp=tostring(customDimensions["Client IP Address"]), ua=tostring(customDimensions["User-Agent"]) | extend rawIp=iff(isnotempty(dimIp) and dimIp != "::1", dimIp, iff(isnotempty(client_IP) and client_IP != "::1", client_IP, "")) | extend identifier=iff(isempty(rawIp), ua, rawIp) | where isnotempty(identifier) | summarize requestCount=count() by bin(timestamp,1m), identifier, client_CountryOrRegion, ua | summarize totalCount=sum(requestCount), peakRpm=max(requestCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by identifier, client_CountryOrRegion, ua | where peakRpm > 5 | top 5 by totalCount desc | project timestamp=firstSeen, lastSeen, ip=identifier, country=client_CountryOrRegion, userAgent=ua, count=totalCount, rpm=todouble(peakRpm)`),
    runQuery(`requests | where success == false | summarize n=count() by name | top 10 by n desc | project url=name, count=n, rpm=round(todouble(n)/${spanMins},2)`),
    runQuery(`requests | summarize avgMs=avg(duration), maxMs=max(duration), n=count() by name | top 10 by maxMs desc | project url=name, avgMs=round(avgMs,1), maxMs=round(maxMs,1), count=n`),
  ]);

  const parseOrErr = (rows, mapper) => Array.isArray(rows) ? rows.map(mapper) : rows;

  return {
    urls:        parseOrErr(urlRows,       ([url, count, rpm])    => ({ url: String(url),       count: Number(count), rpm: Number(rpm) })),
    ips:         parseOrErr(ipRows,        ([ip, count, rpm])     => ({ ip: String(ip),         count: Number(count), rpm: Number(rpm) })),
    userAgents:  parseOrErr(uaRows,        ([ua, count, rpm])     => ({ userAgent: String(ua),  count: Number(count), rpm: Number(rpm) })),
    bots:        parseOrErr(botRows,       ([ua, count, rpm])     => ({ userAgent: String(ua),  count: Number(count), rpm: Number(rpm) })),
    highFreq:    parseOrErr(hfRows,        ([ts, lastSeen, ip, country, ua, count, rpm]) => ({ timestamp: String(ts), lastSeen: String(lastSeen), ip: String(ip), country: String(country), userAgent: String(ua), count: Number(count), rpm: Number(rpm) })),
    failedUrls:  parseOrErr(failedUrlRows, ([url, count, rpm])    => ({ url: String(url),       count: Number(count), rpm: Number(rpm) })),
    slowUrls:    parseOrErr(slowUrlRows,   ([url, avgMs, maxMs, count]) => ({ url: String(url), avgMs: Number(avgMs), maxMs: Number(maxMs), count: Number(count) })),
  };
}

async function getCpuMemoryFromAppInsights(appId, credential, range, granularity, customStart, customEnd) {
  try {
    const aiToken = await credential.getToken('https://api.applicationinsights.io/.default');
    const { startTime, endTime } = buildTimespan(range, customStart, customEnd);
    const granMins = granularity === 'PT5M' ? 5 : granularity === 'PT15M' ? 15 : granularity === 'PT1H' ? 60 : 5;
    const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
    const query = `performanceCounters | where (category == "Processor" and name == "% Processor Time" and instance == "_Total") or (category == "Process" and name == "Working Set") | summarize avgVal=avg(value), maxVal=max(value) by bin(timestamp,${granMins}m), name | project timestamp, name, avgVal, maxVal | order by timestamp asc`;
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const { tables } = await res.json();
    const rows = tables?.[0]?.rows || [];
    if (!rows.length) return null;
    const cpuRows = rows.filter(r => r[1] === '% Processor Time');
    const memRows = rows.filter(r => r[1] === 'Working Set');
    if (!cpuRows.length) return null;
    const toSeries = (arr, divisor = 1) => arr.map(([ts, , avg, max]) => ({
      t: new Date(ts).toISOString(),
      v: Math.round(avg / divisor * 10) / 10,
      m: Math.round(max / divisor * 10) / 10,
    }));
    const cpuSeries = toSeries(cpuRows);
    const memSeries = toSeries(memRows, 1024 * 1024);
    const avg = arr => arr.reduce((s, p) => s + p.v, 0) / arr.length;
    const max = arr => Math.max(...arr.map(p => p.m));
    return {
      cpu: { avg: Math.round(avg(cpuSeries) * 10) / 10, max: Math.round(max(cpuSeries) * 10) / 10, series: cpuSeries },
      memory: memSeries.length ? { avg: Math.round(avg(memSeries) * 10) / 10, max: Math.round(max(memSeries) * 10) / 10, series: memSeries } : null,
      memUnit: memSeries.length ? 'MB' : null,
    };
  } catch { return null; }
}

async function fetchAppMetrics(client, token, credential, app, subscriptionId, range, customStart, customEnd, granularityOverride) {
  const resId = resourceId(subscriptionId, app);
  const spanHours = (customStart && customEnd) ? (new Date(customEnd) - new Date(customStart)) / 3_600_000 : Infinity;
  const gran = spanHours <= 2
    ? 'PT1M'
    : (granularityOverride || ((customStart && customEnd) ? getCustomGranularity(customStart, customEnd) : getGranularity(range)));

  const isAppService = app.type === 'appservice';

  // Resolve plan (needed for metricsResId) and aiAppId in parallel
  const [planResult, aiAppId] = await Promise.all([
    isAppService ? getPlanInfo(token, resId).catch(() => null) : Promise.resolve(null),
    isAppService
      ? (app.appInsightsAppId
          ? Promise.resolve(app.appInsightsAppId)
          : findAppInsightsAppId(token, subscriptionId, app.resourceGroup, app.name).catch(() => null))
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
    aiFailedByInstance, failedDependencies,
  ] = await Promise.all([
    queryMetric(client, metricsResId, 'CpuPercentage', range, gran, customStart, customEnd),
    fetchMemory(),
    isAppService ? getInstances(token, resId) : getReplicas(token, resId),
    getAvailability(client, token, resId, app.type, range, gran, customStart, customEnd, aiAppId, credential),
    isAppService ? getResponseTime(client, resId, range, gran, customStart, customEnd) : Promise.resolve(null),
    isAppService ? queryCountMetrics(client, resId, ['Requests'], range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? queryCountMetrics(client, resId, ['Http4xx', 'Http5xx'], range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? queryFailedRequestsSeries(client, resId, range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? getInstanceHealthSeries(client, resId, range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? getInstanceProbeSeries(client, resId, range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    aiAppId ? getRequestInsights(aiAppId, credential, range, customStart, customEnd) : Promise.resolve(null),
    isAppService ? queryCountSeries(client, resId, 'Http4xx', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    isAppService ? queryCountSeries(client, resId, 'Requests', range, gran, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    aiAppId ? getFailedRequestsByInstance(aiAppId, credential, range, customStart, customEnd).catch(() => null) : Promise.resolve(null),
    aiAppId ? getFailedDependencies(aiAppId, credential, range, customStart, customEnd).catch(() => null) : Promise.resolve(null),
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
      for (const row of aiFailedByInstance) {
        if (!instMap.has(row.instance)) instMap.set(row.instance, []);
        instMap.get(row.instance).push({ t: row.t, v: row.healthPct });
      }
      return Array.from(instMap.entries()).map(([name, series]) => ({ name, series }));
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

  return {
    label: app.name,
    type: app.type,
    cpu,
    memory,
    cpuUnit: '%',
    memUnit,
    plan,
    instances,
    responseTime,
    availability: refinedAvailability,
    requests,
    failedRequests,
    failedRequestsSeries: effectiveFailedSeries,
    http4xxSeries: http4xxSeries ?? null,
    requestsSeries: requestSeries,
    instanceHealthSeries: effectiveInstanceHealth,
    instanceProbeSeries: (instanceProbeSeries && instanceProbeSeries.length) ? instanceProbeSeries : null,
    requestInsights,
    failedDependencies: failedDependencies ?? null,
    appInsightsConfigured: !!aiAppId,
  };
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
    { name: 'Socket Exceptions',
      kql: `exceptions | where {BETWEEN} | where outerMessage has_any ("SocketException","timeout","No buffer space available","actively refused","ENOBUFS") | summarize Count=count() by outerMessage | order by Count desc` },
    { name: 'Dependency Duration Spike',
      kql: `dependencies | where {BETWEEN} | summarize Failures=countif(success==false), P95=percentile(duration,95) by bin(timestamp,5m) | order by timestamp asc` },
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
    try {
      const cred = new DefaultAzureCredential();
      await cred.getToken('https://management.azure.com/.default');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
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
        const app = appsMap[key];
        if (!app) {
          results[key] = {
            label: key,
            type: 'appservice',
            cpu: { avg: 0, max: 0, series: [] },
            memory: { avg: 0, max: 0, series: [] },
            cpuUnit: '%',
            memUnit: '%',
            error: `App "${key}" not found in configuration.`,
          };
          return;
        }
        try {
          results[key] = await fetchAppMetrics(client, token, cred, app, config.subscriptionId, range, customStart, customEnd, granularity);
        } catch (err) {
          results[key] = {
            label: app.name,
            type: app.type || 'appservice',
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
    const sub = (kql) => kql.replace(/\{BETWEEN\}/g, between);

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
