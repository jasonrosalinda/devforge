'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

// Exception bucket classifiers, shared with the app health check so both
// features agree on what a socket failure is.
const {
  SOCKET_MATCH,
  TIMEOUT_MATCH,
  TIMEOUT_ONLY_MATCH,
  OOM_ONLY_MATCH,
  BUCKET_EXPR,
  TIMEOUT_RESULT_CODES,
} = require('./exception-buckets.cjs');

// Downtime detection and socket metric names, shared with the dashboard so both
// features call the same window an outage and agree on its cause.
const {
  SOCKET_METRIC_NAMES,
  DOWNTIME_CAUSE_LABEL,
  classifyDowntimeCause,
  extractDowntimeIntervalsMultiSignal,
} = require('./azure-signals.cjs');

const REPORTS_DIR = path.join(os.homedir(), '.claude', 'agents', 'incident-reports');

// ── Helpers ───────────────────────────────────────────────────────────────────

function msToSGT(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const MM = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return {
    display: `${yyyy}-${MM}-${dd} ${hh}:${mm} SGT`,
    file: `${yyyy}${MM}${dd}${hh}${mm}`,
  };
}

const INCIDENT_NUMBERS_FILE = path.join(REPORTS_DIR, 'incident-numbers.json');

/** Stable `INC-YYYYMM-NNN` for an incident, keyed by app + window so re-running the
 *  analysis for the same incident reuses its number instead of minting a new one.
 *  The sequence runs per calendar month of the incident's start (SGT). */
function assignIncidentNumber({ appName, startMs, endMs }) {
  const month = msToSGT(startMs).file.slice(0, 6);
  const key = `${appName}|${startMs}|${endMs}`;
  try {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const store = fs.existsSync(INCIDENT_NUMBERS_FILE)
      ? JSON.parse(fs.readFileSync(INCIDENT_NUMBERS_FILE, 'utf8'))
      : {};
    if (typeof store[key] === 'string') return store[key];
    const usedThisMonth = Object.values(store).filter(n => typeof n === 'string' && n.startsWith(`INC-${month}-`)).length;
    const number = `INC-${month}-${String(usedThisMonth + 1).padStart(3, '0')}`;
    store[key] = number;
    fs.writeFileSync(INCIDENT_NUMBERS_FILE, JSON.stringify(store, null, 2), 'utf8');
    return number;
  } catch {
    // The number is presentation, not analysis — never fail an RCA over it.
    return `INC-${month}-001`;
  }
}

function msFormat(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

// Azure ARM and App Insights both return UTC ISO strings. EVERY timestamp
// rendered into the report must go through these, because the RCA prompt tells
// the model the telemetry is already SGT — before this, most sections leaked raw
// UTC and the model dated every incident 8 hours early.
function sgt(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return isNaN(ms) ? '—' : msToSGT(ms).display;
}

// "14:05" — for dense table columns where the date is already in the header.
function sgtTime(t) {
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return isNaN(ms) ? '—' : msToSGT(ms).display.slice(11, 16);
}

// "2h 14m" / "45m" / "30s" — interval durations.
function durFormat(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '—';
  // Sub-minute spans stay in seconds. Rounding to minutes first would turn 30s
  // into "1m", which reads as twice the real duration.
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── ARM metric fetch ──────────────────────────────────────────────────────────

function metricsUrl(resId, metricName, startTime, endTime, interval, aggregations, filter) {
  const aggStr = aggregations.join(',').toLowerCase();
  const ts = `${startTime.toISOString()}/${endTime.toISOString()}`;
  return `https://management.azure.com${resId}/providers/microsoft.insights/metrics` +
    `?api-version=2023-10-01&metricnames=${encodeURIComponent(metricName)}` +
    `&timespan=${encodeURIComponent(ts)}&interval=${interval}&aggregation=${aggStr}` +
    (filter ? `&$filter=${encodeURIComponent(filter)}` : '');
}

async function fetchMetric(token, resId, metricName, startTime, endTime, interval, aggregations, filter) {
  try {
    const res = await fetch(metricsUrl(resId, metricName, startTime, endTime, interval, aggregations, filter), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.value?.[0]?.timeseries?.[0]?.data || [];
  } catch { return []; }
}

// Same call, but returns EVERY timeseries with its dimension name instead of just
// the first. Needed for per-instance splits (`Instance ne 'N/A'`), where Azure
// returns one timeseries per worker and fetchMetric would silently keep one.
async function fetchMetricSplit(token, resId, metricName, startTime, endTime, interval, aggregations, filter) {
  try {
    const res = await fetch(metricsUrl(resId, metricName, startTime, endTime, interval, aggregations, filter), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const series = data.value?.[0]?.timeseries;
    if (!series?.length) return null;
    return series.map(ts => ({
      name: ts.metadatavalues?.find(m => (m.name?.value ?? m.name)?.toLowerCase() === 'instance')?.value ?? 'unknown',
      data: ts.data || [],
    }));
  } catch { return null; }
}

async function getPlanResId(token, resId) {
  try {
    const res = await fetch(`https://management.azure.com${resId}?api-version=2022-03-01`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.properties?.serverFarmId || null;
  } catch { return null; }
}

// Plan SKU and worker count. Capacity context for the RCA — 85% CPU on a B1 is a
// very different finding from 85% on a P3v3.
async function fetchPlanCapacity(token, planResId) {
  if (!planResId) return null;
  try {
    const res = await fetch(`https://management.azure.com${planResId}?api-version=2022-03-01`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const plan = await res.json();
    return {
      name: planResId.split('/').pop() || '',
      sku: plan.sku?.name || '',
      tier: plan.sku?.tier || '',
      workers: plan.sku?.capacity ?? null,
      maxWorkers: plan.properties?.maximumNumberOfWorkers ?? null,
      zoneRedundant: plan.properties?.zoneRedundant ?? null,
    };
  } catch { return null; }
}

// Outbound socket / TCP state counters — the only DIRECT SNAT evidence available.
// Everything else in the report infers exhaustion from exception text. Published
// on the PLAN, not the site: querying a site returns HTTP 400. Plan-scoped means
// these cover every site sharing the plan, which the report states explicitly.
async function fetchSocketCounters(token, planResId, startTime, endTime) {
  if (!planResId) return null;
  const results = await Promise.all(SOCKET_METRIC_NAMES.map(async (name) => {
    const data = await fetchMetric(token, planResId, name, startTime, endTime, 'PT5M', ['Average', 'Maximum']);
    if (!data.length) return null;
    const avgs = data.map(p => p.average ?? 0);
    const maxs = data.map(p => p.maximum ?? p.average ?? 0);
    const avg = avgs.reduce((s, v) => s + v, 0) / avgs.length;
    const max = Math.max(...maxs);
    if (avg === 0 && max === 0) return null;   // counter not reported on this plan (Linux)
    return { name, avg: Math.round(avg * 10) / 10, max: Math.round(max * 10) / 10 };
  }));
  const metrics = results.filter(Boolean);
  if (!metrics.length) return null;
  return { planName: planResId.split('/').pop() || '', metrics };
}

// ── App Insights KQL ──────────────────────────────────────────────────────────

async function runKQL(appId, aiToken, timespan, query) {
  try {
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data.tables?.[0]?.rows ?? null;
  } catch { return null; }
}

// Same call, but keeps column names so multi-statement joins can be read by
// name instead of by index — adding a column no longer shifts every field.
async function runKQLNamed(appId, aiToken, timespan, query) {
  try {
    const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    const table = data.tables?.[0];
    if (!table?.rows?.length) return null;
    return { cols: (table.columns ?? []).map(c => c.name), rows: table.rows };
  } catch { return null; }
}

// ── Log Analytics workspace KQL (edge / network diagnostic logs) ───────────────

async function runLA(workspaceId, laToken, timespan, query) {
  try {
    const res = await fetch(`https://api.loganalytics.io/v1/workspaces/${workspaceId}/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${laToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, timespan }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.error) return null;
    return data.tables?.[0]?.rows ?? null;
  } catch { return null; }
}

// Pulls App Gateway / Front Door access logs (Log Analytics) and Load Balancer
// availability/SNAT (ARM metrics) for the incident window. Each sub-result is null
// when its resource isn't configured or no rows exist. Never throws.
async function fetchEdgeDiagnostics(armToken, laToken, workspaceId, ids, startTime, endTime) {
  const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
  const { appGatewayResourceId, frontDoorResourceId, loadBalancerResourceId } = ids;
  const configured = {
    workspace: !!workspaceId,
    agw: !!appGatewayResourceId,
    afd: !!frontDoorResourceId,
    lb: !!loadBalancerResourceId,
  };

  const canLA = !!(workspaceId && laToken);

  const agwQuery = (rid) => `union isfuzzy=true
  (AzureDiagnostics | where Category == "ApplicationGatewayAccessLog" | extend status=toint(httpStatus_d), backendMs=todouble(timeTaken_d), rid=_ResourceId),
  (AGWAccessLogs | extend status=toint(httpStatus), backendMs=todouble(timeTaken), rid=_ResourceId)
| where rid =~ "${rid}"
| summarize requests=count(), failed5xx=countif(status>=500), avgBackendMs=round(avg(backendMs),0), p99BackendMs=round(percentile(backendMs,99),0) by bin(TimeGenerated, 5m)
| project TimeGenerated, requests, failed5xx, avgBackendMs, p99BackendMs
| order by TimeGenerated asc | take 60`;

  const afdQuery = (rid) => `union isfuzzy=true
  (AzureDiagnostics | where Category in ("FrontdoorAccessLog","FrontDoorAccessLog") | extend status=toint(httpStatusCode_s), latencyMs=todouble(totalLatency_d), rid=_ResourceId),
  (FrontDoorAccessLog | extend status=toint(httpStatusCode), latencyMs=todouble(totalLatency), rid=_ResourceId)
| where rid =~ "${rid}"
| summarize requests=count(), failed5xx=countif(status>=500), p99LatencyMs=round(percentile(latencyMs,99),0) by bin(TimeGenerated, 5m)
| project TimeGenerated, requests, failed5xx, p99LatencyMs
| order by TimeGenerated asc | take 60`;

  const [agwRows, afdRows, lbDip, lbVip, lbSnat] = await Promise.all([
    canLA && appGatewayResourceId ? runLA(workspaceId, laToken, timespan, agwQuery(appGatewayResourceId)) : Promise.resolve(null),
    canLA && frontDoorResourceId ? runLA(workspaceId, laToken, timespan, afdQuery(frontDoorResourceId)) : Promise.resolve(null),
    loadBalancerResourceId ? fetchMetric(armToken, loadBalancerResourceId, 'DipAvailability', startTime, endTime, 'PT5M', ['Average']).catch(() => []) : Promise.resolve([]),
    loadBalancerResourceId ? fetchMetric(armToken, loadBalancerResourceId, 'VipAvailability', startTime, endTime, 'PT5M', ['Average']).catch(() => []) : Promise.resolve([]),
    loadBalancerResourceId ? fetchMetric(armToken, loadBalancerResourceId, 'SnatConnectionCount', startTime, endTime, 'PT5M', ['Total']).catch(() => []) : Promise.resolve([]),
  ]);

  const appGateway = Array.isArray(agwRows) && agwRows.length
    ? agwRows.map(([time, requests, failed5xx, avgBackendMs, p99BackendMs]) => ({
        time: String(time ?? ''), requests: Number(requests) || 0, failed5xx: Number(failed5xx) || 0,
        avgBackendMs: Number(avgBackendMs) || 0, p99BackendMs: Number(p99BackendMs) || 0,
      }))
    : null;

  const frontDoor = Array.isArray(afdRows) && afdRows.length
    ? afdRows.map(([time, requests, failed5xx, p99LatencyMs]) => ({
        time: String(time ?? ''), requests: Number(requests) || 0, failed5xx: Number(failed5xx) || 0,
        p99LatencyMs: Number(p99LatencyMs) || 0,
      }))
    : null;

  const minAvg = (arr) => (Array.isArray(arr) && arr.length ? Math.min(...arr.map(p => p.average ?? 100)) : null);
  const sumTotal = (arr) => (Array.isArray(arr) ? arr.reduce((s, p) => s + (p.total ?? 0), 0) : 0);
  const loadBalancer = loadBalancerResourceId
    ? { dipAvailMin: minAvg(lbDip), vipAvailMin: minAvg(lbVip), snatTotal: sumTotal(lbSnat) }
    : null;

  return { configured, appGateway, frontDoor, loadBalancer };
}

async function fetchExceptionAnalysis(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
exceptions
| summarize count=count(), firstOccurrence=min(timestamp), lastOccurrence=max(timestamp),
    sampleInnerMsg=any(innermostMessage), sampleOpName=any(operation_Name), sampleInnerType=any(innermostType)
    by type, outerMessage
| order by count desc
| take 20`);
  if (!rows) return null;
  return rows.map(([type, outerMessage, count, firstOccurrence, lastOccurrence, sampleInnerMsg, sampleOpName, sampleInnerType]) => ({
    type: String(type ?? '(unknown)'),
    outerMessage: String(outerMessage ?? ''),
    count: Number(count) || 0,
    firstOccurrence: String(firstOccurrence ?? ''),
    lastOccurrence: String(lastOccurrence ?? ''),
    sampleInnerMsg: String(sampleInnerMsg ?? ''),
    sampleOpName: String(sampleOpName ?? ''),
    sampleInnerType: String(sampleInnerType ?? ''),
  }));
}

async function fetchEndpointLatency(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
requests
| extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)
| summarize count=count(), avgMs=avg(duration), p50=percentile(duration,50),
    p95=percentile(duration,95), p99=percentile(duration,99), maxMs=max(duration),
    failCount=countif(success==false)
    by nameClean
| extend failRate=round(todouble(failCount)/count*100, 2)
| order by p99 desc
| take 20`);
  if (!rows) return null;
  return rows.map(([name, count, avgMs, p50, p95, p99, maxMs, failCount, failRate]) => ({
    name: String(name ?? ''),
    count: Number(count) || 0,
    avgMs: Math.round(Number(avgMs) || 0),
    p50: Math.round(Number(p50) || 0),
    p95: Math.round(Number(p95) || 0),
    p99: Math.round(Number(p99) || 0),
    maxMs: Math.round(Number(maxMs) || 0),
    failCount: Number(failCount) || 0,
    failRate: Number(failRate) || 0,
  }));
}

async function fetchSqlDependencyDeep(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
dependencies
| where type has_any ("SQL", "sqlclient", "Microsoft.Data.SqlClient", "System.Data.SqlClient", "mysql", "postgresql")
| extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)
| summarize callCount=count(), failCount=countif(success==false),
    avgMs=avg(duration), p95=percentile(duration,95), p99=percentile(duration,99),
    timeoutCount=countif(duration > 30000)
    by nameClean, target
| extend failRate=round(todouble(failCount)/callCount*100, 2)
| order by p99 desc
| take 15`);
  if (!rows) return null;
  return rows.map(([name, target, callCount, failCount, avgMs, p95, p99, timeoutCount, failRate]) => ({
    name: String(name ?? ''),
    target: String(target ?? ''),
    callCount: Number(callCount) || 0,
    failCount: Number(failCount) || 0,
    avgMs: Math.round(Number(avgMs) || 0),
    p95: Math.round(Number(p95) || 0),
    p99: Math.round(Number(p99) || 0),
    timeoutCount: Number(timeoutCount) || 0,
    failRate: Number(failRate) || 0,
  }));
}

async function fetchDeploymentEvents(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
traces
| where message has_any ("deploy","restart","swap","slot","Application started","Application is shutting down","Starting","Stopping")
| order by timestamp asc
| project timestamp, message, severityLevel, cloud_RoleInstance
| take 50`);
  if (!rows) return null;
  return rows.map(([timestamp, message, severityLevel, instance]) => ({
    timestamp: String(timestamp ?? ''),
    message: String(message ?? ''),
    severityLevel: Number(severityLevel) || 0,
    instance: String(instance ?? ''),
  }));
}

// Socket-layer and application-timeout indicators in one pass, tagged by bucket
// so the report can score and present them separately. The previous filter also
// matched bare "timed out" and every HttpRequestException, which inflated the
// SNAT signal with ordinary downstream errors.
async function fetchSnatIndicators(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
exceptions
| where ${SOCKET_MATCH} or ${TIMEOUT_MATCH}
| extend bucket = ${BUCKET_EXPR}
| summarize count=count() by bucket, outerMessage, bin(timestamp, 5m)
| order by timestamp asc`);
  if (!rows) return null;
  return rows.map(([bucket, outerMessage, timestamp, count]) => ({
    bucket: bucket === 'socket' ? 'socket' : 'timeout',
    outerMessage: String(outerMessage ?? ''),
    timestamp: String(timestamp ?? ''),
    count: Number(count) || 0,
  }));
}

async function fetchFailedDeps(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
dependencies
| extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)
| where success == false
| summarize failCount=count(), p95=percentile(duration, 95), p99=percentile(duration, 99), avgDuration=avg(duration) by nameClean, type, target
| join kind=leftouter (dependencies | extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name) | summarize totalCount=count() by nameClean, type, target) on nameClean, type, target
| project name=nameClean, type, target, totalCount=coalesce(totalCount, failCount), failCount, avgDuration, p95, p99
| order by failCount desc
| take 30`);
  if (!rows) return null;
  return rows.map(([name, depType, target, totalCount, failCount, avgDuration, p95, p99]) => ({
    name: String(name ?? '(unknown)'),
    type: String(depType ?? '(unknown)'),
    target: String(target ?? ''),
    totalCount: Number(totalCount) || 0,
    failCount: Number(failCount) || 0,
    avgDuration: Math.round(Number(avgDuration) || 0),
    p95: Math.round(Number(p95) || 0),
    p99: Math.round(Number(p99) || 0),
  }));
}

async function fetchTrafficInsight(appId, aiToken, timespan) {
  const result = await runKQLNamed(appId, aiToken, timespan, `
let deps=dependencies|summarize TotalDeps=count(),FailedDeps=countif(success==false),DepFailRate=round(todouble(countif(success==false))/count()*100,2),DepP95=percentile(duration,95),DepP99=percentile(duration,99);
let reqs=requests|summarize TotalReqs=count(),FailedReqs=countif(success==false),ReqFailRate=round(todouble(countif(success==false))/count()*100,2),ReqP95=percentile(duration,95),ReqP99=percentile(duration,99);
let ex=exceptions|summarize SocketLayerExceptions=sumif(itemCount,${SOCKET_MATCH}),TimeoutExceptions=sumif(itemCount,${TIMEOUT_ONLY_MATCH}),OomExceptions=sumif(itemCount,${OOM_ONLY_MATCH}),TotalExceptions=sum(itemCount);
let usr=requests|extend dimIp=tostring(customDimensions["Client IP Address"])|extend rawIp=iff(isnotempty(dimIp) and dimIp !in ("::1","::","0.0.0.0"), dimIp, client_IP)|summarize UniqueUsers=dcount(rawIp);
let bots=requests|extend ua=tostring(customDimensions["User-Agent"])|where ua contains "bot" or ua contains "crawl" or ua contains "spider"|summarize BotRequests=count();
deps|extend JK=1|join kind=inner(reqs|extend JK=1) on JK|join kind=inner(ex|extend JK=1) on JK|join kind=inner(usr|extend JK=1) on JK|join kind=inner(bots|extend JK=1) on JK|project-away JK,JK1,JK2,JK3,JK4`);
  if (!result) return null;
  const { cols, rows } = result;
  const row = rows[0];
  const num = (name) => { const i = cols.indexOf(name); return i >= 0 ? Number(row[i]) || 0 : 0; };
  return {
    totalDeps: num('TotalDeps'),
    failedDeps: num('FailedDeps'),
    depFailRate: num('DepFailRate'),
    depP95: Math.round(num('DepP95')),
    depP99: Math.round(num('DepP99')),
    totalReqs: num('TotalReqs'),
    failedReqs: num('FailedReqs'),
    reqFailRate: num('ReqFailRate'),
    reqP95: Math.round(num('ReqP95')),
    reqP99: Math.round(num('ReqP99')),
    socketLayerExceptions: num('SocketLayerExceptions'),
    timeoutExceptions: num('TimeoutExceptions'),
    oomExceptions: num('OomExceptions'),
    totalExceptions: num('TotalExceptions'),
    uniqueUsers: num('UniqueUsers'),
    botRequests: num('BotRequests'),
  };
}

async function fetchHighFreqIPs(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
requests
| extend dimIp=tostring(customDimensions["Client IP Address"]), ua=tostring(customDimensions["User-Agent"])
| extend rawIp=iff(isnotempty(dimIp) and dimIp !in ("::1","::","0.0.0.0"), dimIp, iff(isnotempty(client_IP) and client_IP !in ("::1","::","0.0.0.0"), client_IP, ""))
| extend identifier=iff(isempty(rawIp), ua, rawIp)
| where isnotempty(identifier)
| summarize requestCount=count() by bin(timestamp,1m), identifier, client_CountryOrRegion, ua
| summarize totalCount=sum(requestCount), peakRpm=max(requestCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by identifier, client_CountryOrRegion, ua
| where peakRpm > 5
| top 10 by totalCount desc
| project ip=identifier, country=client_CountryOrRegion, ua, count=totalCount, rpm=todouble(peakRpm), firstSeen, lastSeen`);
  if (!rows) return null;
  return rows.map(([ip, country, ua, count, rpm, firstSeen, lastSeen]) => ({
    ip: String(ip ?? ''),
    country: String(country ?? ''),
    userAgent: String(ua ?? ''),
    count: Number(count) || 0,
    rpm: Number(rpm) || 0,
    firstSeen: String(firstSeen ?? ''),
    lastSeen: String(lastSeen ?? ''),
  }));
}

async function fetchFailedUrlsByStatus(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
requests
| extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)
| extend statusGroup=iff(toint(resultCode) >= 500, "5xx", iff(toint(resultCode) >= 400, "4xx", "other"))
| where statusGroup in ("4xx", "5xx")
| summarize count=count() by nameClean, statusGroup
| order by count desc
| take 60`);
  if (!rows) return null;
  const result = { urls4xx: [], urls5xx: [] };
  for (const [name, statusGroup, count] of rows) {
    const entry = { name: String(name ?? ''), count: Number(count) || 0 };
    if (statusGroup === '4xx') result.urls4xx.push(entry);
    else if (statusGroup === '5xx') result.urls5xx.push(entry);
  }
  return result;
}

async function fetchSlowUrls(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
requests
| extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)
| summarize count=count(), avgMs=avg(duration), p99Ms=percentile(duration,99), maxMs=max(duration)
    by nameClean
| where count > 5
| order by avgMs desc
| take 15`);
  if (!rows) return null;
  return rows.map(([name, count, avgMs, p99Ms, maxMs]) => ({
    name: String(name ?? ''),
    count: Number(count) || 0,
    avgMs: Math.round(Number(avgMs) || 0),
    p99Ms: Math.round(Number(p99Ms) || 0),
    maxMs: Math.round(Number(maxMs) || 0),
  }));
}

async function fetchThreadPoolCounters(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
performanceCounters
| where name has_any ("Thread", "IO Completion", "Request Queue", "Requests Queued", "Worker Thread")
| summarize avg=round(avg(value),1), max=round(max(value),1), p99=round(percentile(value,99),1) by name
| order by name asc`);
  if (!rows || rows.length === 0) return null;
  return rows.map(([name, avg, max, p99]) => ({ name: String(name), avg: Number(avg), max: Number(max), p99: Number(p99) }));
}

async function fetchGCCounters(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
performanceCounters
| where name has_any ("Gen 0", "Gen 1", "Gen 2", "GC Heap", "Heap", "Private Bytes", "Allocated", "Commit")
| summarize avg=round(avg(value),1), max=round(max(value),1), p99=round(percentile(value,99),1) by name
| order by name asc`);
  if (!rows || rows.length === 0) return null;
  return rows.map(([name, avg, max, p99]) => ({ name: String(name), avg: Number(avg), max: Number(max), p99: Number(p99) }));
}

// ── Bucket-specific exception detail (socket / timeout / OOM) ──────────────────

// Out-of-memory exceptions. The report previously had no OOM section at all even
// though the prompt lists "Memory pressure / GC thrash" as a candidate root cause,
// so the model had to infer it from GC counters alone.
async function fetchOomExceptions(appId, aiToken, timespan) {
  const [summaryRows, detailRows] = await Promise.all([
    runKQL(appId, aiToken, timespan, `
exceptions
| where ${OOM_ONLY_MATCH}
| summarize records=count(), trueCount=sum(itemCount), instances=dcount(cloud_RoleInstance), firstSeen=min(timestamp), lastSeen=max(timestamp)`),
    runKQL(appId, aiToken, timespan, `
exceptions
| where ${OOM_ONLY_MATCH}
| summarize count=sum(itemCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by type, outerMessage, operation_Name, cloud_RoleInstance
| order by count desc
| take 15`),
  ]);
  const s = summaryRows?.[0];
  const records = Number(s?.[0]) || 0;
  if (!records) return null;
  return {
    summary: {
      records,
      trueCount: Number(s?.[1]) || 0,
      instances: Number(s?.[2]) || 0,
      firstSeen: String(s?.[3] ?? ''),
      lastSeen: String(s?.[4] ?? ''),
    },
    details: (detailRows ?? []).map(([type, outerMessage, opName, instance, count, firstSeen, lastSeen]) => ({
      type: String(type ?? ''),
      outerMessage: String(outerMessage ?? ''),
      operationName: String(opName ?? ''),
      instance: String(instance ?? ''),
      count: Number(count) || 0,
      firstSeen: String(firstSeen ?? ''),
      lastSeen: String(lastSeen ?? ''),
    })),
  };
}

// Dependency timeouts by REAL result code, not the 30s-duration heuristic that
// fetchSqlDependencyDeep uses. That heuristic misses Cloudflare 524, HttpClient
// "Canceled", and SQL -2, and counts any slow-but-successful call as a timeout.
async function fetchDependencyTimeouts(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
dependencies
| where resultCode in (${TIMEOUT_RESULT_CODES})
| extend nameClean=iif(name has "?", substring(name, 0, indexof(name, "?")), name)
| summarize count=sum(itemCount), p95=percentile(duration,95), maxMs=max(duration),
            firstSeen=min(timestamp), lastSeen=max(timestamp) by nameClean, resultCode, type, target
| order by count desc
| take 15`);
  if (!rows || rows.length === 0) return null;
  return rows.map(([name, resultCode, depType, target, count, p95, maxMs, firstSeen, lastSeen]) => ({
    name: String(name ?? ''),
    resultCode: String(resultCode ?? ''),
    type: String(depType ?? ''),
    target: String(target ?? ''),
    count: Number(count) || 0,
    p95: Math.round(Number(p95) || 0),
    maxMs: Math.round(Number(maxMs) || 0),
    firstSeen: String(firstSeen ?? ''),
    lastSeen: String(lastSeen ?? ''),
  }));
}

// Which endpoints the application timeouts landed on, with exact totals. The
// Category 10 exception table is capped at 15 rows and reports a union first/last
// seen, so it cannot answer "where did this start".
async function fetchTimeoutsByEndpoint(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
exceptions
| where ${TIMEOUT_ONLY_MATCH}
| summarize count=sum(itemCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by operation_Name
| order by count desc
| take 15`);
  if (!rows || rows.length === 0) return null;
  return rows.map(([opName, count, firstSeen, lastSeen]) => ({
    operationName: String(opName || '(none)'),
    count: Number(count) || 0,
    firstSeen: String(firstSeen ?? ''),
    lastSeen: String(lastSeen ?? ''),
  }));
}

// Socket exceptions per worker, plus the operation_Id join that names which
// downstream target consumed the ports. SNAT ports are allocated per worker, so
// heavy skew localises the fault to one instance rather than the whole plan.
async function fetchSocketSkew(appId, aiToken, timespan) {
  const [instanceRows, targetRows] = await Promise.all([
    runKQL(appId, aiToken, timespan, `
exceptions
| where ${SOCKET_MATCH}
| summarize count=sum(itemCount), firstSeen=min(timestamp), lastSeen=max(timestamp) by cloud_RoleInstance
| order by count desc
| take 20`),
    runKQL(appId, aiToken, timespan, `
let socketOps = exceptions | where ${SOCKET_MATCH} | distinct operation_Id;
dependencies
| where success == false
| where operation_Id in (socketOps)
| summarize count=sum(itemCount), p95=percentile(duration,95) by target, type
| order by count desc
| take 15`),
  ]);
  const byInstance = (instanceRows ?? []).map(([instance, count, firstSeen, lastSeen]) => ({
    instance: String(instance || 'unknown'),
    count: Number(count) || 0,
    firstSeen: String(firstSeen ?? ''),
    lastSeen: String(lastSeen ?? ''),
  }));
  const targets = (targetRows ?? []).map(([target, depType, count, p95]) => ({
    target: String(target || '(unknown)'),
    type: String(depType ?? ''),
    count: Number(count) || 0,
    p95: Math.round(Number(p95) || 0),
  }));
  if (!byInstance.length && !targets.length) return null;
  return { byInstance, targets };
}

// ── User traffic & bursts ──────────────────────────────────────────────────────

// Unique users and request volume per 5-minute bucket, plus the burst windows.
// A burst is flagged against the MEDIAN rather than the mean because the mean is
// dragged up by the burst itself — with a mean baseline a single large spike
// raises the threshold enough to hide itself.
async function fetchUserTraffic(appId, aiToken, timespan) {
  const [timelineRows, topUserRows] = await Promise.all([
    runKQL(appId, aiToken, timespan, `
requests
| extend dimIp=tostring(customDimensions["Client IP Address"])
| extend rawIp=iff(isnotempty(dimIp) and dimIp !in ("::1","::","0.0.0.0"), dimIp, client_IP)
| summarize users=dcount(rawIp), sessions=dcount(session_Id), requests=sum(itemCount),
            failed=sumif(itemCount, success==false) by bin(timestamp, 5m)
| order by timestamp asc`),
    runKQL(appId, aiToken, timespan, `
requests
| extend dimIp=tostring(customDimensions["Client IP Address"])
| extend rawIp=iff(isnotempty(dimIp) and dimIp !in ("::1","::","0.0.0.0"), dimIp, client_IP)
| summarize users=dcount(rawIp), requests=sum(itemCount) by client_CountryOrRegion
| order by users desc
| take 10`),
  ]);
  if (!timelineRows || timelineRows.length === 0) return null;

  const timeline = timelineRows.map(([timestamp, users, sessions, requests, failed]) => ({
    timestamp: String(timestamp ?? ''),
    users: Number(users) || 0,
    sessions: Number(sessions) || 0,
    requests: Number(requests) || 0,
    failed: Number(failed) || 0,
  }));

  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const userMedian = median(timeline.map(p => p.users));
  const reqMedian  = median(timeline.map(p => p.requests));

  // 3x the median AND a floor, so a quiet app going 1 user → 3 users is not a "burst".
  const USER_FACTOR = 3, REQ_FACTOR = 3, USER_FLOOR = 10, REQ_FLOOR = 100;
  const bursts = timeline
    .filter(p =>
      (userMedian > 0 && p.users >= Math.max(userMedian * USER_FACTOR, USER_FLOOR)) ||
      (reqMedian  > 0 && p.requests >= Math.max(reqMedian * REQ_FACTOR, REQ_FLOOR))
    )
    .map(p => ({
      ...p,
      userFactor: userMedian > 0 ? Math.round((p.users / userMedian) * 10) / 10 : null,
      reqFactor:  reqMedian  > 0 ? Math.round((p.requests / reqMedian) * 10) / 10 : null,
      failRate:   p.requests > 0 ? Math.round((p.failed / p.requests) * 10000) / 100 : 0,
    }));

  return {
    timeline,
    bursts,
    baseline: { userMedian, reqMedian, buckets: timeline.length },
    peak: {
      users: Math.max(...timeline.map(p => p.users)),
      requests: Math.max(...timeline.map(p => p.requests)),
      atUsers: timeline.reduce((b, p) => p.users > b.users ? p : b, timeline[0]).timestamp,
      atRequests: timeline.reduce((b, p) => p.requests > b.requests ? p : b, timeline[0]).timestamp,
    },
    totalUsers: Number(topUserRows?.reduce((s, r) => s + (Number(r[1]) || 0), 0)) || 0,
    byCountry: (topUserRows ?? []).map(([country, users, requests]) => ({
      country: String(country || '(unknown)'),
      users: Number(users) || 0,
      requests: Number(requests) || 0,
    })),
  };
}

// ── Data assembly ─────────────────────────────────────────────────────────────

async function fetchAllIncidentData(token, aiToken, resId, planResId, appId, startTime, endTime, isContainerApp = false, dbResId = null) {
  const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
  const cpuResId = planResId || resId;

  const armPromises = isContainerApp
    ? Promise.all([
        fetchMetric(token, resId, 'CpuPercentage', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, resId, 'MemoryPercentage', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        Promise.resolve([]), // no HttpResponseTime for container apps
        fetchMetric(token, resId, 'RunningReplicas', startTime, endTime, 'PT5M', ['Average']),
        Promise.resolve([]), // no Requests ARM metric
        Promise.resolve([]), // no Http5xx ARM metric
        Promise.resolve([]), // no Http4xx ARM metric
      ])
    : Promise.all([
        fetchMetric(token, cpuResId, 'CpuPercentage', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, cpuResId, 'MemoryPercentage', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, resId, 'HttpResponseTime', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, resId, 'HealthCheckStatus', startTime, endTime, 'PT5M', ['Average']),
        fetchMetric(token, resId, 'Requests', startTime, endTime, 'PT5M', ['Total']),
        fetchMetric(token, resId, 'Http5xx', startTime, endTime, 'PT5M', ['Total']),
        fetchMetric(token, resId, 'Http4xx', startTime, endTime, 'PT5M', ['Total']),
      ]);

  const kqlPromises = appId && aiToken ? Promise.all([
    fetchExceptionAnalysis(appId, aiToken, timespan),
    fetchEndpointLatency(appId, aiToken, timespan),
    fetchSqlDependencyDeep(appId, aiToken, timespan),
    fetchDeploymentEvents(appId, aiToken, timespan),
    fetchSnatIndicators(appId, aiToken, timespan),
    fetchFailedDeps(appId, aiToken, timespan),
    fetchTrafficInsight(appId, aiToken, timespan),
    fetchHighFreqIPs(appId, aiToken, timespan),
    fetchThreadPoolCounters(appId, aiToken, timespan),
    fetchGCCounters(appId, aiToken, timespan),
    fetchFailedUrlsByStatus(appId, aiToken, timespan),
    fetchSlowUrls(appId, aiToken, timespan),
    fetchOomExceptions(appId, aiToken, timespan),
    fetchDependencyTimeouts(appId, aiToken, timespan),
    fetchTimeoutsByEndpoint(appId, aiToken, timespan),
    fetchSocketSkew(appId, aiToken, timespan),
    fetchUserTraffic(appId, aiToken, timespan),
  ]) : Promise.resolve(Array(17).fill(null));

  // Infrastructure signals that need no App Insights — socket/TCP counters, plan
  // capacity, connection growth, per-instance health. These are ARM metrics and
  // stay available even when the app has no instrumentation.
  const infraPromises = Promise.all([
    isContainerApp ? Promise.resolve(null) : fetchSocketCounters(token, planResId, startTime, endTime),
    isContainerApp ? Promise.resolve(null) : fetchPlanCapacity(token, planResId),
    isContainerApp ? Promise.resolve([])   : fetchMetric(token, resId, 'AppConnections', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
    isContainerApp ? Promise.resolve(null) : fetchMetricSplit(token, resId, 'Requests', startTime, endTime, 'PT5M', ['Total'], "Instance ne 'N/A'"),
    isContainerApp ? Promise.resolve(null) : fetchMetricSplit(token, resId, 'Http5xx', startTime, endTime, 'PT5M', ['Total'], "Instance ne 'N/A'"),
    isContainerApp ? Promise.resolve(null) : fetchMetricSplit(token, resId, 'HealthCheckStatus', startTime, endTime, 'PT5M', ['Average'], "Instance ne 'N/A'"),
    dbResId ? fetchMetric(token, dbResId, 'cpu_percent', startTime, endTime, 'PT5M', ['Average', 'Maximum']) : Promise.resolve([]),
    dbResId ? fetchMetric(token, dbResId, 'sql_instance_memory_percent', startTime, endTime, 'PT5M', ['Average', 'Maximum']) : Promise.resolve([]),
  ]);

  const [[cpuSeries, memSeries, rtSeries, rawAvailSeries, requestsSeries, fail5xxSeries, fail4xxSeries],
         [exceptionAnalysis, endpointLatency, sqlDeep, deploymentEvents, snatIndicators,
          failedDeps, trafficInsight, highFreqIPs, threadPoolCounters, gcCounters,
          failedUrlsByStatus, slowUrls, oomInsights, dependencyTimeouts,
          timeoutsByEndpoint, socketSkew, userTraffic],
         [socketCounters, planCapacity, connectionsSeries,
          instReqSplit, inst5xxSplit, instProbeSplit, dbCpuSeries, dbMemSeries]]
    = await Promise.all([armPromises, kqlPromises, infraPromises]);

  // Normalize Container App RunningReplicas to 0/100 availability scale
  const availSeries = isContainerApp
    ? rawAvailSeries.map(p => ({ ...p, average: (p.average ?? 0) > 0 ? 100 : 0 }))
    : rawAvailSeries;

  // Per-instance request health % — same derivation the dashboard uses, so a
  // single crashed worker is distinguishable from a whole-plan outage.
  const instanceHealthSeries = buildInstanceHealth(instReqSplit, inst5xxSplit);
  const instanceProbeSeries = (instProbeSplit ?? []).map(ts => ({
    name: ts.name,
    series: ts.data.map(d => ({ t: String(d.timeStamp), v: Math.round((d.average ?? 100) * 10) / 10 })),
  }));

  return {
    cpuSeries, memSeries, rtSeries, availSeries, requestsSeries, fail5xxSeries, fail4xxSeries,
    exceptionAnalysis, endpointLatency, sqlDeep, deploymentEvents, snatIndicators,
    failedDeps, trafficInsight, highFreqIPs, threadPoolCounters, gcCounters,
    failedUrlsByStatus, slowUrls,
    oomInsights, dependencyTimeouts, timeoutsByEndpoint, socketSkew, userTraffic,
    socketCounters, planCapacity, connectionsSeries, dbCpuSeries, dbMemSeries,
    instanceHealthSeries, instanceProbeSeries,
  };
}

// Request health % per worker: (requests - 5xx) / requests.
//
// Buckets with no requests are OMITTED rather than scored 100%. Azure returns a
// point for every bucket in the timespan for each instance dimension, with `total`
// absent where the instance served nothing — including before it was created. A
// no-data bucket carries no health signal, and calling it 100% would let an
// instance that was DOWN (and therefore serving no traffic) count as healthy,
// which is exactly the case classifyDowntimeCause has to detect.
function buildInstanceHealth(reqSplit, errSplit) {
  if (!reqSplit?.length) return null;
  const errByInstance = new Map(
    (errSplit ?? []).map(ts => [ts.name, new Map(ts.data.map(d => [String(d.timeStamp), d.total ?? 0]))])
  );
  return reqSplit.map(ts => {
    const errByTime = errByInstance.get(ts.name) ?? new Map();
    const series = [];
    for (const d of ts.data) {
      const total = d.total ?? 0;
      if (total <= 0) continue;
      const t = String(d.timeStamp);
      const failed = errByTime.get(t) ?? 0;
      series.push({ t, v: Math.round((total - failed) / total * 1000) / 10 });
    }
    return { name: ts.name, series };
  });
}

// ── API data fetch ────────────────────────────────────────────────────────────

// The API previously got 7 KQL queries and no ARM metrics at all — no CPU, no
// memory, no availability — while the prompt told the model to "address both
// throughout". armResId/planResId are null when the API resource can't be
// resolved, in which case the ARM half degrades to empty and the section says so.
async function fetchApiIncidentData(aiToken, appId, startTime, endTime, token = null, armResId = null, planResId = null) {
  const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
  const settled = await Promise.allSettled([
    fetchEndpointLatency(appId, aiToken, timespan),
    fetchExceptionAnalysis(appId, aiToken, timespan),
    fetchFailedDeps(appId, aiToken, timespan),
    fetchSqlDependencyDeep(appId, aiToken, timespan),
    fetchTrafficInsight(appId, aiToken, timespan),
    fetchHighFreqIPs(appId, aiToken, timespan),
    fetchSnatIndicators(appId, aiToken, timespan),
    fetchOomExceptions(appId, aiToken, timespan),
    fetchDependencyTimeouts(appId, aiToken, timespan),
    fetchUserTraffic(appId, aiToken, timespan),
  ]);
  const val = (i) => settled[i].status === 'fulfilled' ? settled[i].value : null;

  const armResults = (token && armResId)
    ? await Promise.all([
        fetchMetric(token, planResId || armResId, 'CpuPercentage', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, planResId || armResId, 'MemoryPercentage', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, armResId, 'HttpResponseTime', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, armResId, 'HealthCheckStatus', startTime, endTime, 'PT5M', ['Average']),
        fetchMetric(token, armResId, 'Requests', startTime, endTime, 'PT5M', ['Total']),
        fetchMetric(token, armResId, 'Http5xx', startTime, endTime, 'PT5M', ['Total']),
        fetchMetric(token, armResId, 'Http4xx', startTime, endTime, 'PT5M', ['Total']),
      ])
    : null;

  const reqRows = await runKQL(appId, aiToken, timespan,
    `requests | summarize total=count(), failed=countif(success==false), avgMs=round(avg(duration),0), p99Ms=round(percentile(duration,99),0)`
  ).catch(() => null);

  return {
    endpointLatency: val(0),
    exceptionAnalysis: val(1),
    failedDeps: val(2),
    sqlDeep: val(3),
    trafficInsight: val(4),
    highFreqIPs: val(5),
    snatIndicators: val(6),
    oomInsights: val(7),
    dependencyTimeouts: val(8),
    userTraffic: val(9),
    reqSummary: reqRows?.[0] ?? null,
    arm: armResults ? {
      cpuSeries: armResults[0], memSeries: armResults[1], rtSeries: armResults[2],
      availSeries: armResults[3], requestsSeries: armResults[4],
      fail5xxSeries: armResults[5], fail4xxSeries: armResults[6],
    } : null,
  };
}

// ── Anomaly score ─────────────────────────────────────────────────────────────

function computeAnomalyScore(data) {
  const { availSeries, cpuSeries, rtSeries, fail5xxSeries, snatIndicators, sqlDeep, trafficInsight } = data;

  const avg = (arr, key) => arr.length ? arr.reduce((s, p) => s + (p[key] ?? 0), 0) / arr.length : 0;
  const sum = (arr, key) => arr.reduce((s, p) => s + (p[key] ?? 0), 0);

  const availPct = avg(availSeries, 'average');
  const cpuAvg = avg(cpuSeries, 'average');
  // Azure publishes HttpResponseTime in SECONDS. Converting to ms here fixes two
  // long-standing bugs: the `> 5000` rule below compared seconds against a
  // millisecond threshold so it could never fire, and the anomaly table renders
  // this through msFormat, which reported a 14.2s peak as "14ms".
  const rtP99 = rtSeries.length ? Math.max(...rtSeries.map(p => p.maximum ?? p.average ?? 0)) * 1000 : 0;
  // Container Apps have no Requests/Http5xx ARM metrics (fetchAllIncidentData
  // hardcodes them empty), so an ARM-only failRate was always 0 and the 5xx rule
  // could never fire for them. Fall back to the App Insights request totals.
  const armTotal5xx = sum(fail5xxSeries, 'total');
  const armTotalReqs = data.requestsSeries.reduce((s, p) => s + (p.total ?? 0), 0);
  const usingAiRequests = armTotalReqs === 0 && (trafficInsight?.totalReqs ?? 0) > 0;
  const total5xx = usingAiRequests ? (trafficInsight.failedReqs ?? 0) : armTotal5xx;
  const totalReqs = usingAiRequests ? trafficInsight.totalReqs : armTotalReqs;
  const failRate = totalReqs > 0 ? (total5xx / totalReqs) * 100 : 0;
  // Socket-layer only. The old count also swept in bare "timed out" and every
  // HttpRequestException, so ordinary downstream errors triggered the SNAT rule.
  const snatCount = snatIndicators ? snatIndicators.filter(r => r.bucket === 'socket').reduce((s, r) => s + r.count, 0) : 0;
  const timeoutIndicatorCount = snatIndicators ? snatIndicators.filter(r => r.bucket === 'timeout').reduce((s, r) => s + r.count, 0) : 0;
  const sqlTimeouts = sqlDeep ? sqlDeep.reduce((s, r) => s + r.timeoutCount, 0) : 0;
  const socketLayerExceptions = trafficInsight?.socketLayerExceptions ?? 0;
  const timeoutExceptions = trafficInsight?.timeoutExceptions ?? 0;

  // Signals added alongside the new telemetry.
  const memAvg = avg(data.memSeries ?? [], 'average');
  const memMax = (data.memSeries?.length) ? Math.max(...data.memSeries.map(p => p.maximum ?? p.average ?? 0)) : 0;
  const oomCount = data.oomInsights?.summary?.trueCount ?? 0;
  // Result-code timeouts (408/504/524/Canceled/-2) rather than the >30s duration
  // heuristic — a slow-but-successful call is not a timeout.
  const depTimeoutCount = data.dependencyTimeouts
    ? data.dependencyTimeouts.reduce((s, r) => s + r.count, 0) : 0;
  const dbCpuAvg = avg(data.dbCpuSeries ?? [], 'average');
  const dbCpuMax = (data.dbCpuSeries?.length) ? Math.max(...data.dbCpuSeries.map(p => p.maximum ?? p.average ?? 0)) : 0;
  const dbMemAvg = avg(data.dbMemSeries ?? [], 'average');
  const dbMemMax = (data.dbMemSeries?.length) ? Math.max(...data.dbMemSeries.map(p => p.maximum ?? p.average ?? 0)) : 0;
  const userBurstCount = data.userTraffic?.bursts?.length ?? 0;
  const peakUsers = data.userTraffic?.peak?.users ?? 0;

  // TimeWait ≫ Established means connections are opened per call and never
  // reused — the definitive "not pooled" signal, and unlike exception text it
  // cannot be faked by an unrelated downstream error.
  const socketVal = (name) => data.socketCounters?.metrics?.find(m => m.name === name)?.avg ?? null;
  const tcpEstablished = socketVal('TcpEstablished') ?? socketVal('SocketOutboundEstablished');
  const tcpTimeWait = socketVal('TcpTimeWait') ?? socketVal('SocketOutboundTimeWait');
  const socketRatio = (tcpEstablished && tcpEstablished > 0 && tcpTimeWait != null)
    ? Math.round((tcpTimeWait / tcpEstablished) * 10) / 10 : null;

  let score = 0;
  if (availPct > 0 && availPct < 99) score += 30;
  if (cpuAvg > 80) score += 15;
  if (rtP99 > 5000) score += 15;
  if (failRate > 2) score += 20;
  if (snatCount > 10) score += 10;
  if (sqlTimeouts > 5) score += 10;
  if (socketLayerExceptions > 5) score += 5;
  // New rules. OOM is unconditional — the process died for lack of memory, which
  // is never incidental. The other two were previously invisible to the score.
  if (oomCount > 0) score += 15;
  if (memAvg > 85) score += 10;
  if (depTimeoutCount > 10) score += 10;

  return {
    score: Math.min(score, 100), availPct, cpuAvg, rtP99, failRate, snatCount, sqlTimeouts,
    timeoutIndicatorCount, socketLayerExceptions, timeoutExceptions,
    memAvg, memMax, oomCount, depTimeoutCount,
    dbCpuAvg, dbCpuMax, dbMemAvg, dbMemMax,
    socketRatio, tcpEstablished, tcpTimeWait,
    userBurstCount, peakUsers,
    uniqueUsers: trafficInsight?.uniqueUsers ?? 0,
    usingAiRequests, totalReqs, total5xx,
  };
}

// Downtime intervals with a cause verdict, using the same detector as the
// dashboard. The report previously reported only a count of sub-99.5% buckets,
// which gave the model no boundaries and no cause.
function computeDowntime(data) {
  const availSeries = (data.availSeries ?? []).map(p => ({ t: String(p.timeStamp), v: p.average ?? 100 }));
  if (!availSeries.length) return [];
  const fail5 = (data.fail5xxSeries ?? []).map(p => ({ t: String(p.timeStamp), count: p.total ?? 0 }));
  const fail4 = (data.fail4xxSeries ?? []).map(p => ({ t: String(p.timeStamp), count: p.total ?? 0 }));
  return extractDowntimeIntervalsMultiSignal(availSeries, fail5, fail4, data.instanceProbeSeries)
    .map(iv => {
      const cause = classifyDowntimeCause(iv, { instanceHealthSeries: data.instanceHealthSeries });
      const total = data.instanceHealthSeries?.length ?? 0;
      const affected = total ? data.instanceHealthSeries.filter(inst =>
        inst.series.some(p => {
          const t = new Date(p.t).getTime();
          return t >= iv.start && t <= iv.end && p.v < 50;
        })).length : 0;
      return { ...iv, cause, label: DOWNTIME_CAUSE_LABEL[cause] ?? cause, affected, totalInstances: total };
    });
}

// ── Markdown generation ───────────────────────────────────────────────────────

function mdTable(headers, rows) {
  if (!rows || rows.length === 0) return '_No data._\n';
  const head = '| ' + headers.join(' | ') + ' |';
  const sep = '|' + headers.map(() => '---').join('|') + '|';
  const body = rows.map(r => '| ' + r.map(c => c === null || c === undefined ? '—' : String(c).replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n');
  return `${head}\n${sep}\n${body}\n`;
}

// Renders socket-layer and application-timeout indicators as two separate
// tables. Used by both the frontend Category 6 section and the API section so
// the two never drift.
function bucketedIndicatorSection(snatIndicators, trafficInsight) {
  const socketRows  = (snatIndicators ?? []).filter(r => r.bucket === 'socket');
  const timeoutRows = (snatIndicators ?? []).filter(r => r.bucket === 'timeout');
  const socketEvents  = socketRows.reduce((s, r) => s + r.count, 0);
  const timeoutEvents = timeoutRows.reduce((s, r) => s + r.count, 0);
  const socketEx  = trafficInsight?.socketLayerExceptions ?? 0;
  const timeoutEx = trafficInsight?.timeoutExceptions ?? 0;

  const groupTable = (rows) => {
    const grouped = {};
    for (const r of rows) grouped[r.outerMessage] = (grouped[r.outerMessage] || 0) + r.count;
    return mdTable(
      ['Exception Message', 'Total Count'],
      Object.entries(grouped).sort((a, b) => b[1] - a[1]).map(([msg, count]) => ['`' + msg + '`', count])
    );
  };

  let md = '';
  md += `- Socket-layer exceptions (no connection established): **${socketEx}**\n`;
  md += `- Application timeouts (connected, caller gave up waiting): **${timeoutEx}**\n`;
  md += `- Socket indicator events: **${socketEvents}** · timeout indicator events: **${timeoutEvents}** (5-min buckets)\n`;
  md += '\n';

  md += `### Socket-Layer Indicators\n\n`;
  md += socketRows.length ? groupTable(socketRows) : `_No socket-layer indicators detected — SNAT port exhaustion is not supported by the exception data._\n`;
  md += '\n';

  md += `### Application Timeout Indicators\n\n`;
  md += timeoutRows.length ? groupTable(timeoutRows) : `_No application timeouts detected._\n`;
  md += '\n';

  return md;
}

// Per-code meaning, so the model reasons about WHICH timeout happened rather
// than lumping every non-200 together. Each code was verified against observed
// p95 duration — see TIMEOUT_RESULT_CODES in exception-buckets.cjs.
const RESULT_CODE_MEANING = {
  '408': 'HTTP 408 Request Timeout — the server gave up waiting for the request',
  '504': 'HTTP 504 Gateway Timeout — an upstream proxy timed out (typically ~60s)',
  '524': 'Cloudflare 524 — origin did not respond in time (typically ~100s+)',
  'Canceled': '.NET HttpClient deadline elapsed — the caller cancelled at its configured timeout',
  '-2': 'SQL Server error -2 — SqlClient command timeout (default 30s)',
};

// Dependency timeouts confirmed by result code. Shared by the frontend Category 5
// and the API section so the two cannot drift.
function dependencyTimeoutSection(dependencyTimeouts, hasAppInsights, heading = '### Dependency Timeouts (by result code)') {
  let md = `${heading}\n\n`;
  if (!hasAppInsights) return md + `_App Insights not configured._\n\n`;
  if (!dependencyTimeouts || !dependencyTimeouts.length) {
    return md + `_No dependency calls returned a timeout result code (${TIMEOUT_RESULT_CODES.replace(/"/g, '')}). Slow-but-successful calls are deliberately excluded._\n\n`;
  }
  md += mdTable(
    ['Dependency', 'Result Code', 'Type', 'Target', 'Count', 'P95', 'Max', 'First Seen (SGT)', 'Last Seen (SGT)'],
    dependencyTimeouts.map(r => [
      '`' + r.name + '`', r.resultCode, r.type, r.target, r.count,
      msFormat(r.p95), msFormat(r.maxMs), sgt(r.firstSeen), sgt(r.lastSeen),
    ])
  );
  md += '\n';
  const codes = [...new Set(dependencyTimeouts.map(r => r.resultCode))].filter(c => RESULT_CODE_MEANING[c]);
  if (codes.length) {
    md += `Result codes observed:\n`;
    for (const c of codes) md += `- \`${c}\` — ${RESULT_CODE_MEANING[c]}\n`;
    md += '\n';
  }
  return md;
}

// Direct socket/TCP evidence. Everything else in the report infers SNAT from
// exception text; these counters measure the transport itself.
function socketCounterSection(socketCounters, anomaly) {
  let md = `### Outbound Socket / TCP Counters\n\n`;
  if (!socketCounters?.metrics?.length) {
    return md + `_No socket/TCP counters reported. These are published on the App Service plan and only by Windows plans — Linux plans and Container Apps return no data. SNAT can only be inferred from exception text in that case._\n\n`;
  }
  md += `_Plan-scoped (\`${socketCounters.planName}\`) — these counters cover every site sharing the plan, not just this app._\n\n`;
  const help = {
    SocketOutboundAll: 'All outbound sockets in any state',
    SocketOutboundEstablished: 'Sockets actively carrying traffic',
    SocketOutboundTimeWait: 'Closed sockets still holding their port (SNAT pressure)',
    TcpEstablished: 'TCP connections in ESTABLISHED',
    TcpTimeWait: 'TCP connections in TIME_WAIT — high vs Established means no pooling',
    TcpCloseWait: 'Peer closed, app has not — undisposed HttpClient/streams',
    TcpSynSent: 'Handshake started, never completed — target unreachable or refusing',
  };
  md += mdTable(
    ['Counter', 'Avg', 'Max', 'What it means'],
    socketCounters.metrics.map(m => [m.name, m.avg, m.max, help[m.name] ?? '—'])
  );
  md += '\n';
  if (anomaly.socketRatio != null) {
    const r = anomaly.socketRatio;
    const verdict = r >= 5
      ? `**${r}:1 — connections are almost certainly not pooled.** Each call opens a new socket that then sits in TIME_WAIT holding its port. This is the classic SNAT exhaustion precursor; the fix is a single reused HttpClient / connection pool, not more ports.`
      : r >= 2
        ? `**${r}:1 — elevated.** More sockets are waiting to be released than are carrying traffic. Worth checking client lifetimes before load grows.`
        : `**${r}:1 — healthy.** Sockets are being reused; port pressure is not the story here.`;
    md += `TimeWait : Established ratio — ${verdict}\n\n`;
  }
  return md;
}

// Unique users over time, and the windows where traffic spiked. Answers "was the
// app simply overwhelmed by a surge of users" — a question the report previously
// could not address, since it only had total request counts and per-IP hot spots.
// Shared by the frontend Category 16 and the API section.
function userTrafficSection(userTraffic, hasAppInsights, heading) {
  let md = `${heading}\n\n`;
  if (!hasAppInsights) return md + `_App Insights not configured — user counts are unavailable._\n\n`;
  if (!userTraffic) return md + `_No request data, so user traffic could not be measured._\n\n`;

  const { baseline, peak, bursts, byCountry, timeline } = userTraffic;
  md += `- Unique users (5-min peak): **${peak.users.toLocaleString()}** at **${sgt(peak.atUsers)}**\n`;
  md += `- Requests (5-min peak): **${peak.requests.toLocaleString()}** at **${sgt(peak.atRequests)}**\n`;
  md += `- Typical 5-min bucket (median): **${baseline.userMedian} users**, **${baseline.reqMedian} requests** across ${baseline.buckets} buckets\n`;
  md += `- Burst windows detected: **${bursts.length}**\n\n`;
  md += `_A burst is a 5-minute bucket at 3x the median or more, with a floor of 10 users / 100 requests so a quiet app going from 1 user to 3 is not reported. The baseline is the **median**, not the mean, because a large spike drags the mean up enough to hide itself._\n\n`;

  md += `### Burst Windows\n\n`;
  if (!bursts.length) {
    md += `_No user or traffic bursts. Load stayed within 3x the median for the whole window, so a traffic surge can be ruled out as the trigger._\n\n`;
  } else {
    md += mdTable(
      ['Time (SGT)', 'Users', 'x median', 'Requests', 'x median', 'Failed', 'Fail %'],
      bursts.map(b => [
        sgt(b.timestamp), b.users, b.userFactor == null ? '—' : b.userFactor + 'x',
        b.requests.toLocaleString(), b.reqFactor == null ? '—' : b.reqFactor + 'x',
        b.failed, b.failRate.toFixed(2) + '%',
      ])
    );
    md += '\n';
    // Whether the burst actually hurt is the whole point — a clean burst means
    // the app absorbed it and the surge is not the root cause.
    const worst = bursts.reduce((a, b) => b.failRate > a.failRate ? b : a, bursts[0]);
    md += worst.failRate > 5
      ? `> Peak burst failure rate **${worst.failRate.toFixed(2)}%** at ${sgt(worst.timestamp)} — the surge coincided with elevated failures, so load is a plausible contributor.\n\n`
      : `> Failure rates stayed at or below **${worst.failRate.toFixed(2)}%** during every burst — the app absorbed the extra load, so the surge alone does not explain the incident.\n\n`;
  }

  md += `### Users by Country\n\n`;
  md += byCountry.length
    ? mdTable(['Country', 'Unique Users', 'Requests'],
        byCountry.map(c => [c.country, c.users.toLocaleString(), c.requests.toLocaleString()])) + '\n'
    : `_No country data._\n\n`;

  // Full per-bucket detail stays collapsed — the timeline table above already
  // carries the users column for correlation.
  if (timeline.length) {
    md += `<details>\n<summary>Full user traffic timeline (${timeline.length} × 5-min buckets, SGT)</summary>\n\n`;
    md += mdTable(['Time (SGT)', 'Users', 'Sessions', 'Requests', 'Failed'],
      timeline.map(p => [sgt(p.timestamp), p.users, p.sessions, p.requests, p.failed]));
    md += `\n</details>\n\n`;
  }
  return md;
}

// A per-bucket timeline the model can cite for the RCA's incident-timeline
// section. Previously that section asked for 5-minute rows while the raw series
// were stripped from the prompt, so the model had to invent them.
//
// Compaction: full 5-minute resolution inside confirmed downtime (±30 min of
// context), hourly roll-ups everywhere else. Keeps the interesting minutes exact
// without spending thousands of tokens on quiet hours.
function buildTimelineSection(data, downtimeIntervals) {
  const CONTEXT_MS = 30 * 60_000;
  const MAX_ROWS = 160;

  const at = (series, key) => {
    const m = new Map();
    for (const p of series ?? []) m.set(Date.parse(String(p.timeStamp)), p[key]);
    return m;
  };
  // Gauges are read at their per-bucket PEAK, not their average. An incident
  // timeline exists to show how hard a resource was pushed, and a 5-minute average
  // flattens the spike that caused the failure — an instance pinned at 100% for one
  // minute in five averages to a harmless-looking 40%. Falls back to the average
  // where Azure returned no maximum for a bucket.
  const peak = (series) => {
    const avg = at(series, 'average');
    const max = at(series, 'maximum');
    const m = new Map(avg);
    for (const [t, v] of max) if (v != null) m.set(t, v);
    return m;
  };
  const cpuM    = peak(data.cpuSeries);
  const memM    = peak(data.memSeries);
  const rtM     = peak(data.rtSeries);
  const availM  = at(data.availSeries, 'average');   // HealthCheckStatus is Average-only
  const reqM    = at(data.requestsSeries, 'total');
  const f5M     = at(data.fail5xxSeries, 'total');
  const f4M     = at(data.fail4xxSeries, 'total');
  // Database server compute. Comes from a different Azure resource than the app
  // metrics, so it is merged by timestamp — an absent bucket must render as a gap
  // rather than shifting later values onto the wrong row.
  const dbCpuM  = peak(data.dbCpuSeries);
  const dbMemM  = peak(data.dbMemSeries);
  const usersM  = new Map((data.userTraffic?.timeline ?? []).map(p => [Date.parse(p.timestamp), p.users]));
  const uReqM   = new Map((data.userTraffic?.timeline ?? []).map(p => [Date.parse(p.timestamp), p.requests]));
  const uFailM  = new Map((data.userTraffic?.timeline ?? []).map(p => [Date.parse(p.timestamp), p.failed]));
  const hasDb   = dbCpuM.size > 0 || dbMemM.size > 0;

  // Union of every timestamp any series reported, so a metric present only in
  // App Insights (users) or only on the database still gets a row.
  const stamps = [...new Set([
    ...cpuM.keys(), ...memM.keys(), ...availM.keys(), ...reqM.keys(),
    ...f5M.keys(), ...f4M.keys(), ...rtM.keys(), ...usersM.keys(),
    ...dbCpuM.keys(), ...dbMemM.keys(),
  ])].filter(t => !isNaN(t)).sort((a, b) => a - b);

  let md = `## Incident Timeline (deterministic)\n\n`;
  if (!stamps.length) {
    return md + `_No time-series data available for this window._\n\n`;
  }

  // Inside an interval vs merely near one: a context row can sit at 100%
  // availability, so labelling it DOWN would contradict its own numbers.
  const isDown    = (t) => downtimeIntervals.some(iv => t >= iv.start && t <= iv.end);
  const inHotZone = (t) => downtimeIntervals.some(iv => t >= iv.start - CONTEXT_MS && t <= iv.end + CONTEXT_MS);

  const row = (t) => {
    const req   = reqM.get(t) ?? uReqM.get(t) ?? null;
    const fail5 = f5M.get(t) ?? uFailM.get(t) ?? null;
    const pc = (m) => m.get(t) != null ? m.get(t).toFixed(1) : '—';
    return [
      sgtTime(t),
      pc(cpuM),
      pc(memM),
      pc(availM),
      req != null ? Math.round(req) : '—',
      fail5 != null ? Math.round(fail5) : '—',
      f4M.get(t) != null ? Math.round(f4M.get(t)) : '—',
      usersM.get(t) != null ? usersM.get(t) : '—',
      rtM.get(t) != null ? msFormat(rtM.get(t) * 1000) : '—',
      ...(hasDb ? [pc(dbCpuM), pc(dbMemM)] : []),
      isDown(t) ? '**DOWN**' : 'context',
    ];
  };

  const hot = stamps.filter(inHotZone);
  const cold = stamps.filter(t => !inHotZone(t));

  // Roll quiet stretches up to the hour: averages for gauges, sums for counters,
  // max for users so a burst inside a quiet hour is still visible.
  const hourly = new Map();
  for (const t of cold) {
    const hourKey = Math.floor(t / 3_600_000) * 3_600_000;
    if (!hourly.has(hourKey)) hourly.set(hourKey, []);
    hourly.get(hourKey).push(t);
  }
  const agg = (ts, map, fn) => {
    const vals = ts.map(t => map.get(t)).filter(v => v != null);
    if (!vals.length) return null;
    if (fn === 'sum') return vals.reduce((s, v) => s + v, 0);
    if (fn === 'max') return Math.max(...vals);
    if (fn === 'min') return Math.min(...vals);
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };
  const bucketMs = stamps.length > 1 ? Math.min(...stamps.slice(1).map((t, i) => t - stamps[i])) : 300_000;
  // Label by the buckets actually covered, not by the whole clock hour: when part
  // of an hour was pulled out into 5-minute rows, a "10:00–11:00" label on a
  // partial sum would overlap those rows and overstate the span it measured.
  const hourlyRow = (ts) => {
    const first = ts[0], last = ts[ts.length - 1];
    const req   = agg(ts, reqM, 'sum') ?? agg(ts, uReqM, 'sum');
    const fail5 = agg(ts, f5M, 'sum') ?? agg(ts, uFailM, 'sum');
    const fmt = (v, d = 1) => v == null ? '—' : v.toFixed(d);
    return [
      `${sgtTime(first)}–${sgtTime(last + bucketMs)}`,
      // Worst case across the merged buckets, matching the per-bucket columns:
      // peak for the gauges, MIN for availability. Averaging availability here
      // would let a rollup hide an outage inside an otherwise healthy hour.
      fmt(agg(ts, cpuM, 'max')), fmt(agg(ts, memM, 'max')),
      fmt(agg(ts, availM, 'min')),
      req != null ? Math.round(req) : '—',
      fail5 != null ? Math.round(fail5) : '—',
      agg(ts, f4M, 'sum') != null ? Math.round(agg(ts, f4M, 'sum')) : '—',
      agg(ts, usersM, 'max') ?? '—',
      agg(ts, rtM, 'max') != null ? msFormat(agg(ts, rtM, 'max') * 1000) : '—',
      ...(hasDb ? [fmt(agg(ts, dbCpuM, 'max')), fmt(agg(ts, dbMemM, 'max'))] : []),
      `_rollup ${ts.length}×${Math.round(bucketMs / 60000)}m_`,
    ];
  };

  const rows = [
    ...hot.map(t => ({ t, cells: row(t) })),
    ...[...hourly.values()].map(ts => ({ t: ts[0], cells: hourlyRow(ts) })),
  ].sort((a, b) => a.t - b.t);

  const truncated = rows.length > MAX_ROWS;
  const shown = truncated ? rows.slice(0, MAX_ROWS) : rows;

  const dateSpan = `${msToSGT(stamps[0]).display.slice(0, 10)} → ${msToSGT(stamps[stamps.length - 1]).display.slice(0, 10)}`;
  md += `_Times are SGT (UTC+8), date range ${dateSpan}. **CPU, memory, response time and database columns are per-bucket PEAKS, not averages** — an average flattens the spike that caused the failure, so treat every percentage here as "how hard this was pushed at its worst in that bucket". Availability is the opposite: it is reported at its LOWEST. Rows are at full ${Math.round(bucketMs / 60000)}-minute resolution inside confirmed downtime and for 30 minutes either side: **DOWN** means the bucket falls inside a confirmed interval, \`context\` means it is adjacent to one (so a \`context\` row may legitimately read 100% availability). Quiet stretches are rolled up and marked \`_rollup NxNm_\` giving the number of buckets merged — a rollup keeps the same worst-case reading (peak gauges, minimum availability, peak users) and sums the request and error counts. Never read a rollup row as a single-bucket measurement, and note that its label spans only the buckets it actually merged._\n\n`;
  md += hasDb
    ? `_DB CPU% and DB Mem% are the database server's own peak compute, read from a different Azure resource than the app metrics and merged by timestamp — a dash means that bucket was not reported, not zero load._\n\n`
    : `_No database server columns: no database is configured for this app, so DB-side load could not be correlated against the app timeline._\n\n`;
  md += mdTable(
    [
      'Time (SGT)', 'CPU max%', 'Mem max%', 'Avail%', 'Requests', '5xx', '4xx', 'Users', 'Resp max',
      ...(hasDb ? ['DB CPU max%', 'DB Mem max%'] : []),
      'Note',
    ],
    shown.map(r => r.cells)
  );
  if (truncated) {
    md += `\n_Truncated: showing ${MAX_ROWS} of ${rows.length} rows. The omitted rows are hourly roll-ups outside confirmed downtime._\n`;
  }
  md += '\n';
  return md;
}

function generateMarkdown({ appName, resourceGroup, startMs, endMs, data, anomaly, hasAppInsights, uptimeRobotIncidents, apiData, apiName }) {
  const nowSGT = msToSGT(Date.now());
  const startSGT = msToSGT(startMs);
  const endSGT = msToSGT(endMs);

  const avg = (arr, key) => arr.length ? arr.reduce((s, p) => s + (p[key] ?? 0), 0) / arr.length : null;
  const maxV = (arr, key) => arr.length ? Math.max(...arr.map(p => p[key] ?? 0)) : null;

  const totalReqs = data.requestsSeries.reduce((s, p) => s + (p.total ?? 0), 0);
  const total5xx = data.fail5xxSeries.reduce((s, p) => s + (p.total ?? 0), 0);
  const total4xx = data.fail4xxSeries.reduce((s, p) => s + (p.total ?? 0), 0);

  const cpuAvg = avg(data.cpuSeries, 'average');
  const cpuMax = maxV(data.cpuSeries, 'maximum');
  const memAvg = avg(data.memSeries, 'average');
  const memMax = maxV(data.memSeries, 'maximum');
  const rtAvg = avg(data.rtSeries, 'average');
  const rtMax = maxV(data.rtSeries, 'maximum');
  const availAvg = avg(data.availSeries, 'average');
  const availMin = data.availSeries.length ? Math.min(...data.availSeries.map(p => p.average ?? 100)) : null;
  const downPts = data.availSeries.filter(p => (p.average ?? 100) < 99.5).length;
  const downMins = downPts * 5;

  // Confirmed downtime windows with a cause verdict, from the same detector the
  // dashboard uses. Drives both the Downtime Intervals section and which parts of
  // the timeline get full 5-minute resolution.
  const downtimeIntervals = computeDowntime(data);
  const confirmedDownMins = downtimeIntervals.reduce((s, iv) => s + (iv.end - iv.start), 0) / 60000;

  // Request totals: prefer ARM, fall back to App Insights for Container Apps,
  // which publish no Requests/Http5xx ARM metrics at all.
  const usingAiReqs = totalReqs === 0 && (data.trafficInsight?.totalReqs ?? 0) > 0;
  const dispReqs = usingAiReqs ? data.trafficInsight.totalReqs : totalReqs;
  const dispFailed = usingAiReqs ? (data.trafficInsight.failedReqs ?? 0) : total5xx;

  const anomalyLabel = anomaly.score > 70 ? 'HIGH' : anomaly.score > 40 ? 'MEDIUM' : anomaly.score > 10 ? 'LOW' : 'NOMINAL';
  const pct = (v) => v == null ? '—' : v.toFixed(1) + '%';

  let md = `# Azure App Service Incident Report

> **AI Agent Instructions:** This report contains structured Azure App Service telemetry across 16 RCA categories. Use it to determine: (1) what happened, (2) why it happened, (3) which component caused it, (4) blast radius, (5) mitigation actions. Correlate signals across categories — do not rely on single metrics. Distinguish infrastructure vs. application vs. dependency vs. traffic causes. **Every timestamp in this report is SGT (UTC+8) and is labelled as such — reproduce times as SGT and never convert to UTC.**

**App**: ${appName}
**Resource Group**: ${resourceGroup}
**Analysis Period**: ${startSGT.display} → ${endSGT.display} (UTC+8)
**Generated**: ${nowSGT.display}
**App Insights**: ${hasAppInsights ? 'configured' : 'NOT configured — Categories 1, 2, 3, 4, 5, 6, 7, 8, 10, 14, 16 will show no data'}
**Database metrics**: ${data.hasDbConfig ? 'configured' : 'NOT configured — Category 15 has no server-side DB data'}
**Edge diagnostics**: ${data.hasEdgeConfig ? 'configured' : 'NOT configured — Category 13 cannot assess the edge/network path'}

---

## Anomaly Score

| Metric | Value |
|---|---|
| **Score** | **${anomaly.score} / 100 — ${anomalyLabel}** |
| Availability avg | ${anomaly.availPct ? anomaly.availPct.toFixed(2) + '%' : 'n/a'} |
| Confirmed downtime | ${downtimeIntervals.length ? `${Math.round(confirmedDownMins)}m across ${downtimeIntervals.length} interval(s)` : 'none confirmed'} |
| CPU avg | ${anomaly.cpuAvg.toFixed(1)}% |
| Memory avg / peak | ${pct(anomaly.memAvg)} / ${pct(anomaly.memMax)} |
| Response time P99 (max) | ${msFormat(anomaly.rtP99)} |
| 5xx failure rate | ${anomaly.failRate.toFixed(2)}%${anomaly.usingAiRequests ? ' (from App Insights — no ARM request metrics)' : ''} |
| Socket-layer indicators (transport failed) | ${anomaly.snatCount} |
| Application timeout indicators (connected, gave up waiting) | ${anomaly.timeoutIndicatorCount ?? 0} |
| SQL timeouts (>30s duration heuristic) | ${anomaly.sqlTimeouts} |
| Dependency timeouts (by result code) | ${anomaly.depTimeoutCount} |
| Out-of-memory exceptions | ${anomaly.oomCount} |
| TCP TimeWait : Established ratio | ${anomaly.socketRatio == null ? '— (counters unavailable)' : anomaly.socketRatio + ' : 1'} |
| Database CPU avg / peak | ${data.hasDbConfig ? `${pct(anomaly.dbCpuAvg)} / ${pct(anomaly.dbCpuMax)}` : '— (not configured)'} |
| Unique users | ${anomaly.uniqueUsers ? anomaly.uniqueUsers.toLocaleString() : '—'} |
| User/traffic burst windows | ${anomaly.userBurstCount} |

Scoring: avail<99% (+30) · CPU>80% (+15) · RT P99>5s (+15) · 5xx>2% (+20) · socket indicators>10 (+10) · SQL timeouts>5 (+10) · socket exceptions>5 (+5) · OOM>0 (+15) · memory avg>85% (+10) · dependency timeouts>10 (+10).

Socket-layer and application-timeout exceptions are counted separately and never merged: a socket exception means no connection was established (SNAT port exhaustion, connection refused, ENOBUFS, TCP handshake timeout — fix is pooling, ports, scale-out), while an application timeout means a connection succeeded and the caller gave up waiting (SQL command timeout, HttpClient.Timeout, Redis timeout — fix is query tuning or deadlines). Only the socket bucket feeds the SNAT rules above.

---

## Top-Level Summary

| Metric | Average | Peak / Min | Total |
|---|---|---|---|
| Availability | ${availAvg !== null ? availAvg.toFixed(2) + '%' : '—'} | ${availMin !== null ? availMin.toFixed(2) + '% (min)' : '—'} | downtime ${downMins}m (${downPts} × 5m intervals < 99.5%) |
| CPU | ${cpuAvg !== null ? cpuAvg.toFixed(1) + '%' : '—'} | ${cpuMax !== null ? cpuMax.toFixed(1) + '% (max)' : '—'} | — |
| Memory | ${memAvg !== null ? memAvg.toFixed(1) + '%' : '—'} | ${memMax !== null ? memMax.toFixed(1) + '% (max)' : '—'} | — |
| Response Time | ${rtAvg !== null ? rtAvg.toFixed(3) + 's' : '—'} | ${rtMax !== null ? rtMax.toFixed(3) + 's (max)' : '—'} | — |
| Requests | — | — | ${dispReqs.toLocaleString()}${usingAiReqs ? ' (App Insights)' : ''} |
| HTTP 5xx${usingAiReqs ? ' / failed' : ''} | — | — | ${dispFailed.toLocaleString()} (${dispReqs > 0 ? ((dispFailed / dispReqs) * 100).toFixed(2) + '%' : 'n/a'}) |
| HTTP 4xx | — | — | ${total4xx.toLocaleString()} (${dispReqs > 0 ? ((total4xx / dispReqs) * 100).toFixed(2) + '%' : 'n/a'}) |
| Unique users | — | ${data.userTraffic?.peak?.users ? data.userTraffic.peak.users.toLocaleString() + ' (peak 5m)' : '—'} | ${anomaly.uniqueUsers ? anomaly.uniqueUsers.toLocaleString() : '—'} |

---

`;

  // ── Downtime Intervals ──
  md += `## Downtime Intervals (confirmed)\n\n`;
  md += `_Strict detection: availability below 100%, 5xx present and dominant over 4xx, and a failing health probe — for 2+ consecutive buckets, closing after 3 clean ones. Cause is derived from per-instance health, so a single crashed worker is distinguished from a whole-plan outage._\n\n`;
  if (!downtimeIntervals.length) {
    md += `_No confirmed downtime intervals in this window._`;
    md += data.instanceHealthSeries?.length
      ? ` Per-instance health was available (${data.instanceHealthSeries.length} instance(s)), so this is a real negative rather than missing data.\n\n`
      : ` Note: no per-instance data was available, so the probe condition defaulted to true.\n\n`;
  } else {
    md += mdTable(
      ['Start (SGT)', 'End (SGT)', 'Duration', 'Cause', 'Instances Affected'],
      downtimeIntervals.map(iv => [
        sgt(iv.start), sgt(iv.end), durFormat(iv.end - iv.start), iv.label,
        iv.totalInstances ? `${iv.affected} / ${iv.totalInstances}` : 'unknown',
      ])
    );
    md += '\n';
  }

  // ── Deterministic Incident Timeline ──
  md += buildTimelineSection(data, downtimeIntervals);
  md += `---\n\n`;

  // ── Category 1: Dependency Saturation ──
  md += `## 1. Dependency Saturation\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else if (!data.failedDeps || data.failedDeps.length === 0) {
    md += `_No failed dependencies detected._\n\n`;
  } else {
    md += mdTable(
      ['Name', 'Type', 'Target', 'Total', 'Failures', 'Avg', 'P95', 'P99'],
      data.failedDeps.slice(0, 20).map(d => [
        '`' + d.name + '`', d.type, d.target, d.totalCount, d.failCount,
        msFormat(d.avgDuration), msFormat(d.p95), msFormat(d.p99),
      ])
    );
    md += '\n';
  }

  // ── Category 2: Thread Pool & Async Saturation ──
  md += `## 2. Thread Pool & Async Saturation\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else if (!data.threadPoolCounters || data.threadPoolCounters.length === 0) {
    md += `_No thread pool performance counters detected._\n\n`;
  } else {
    md += mdTable(
      ['Counter', 'Avg', 'P99', 'Max'],
      data.threadPoolCounters.map(c => [c.name, c.avg, c.p99, c.max])
    );
    md += '\n';
  }

  // ── Category 3: GC & Allocation Insights ──
  md += `## 3. GC & Allocation Insights\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else if (!data.gcCounters || data.gcCounters.length === 0) {
    md += `_No GC performance counters detected._\n\n`;
  } else {
    md += mdTable(
      ['Counter', 'Avg', 'P99', 'Max'],
      data.gcCounters.map(c => [c.name, c.avg, c.p99, c.max])
    );
    md += '\n';
  }

  // ── Category 4: Request Pipeline ──
  md += `## 4. Request Pipeline Insights\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else if (!data.endpointLatency || data.endpointLatency.length === 0) {
    md += `_No endpoint data._\n\n`;
  } else {
    md += `Top endpoints by P99 latency:\n\n`;
    md += mdTable(
      ['Endpoint', 'Count', 'Avg', 'P50', 'P95', 'P99', 'Max', 'Fail%'],
      data.endpointLatency.slice(0, 15).map(e => [
        '`' + e.name + '`', e.count,
        msFormat(e.avgMs), msFormat(e.p50), msFormat(e.p95), msFormat(e.p99), msFormat(e.maxMs),
        e.failRate.toFixed(2) + '%',
      ])
    );
    md += '\n';
    if (data.slowUrls?.length) {
      md += `**Slowest endpoints by average latency:**\n\n`;
      md += mdTable(
        ['Endpoint', 'Count', 'Avg', 'P99', 'Max'],
        data.slowUrls.slice(0, 15).map(e => [
          '`' + e.name + '`', e.count, msFormat(e.avgMs), msFormat(e.p99Ms), msFormat(e.maxMs),
        ])
      );
      md += '\n';
    }
    if (data.failedUrlsByStatus) {
      if (data.failedUrlsByStatus.urls5xx?.length) {
        md += `**5xx errors by endpoint:**\n\n`;
        md += mdTable(['Endpoint', 'Count'], data.failedUrlsByStatus.urls5xx.slice(0, 15).map(e => ['`' + e.name + '`', e.count]));
        md += '\n';
      }
      if (data.failedUrlsByStatus.urls4xx?.length) {
        md += `**4xx errors by endpoint:**\n\n`;
        md += mdTable(['Endpoint', 'Count'], data.failedUrlsByStatus.urls4xx.slice(0, 15).map(e => ['`' + e.name + '`', e.count]));
        md += '\n';
      }
    }
  }

  // ── Category 5: Database Deep ──
  md += `## 5. Database Deep Insights\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else if (!data.sqlDeep || data.sqlDeep.length === 0) {
    md += `_No SQL dependency data._\n\n`;
  } else {
    md += `_The Timeouts column is a duration heuristic (calls exceeding 30s). See the result-code table below for timeouts confirmed by the dependency's own result code._\n\n`;
    md += mdTable(
      ['Query/Proc', 'Server', 'Calls', 'Failures', 'Fail%', 'Avg', 'P95', 'P99', 'Timeouts (>30s)'],
      data.sqlDeep.slice(0, 15).map(s => [
        '`' + s.name + '`', s.target, s.callCount, s.failCount,
        s.failRate.toFixed(2) + '%', msFormat(s.avgMs), msFormat(s.p95), msFormat(s.p99), s.timeoutCount,
      ])
    );
    md += '\n';
  }

  md += dependencyTimeoutSection(data.dependencyTimeouts, hasAppInsights);

  // ── Category 6: SNAT ──
  md += `## 6. SNAT Port Exhaustion & Timeouts\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured — socket counters below are still available._\n\n`;
  } else {
    md += bucketedIndicatorSection(data.snatIndicators, data.trafficInsight);
  }

  // Direct transport evidence — available with or without App Insights.
  md += socketCounterSection(data.socketCounters, anomaly);

  if (hasAppInsights) {
    md += `### Socket Exceptions per Instance\n\n`;
    if (!data.socketSkew?.byInstance?.length) {
      md += `_No socket exceptions to attribute to an instance._\n\n`;
    } else {
      md += `_SNAT ports are allocated per worker, so heavy skew localises the fault to one instance rather than the plan._\n\n`;
      md += mdTable(
        ['Instance', 'Socket Exceptions', 'First Seen (SGT)', 'Last Seen (SGT)'],
        data.socketSkew.byInstance.map(r => ['`' + r.instance + '`', r.count, sgt(r.firstSeen), sgt(r.lastSeen)])
      );
      md += '\n';
    }

    md += `### Downstream Targets in Socket-Failing Operations\n\n`;
    if (!data.socketSkew?.targets?.length) {
      md += `_No failed dependencies correlated with socket exceptions._\n\n`;
    } else {
      md += `_Joined on \`operation_Id\` — these are the targets called during operations that threw socket exceptions, i.e. the likely port consumers._\n\n`;
      md += mdTable(
        ['Target', 'Type', 'Failed Calls', 'P95'],
        data.socketSkew.targets.map(r => ['`' + r.target + '`', r.type, r.count, msFormat(r.p95)])
      );
      md += '\n';
    }
  }

  // ── Category 7: Traffic Intelligence ──
  md += `## 7. Traffic Intelligence & Security\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else {
    const ti = data.trafficInsight;
    if (ti) {
      md += `_Exception counts are sampling-corrected (\`sum(itemCount)\`), so they reflect true volume rather than ingested rows._\n\n`;
      md += `| Metric | Value |\n|---|---|\n`;
      md += `| Total requests | ${ti.totalReqs.toLocaleString()} |\n`;
      md += `| Failed requests | ${ti.failedReqs.toLocaleString()} (${ti.reqFailRate.toFixed(2)}%) |\n`;
      md += `| Request P95 / P99 | ${msFormat(ti.reqP95)} / ${msFormat(ti.reqP99)} |\n`;
      md += `| Total dependencies | ${ti.totalDeps.toLocaleString()} |\n`;
      md += `| Failed dependencies | ${ti.failedDeps.toLocaleString()} (${ti.depFailRate.toFixed(2)}%) |\n`;
      md += `| Dependency P95 / P99 | ${msFormat(ti.depP95)} / ${msFormat(ti.depP99)} |\n`;
      md += `| Unique users | ${(ti.uniqueUsers ?? 0).toLocaleString()} |\n`;
      md += `| Socket-layer exceptions | ${ti.socketLayerExceptions} |\n`;
      md += `| Application timeouts | ${ti.timeoutExceptions} |\n`;
      md += `| Out-of-memory exceptions | ${ti.oomExceptions ?? 0} |\n`;
      md += `| Total exceptions | ${(ti.totalExceptions ?? 0).toLocaleString()} |\n`;
      md += `| Bot requests | ${ti.botRequests.toLocaleString()} |\n\n`;
    }
    if (data.highFreqIPs?.length) {
      md += `**High-frequency clients (peak > 5 RPM):**\n\n`;
      md += mdTable(
        ['IP / Identifier', 'Country', 'User Agent', 'Total', 'Peak RPM', 'First Seen (SGT)', 'Last Seen (SGT)'],
        data.highFreqIPs.slice(0, 10).map(r => [
          '`' + r.ip + '`', r.country || '—', r.userAgent.slice(0, 60), r.count, r.rpm.toFixed(1),
          sgt(r.firstSeen), sgt(r.lastSeen),
        ])
      );
      md += '\n';
    }
  }

  // ── Category 8: Deployment Correlation ──
  md += `## 8. Deployment Correlation\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else if (!data.deploymentEvents || data.deploymentEvents.length === 0) {
    md += `_No deployment/lifecycle events detected._\n\n`;
  } else {
    md += mdTable(
      ['Timestamp (SGT)', 'Instance', 'Severity', 'Message'],
      data.deploymentEvents.slice(0, 30).map(e => [
        sgt(e.timestamp),
        e.instance || '—',
        e.severityLevel,
        e.message.slice(0, 120),
      ])
    );
    md += '\n';
  }

  // ── Category 9: Availability & Reliability ──
  md += `## 9. Availability & Reliability\n\n`;
  md += `- Avg availability: **${availAvg !== null ? availAvg.toFixed(2) + '%' : '—'}**\n`;
  md += `- Min availability: **${availMin !== null ? availMin.toFixed(2) + '%' : '—'}**\n`;
  md += `- Downtime intervals (< 99.5%): **${downPts}** (${downMins} minutes)\n\n`;
  if (downPts > 0 && downPts <= 30) {
    md += `**Downtime data points:**\n\n`;
    const downPoints = data.availSeries.filter(p => (p.average ?? 100) < 99.5);
    md += mdTable(
      ['Timestamp (SGT)', 'Availability %'],
      downPoints.map(p => [sgt(p.timeStamp), (p.average ?? 0).toFixed(2) + '%'])
    );
    md += '\n';
  }

  // ── UptimeRobot Incidents ──
  if (Array.isArray(uptimeRobotIncidents)) {
    md += `## UptimeRobot Monitoring\n\n`;
    md += `_External uptime check incidents during this window._\n\n`;
    const urIncs = uptimeRobotIncidents;
    if (urIncs.length === 0) {
      md += `> No downtime detected by UptimeRobot monitors.\n\n`;
    } else {
      md += mdTable(
        ['Monitor', 'Start (SGT)', 'End (SGT)', 'Duration', 'Reason'],
        urIncs.map(i => [
          i.monitor,
          sgt(i.start),
          sgt(i.end),
          durFormat(i.duration * 1000),
          i.reason || '—',
        ])
      );
      md += '\n';
    }
  }

  // ── Category 10: Error Intelligence ──
  md += `## 10. Error Intelligence\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else if (!data.exceptionAnalysis || data.exceptionAnalysis.length === 0) {
    md += `_No exceptions detected._\n\n`;
  } else {
    md += mdTable(
      ['Exception Type', 'Inner Type', 'Message', 'Inner Msg', 'Operation', 'Count', 'First Seen (SGT)', 'Last Seen (SGT)'],
      data.exceptionAnalysis.slice(0, 15).map(e => [
        '`' + e.type + '`',
        e.sampleInnerType ? '`' + e.sampleInnerType + '`' : '—',
        (e.outerMessage || '').slice(0, 80),
        (e.sampleInnerMsg || '').slice(0, 80),
        (e.sampleOpName || '—').slice(0, 60),
        e.count, sgt(e.firstOccurrence), sgt(e.lastOccurrence),
      ])
    );
    md += '\n';
  }

  // ── Category 11: Infrastructure Saturation ──
  md += `## 11. Infrastructure Saturation\n\n`;
  md += `- CPU avg / max: **${cpuAvg !== null ? cpuAvg.toFixed(1) + '%' : '—'}** / **${cpuMax !== null ? cpuMax.toFixed(1) + '%' : '—'}**\n`;
  md += `- Memory avg / max: **${memAvg !== null ? memAvg.toFixed(1) + '%' : '—'}** / **${memMax !== null ? memMax.toFixed(1) + '%' : '—'}**\n`;
  md += `- Response time avg / max: **${rtAvg !== null ? rtAvg.toFixed(3) + 's' : '—'}** / **${rtMax !== null ? rtMax.toFixed(3) + 's' : '—'}**\n\n`;

  if (cpuMax !== null && cpuMax > 80) {
    md += `**CPU peak points (>80%):**\n\n`;
    md += mdTable(
      ['Timestamp (SGT)', 'Avg %', 'Max %'],
      data.cpuSeries.filter(p => (p.maximum ?? p.average ?? 0) > 80).slice(0, 20).map(p => [
        sgt(p.timeStamp), (p.average ?? 0).toFixed(1), (p.maximum ?? 0).toFixed(1),
      ])
    );
    md += '\n';
  }
  if (memMax !== null && memMax > 80) {
    md += `**Memory peak points (>80%):**\n\n`;
    md += mdTable(
      ['Timestamp (SGT)', 'Avg %', 'Max %'],
      data.memSeries.filter(p => (p.maximum ?? p.average ?? 0) > 80).slice(0, 20).map(p => [
        sgt(p.timeStamp), (p.average ?? 0).toFixed(1), (p.maximum ?? 0).toFixed(1),
      ])
    );
    md += '\n';
  }

  // Capacity context — 85% CPU on a B1 is a different finding from 85% on a P3v3.
  md += `### Plan Capacity\n\n`;
  if (!data.planCapacity) {
    md += `_Plan details unavailable (Container App, or the plan could not be resolved)._\n\n`;
  } else {
    const p = data.planCapacity;
    md += `| Property | Value |\n|---|---|\n`;
    md += `| Plan | \`${p.name}\` |\n`;
    md += `| SKU / tier | ${p.sku || '—'}${p.tier ? ` (${p.tier})` : ''} |\n`;
    md += `| Instances (current) | ${p.workers ?? '—'} |\n`;
    md += `| Max workers | ${p.maxWorkers ?? '—'} |\n`;
    md += `| Zone redundant | ${p.zoneRedundant == null ? '—' : (p.zoneRedundant ? 'yes' : 'no')} |\n\n`;
  }

  md += `### Outbound Connections\n\n`;
  if (!data.connectionsSeries?.length) {
    md += `_No AppConnections metric data._\n\n`;
  } else {
    const cAvg = data.connectionsSeries.reduce((s, p) => s + (p.average ?? 0), 0) / data.connectionsSeries.length;
    const cMax = Math.max(...data.connectionsSeries.map(p => p.maximum ?? p.average ?? 0));
    const first = data.connectionsSeries[0]?.average ?? 0;
    const last = data.connectionsSeries[data.connectionsSeries.length - 1]?.average ?? 0;
    md += `- Connections avg / peak: **${cAvg.toFixed(0)}** / **${cMax.toFixed(0)}**\n`;
    md += `- Trend across the window: ${first.toFixed(0)} → ${last.toFixed(0)}`;
    // Monotonic growth that never comes back down is a leak, not load.
    md += (first > 0 && last > first * 1.5)
      ? ` — **growing and not recovering**, consistent with connections being leaked rather than tracking load.\n\n`
      : `.\n\n`;
  }

  md += `### Per-Instance Health\n\n`;
  if (!data.instanceHealthSeries?.length) {
    md += `_No per-instance data (single instance, Container App, or no per-instance metrics published)._\n\n`;
  } else {
    md += `_Health is request-derived: (requests − 5xx) / requests. Buckets where an instance served no requests carry no health signal and are excluded, so "First / Last active" shows when the instance was actually serving — an instance whose first active bucket is later than the others was added by a scale-out, and one that stops early was recycled or removed. Compare the active-bucket count against the others before reading its average._\n\n`;
    md += mdTable(
      ['Instance', 'Health avg %', 'Health min %', 'Active buckets', 'Buckets < 50%', 'First active (SGT)', 'Last active (SGT)'],
      data.instanceHealthSeries.map(inst => {
        const vals = inst.series.map(p => p.v);
        const iAvg = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
        return [
          '`' + inst.name + '`',
          iAvg == null ? '—' : iAvg.toFixed(1),
          vals.length ? Math.min(...vals).toFixed(1) : '—',
          vals.length,
          vals.filter(v => v < 50).length,
          inst.series.length ? sgt(inst.series[0].t) : '—',
          inst.series.length ? sgt(inst.series[inst.series.length - 1].t) : '—',
        ];
      })
    );
    md += '\n';
  }

  // ── Category 12: Live Incident Intelligence ──
  md += `## 12. Live Incident Intelligence\n\n`;
  md += `- Anomaly score: **${anomaly.score} / 100** (${anomalyLabel})\n`;
  md += `- Significant signals:\n`;
  if (anomaly.availPct > 0 && anomaly.availPct < 99) md += `  - Availability degraded below 99% (${anomaly.availPct.toFixed(2)}%)\n`;
  if (anomaly.cpuAvg > 80) md += `  - CPU avg above 80% (${anomaly.cpuAvg.toFixed(1)}%)\n`;
  if (anomaly.rtP99 > 5000) md += `  - Response time peak above 5s (${msFormat(anomaly.rtP99)})\n`;
  if (anomaly.failRate > 2) md += `  - 5xx error rate above 2% (${anomaly.failRate.toFixed(2)}%)\n`;
  if (anomaly.snatCount > 10) md += `  - Socket-layer events above threshold (${anomaly.snatCount}) — transport failing, check SNAT ports and connection pooling\n`;
  if (anomaly.sqlTimeouts > 5) md += `  - SQL timeouts above threshold (${anomaly.sqlTimeouts})\n`;
  if ((anomaly.timeoutIndicatorCount ?? 0) > 10) md += `  - Application timeouts above threshold (${anomaly.timeoutIndicatorCount}) — connections succeeded, downstream too slow. Not a port problem\n`;
  if (anomaly.oomCount > 0) md += `  - Out-of-memory exceptions present (${anomaly.oomCount}) — the process ran out of memory; see Category 14\n`;
  if (anomaly.memAvg > 85) md += `  - Memory avg above 85% (${anomaly.memAvg.toFixed(1)}%)\n`;
  if (anomaly.depTimeoutCount > 10) md += `  - Dependency timeouts by result code above threshold (${anomaly.depTimeoutCount}) — confirmed timeouts, not a duration heuristic\n`;
  if (anomaly.socketRatio != null && anomaly.socketRatio >= 5) md += `  - TCP TimeWait:Established ratio ${anomaly.socketRatio}:1 — sockets are not being pooled\n`;
  if (anomaly.dbCpuMax > 80) md += `  - Database CPU peaked above 80% (${anomaly.dbCpuMax.toFixed(1)}%) — server-side DB pressure\n`;
  if (anomaly.userBurstCount > 0) md += `  - ${anomaly.userBurstCount} user/traffic burst window(s) detected — see Category 16\n`;
  if (downtimeIntervals.length) md += `  - ${downtimeIntervals.length} confirmed downtime interval(s): ${[...new Set(downtimeIntervals.map(iv => iv.cause))].join(', ')}\n`;
  if (anomaly.score <= 10) md += `  - _No significant degradation signals._\n`;
  md += '\n';

  // ── Category 13: Network / Edge Diagnostics ──
  const edge = data.edge;
  if (!edge) {
    // Emitted even when unconfigured: the RCA prompt tells the model to consult
    // this section, and a silently missing section reads as "no edge problem".
    md += `## 13. Network / Edge Diagnostics\n\n`;
    md += `_**Not configured** — no Application Gateway, Front Door, or Load Balancer resource ID is set for this app, so the edge/network path could NOT be assessed. Treat edge failure as unassessed rather than ruled out._\n\n`;
  } else {
    md += `## 13. Network / Edge Diagnostics\n\n`;
    md += `_Edge logs require diagnostic settings routing to a Log Analytics workspace. "No rows" means either no traffic/errors in the window or logging is not enabled._\n\n`;
    if (edge.configured.agw) {
      md += `### Application Gateway\n\n`;
      if (!edge.configured.workspace) md += `_Log Analytics Workspace ID not configured — App Gateway logs unavailable._\n\n`;
      else if (!edge.appGateway) md += `_No App Gateway access-log rows for the window._\n\n`;
      else md += mdTable(['Time (SGT)', 'Requests', '5xx', 'Avg Backend', 'P99 Backend'],
        edge.appGateway.map(r => [sgtTime(r.time), r.requests, r.failed5xx, msFormat(r.avgBackendMs), msFormat(r.p99BackendMs)])) + '\n';
    }

    if (edge.configured.afd) {
      md += `### Front Door / CDN\n\n`;
      if (!edge.configured.workspace) md += `_Log Analytics Workspace ID not configured — Front Door logs unavailable._\n\n`;
      else if (!edge.frontDoor) md += `_No Front Door access-log rows for the window._\n\n`;
      else md += mdTable(['Time (SGT)', 'Requests', '5xx', 'P99 Latency'],
        edge.frontDoor.map(r => [sgtTime(r.time), r.requests, r.failed5xx, msFormat(r.p99LatencyMs)])) + '\n';
    }

    if (edge.configured.lb) {
      md += `### Load Balancer\n\n`;
      if (!edge.loadBalancer) md += `_No Load Balancer metrics for the window._\n\n`;
      else {
        const lb = edge.loadBalancer;
        md += `| Metric | Value |\n|---|---|\n`;
        md += `| Data-path availability (VIP) min | ${lb.vipAvailMin == null ? '—' : lb.vipAvailMin.toFixed(1) + '%'} |\n`;
        md += `| Backend health (DIP) min | ${lb.dipAvailMin == null ? '—' : lb.dipAvailMin.toFixed(1) + '%'} |\n`;
        md += `| SNAT connections (total) | ${lb.snatTotal.toLocaleString()} |\n\n`;
      }
    }
  }

  // ── Category 14: Memory & OOM ──
  // The report previously had no OOM section at all, even though the RCA prompt
  // lists memory pressure as a candidate root cause.
  md += `## 14. Memory & Out-of-Memory Exceptions\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured — OOM exceptions cannot be detected. Memory percentages in Category 11 are the only memory signal available._\n\n`;
  } else if (!data.oomInsights) {
    md += `_No out-of-memory exceptions in this window._`;
    md += (memMax !== null && memMax > 85)
      ? ` Note that memory still peaked at ${memMax.toFixed(1)}%, so pressure existed without reaching an allocation failure.\n\n`
      : `\n\n`;
  } else {
    const s = data.oomInsights.summary;
    md += `- Occurrences: **${s.trueCount}** (sampling-corrected; ${s.records} ingested rows)\n`;
    md += `- Distinct instances affected: **${s.instances}**\n`;
    md += `- First seen: **${sgt(s.firstSeen)}** · Last seen: **${sgt(s.lastSeen)}**\n`;
    md += `- Memory avg / peak over the window: **${memAvg !== null ? memAvg.toFixed(1) + '%' : '—'}** / **${memMax !== null ? memMax.toFixed(1) + '%' : '—'}**\n\n`;
    md += `_An OOM exception means an allocation actually failed. Cross-check the GC counters in Category 3: rising Gen 2 / heap size alongside these is a leak, while a flat heap with sudden OOM points at a single large allocation._\n\n`;
    if (data.oomInsights.details.length) {
      md += mdTable(
        ['Type', 'Message', 'Operation', 'Instance', 'Count', 'First Seen (SGT)', 'Last Seen (SGT)'],
        data.oomInsights.details.map(d => [
          '`' + d.type + '`', (d.outerMessage || '').slice(0, 80),
          (d.operationName || '—').slice(0, 60), '`' + (d.instance || 'unknown') + '`',
          d.count, sgt(d.firstSeen), sgt(d.lastSeen),
        ])
      );
      md += '\n';
    }
  }

  // ── Category 15: Database Server Health ──
  md += `## 15. Database Server Health\n\n`;
  if (!data.hasDbConfig) {
    md += `_**Not configured** — no database name/server is set for this app, so server-side DB compute could NOT be assessed. Any DB conclusion must rest on the app-side dependency data in Category 5 alone; do not claim the database server was healthy._\n\n`;
  } else if (!data.dbCpuSeries?.length && !data.dbMemSeries?.length) {
    md += `_Database configured but no metrics returned for the window (check the resource name and that the identity can read metrics)._\n\n`;
  } else {
    md += `| Metric | Average | Peak |\n|---|---|---|\n`;
    md += `| DB CPU | ${pct(anomaly.dbCpuAvg)} | ${pct(anomaly.dbCpuMax)} |\n`;
    md += `| DB memory | ${pct(anomaly.dbMemAvg)} | ${pct(anomaly.dbMemMax)} |\n\n`;
    // The interesting case for an RCA: app blames the DB, the DB looks fine.
    const appSideDbPressure = anomaly.sqlTimeouts > 5 || anomaly.depTimeoutCount > 10;
    if (appSideDbPressure && anomaly.dbCpuMax < 70) {
      md += `> **Divergence:** the app reports database timeouts (${anomaly.sqlTimeouts} by duration, ${anomaly.depTimeoutCount} by result code) while the database server itself peaked at only ${pct(anomaly.dbCpuMax)} CPU. The server was not starved, so look at query plans, missing indexes, blocking/locking, or connection-pool exhaustion on the app side rather than scaling the database.\n\n`;
    } else if (anomaly.dbCpuMax >= 80) {
      md += `> **Server-side pressure:** database CPU peaked at ${pct(anomaly.dbCpuMax)}. App-side timeouts are consistent with the database being the constraint.\n\n`;
    }
    if (data.dbCpuSeries?.length) {
      const dbPeaks = data.dbCpuSeries.filter(p => (p.maximum ?? p.average ?? 0) > 70).slice(0, 20);
      if (dbPeaks.length) {
        md += `**DB CPU points above 70%:**\n\n`;
        md += mdTable(['Timestamp (SGT)', 'Avg %', 'Max %'],
          dbPeaks.map(p => [sgt(p.timeStamp), (p.average ?? 0).toFixed(1), (p.maximum ?? 0).toFixed(1)]));
        md += '\n';
      }
    }
  }

  // ── Category 16: User Traffic & Bursts ──
  md += userTrafficSection(data.userTraffic, hasAppInsights, '## 16. User Traffic & Bursts');

  // ── API Section ──
  if (apiData && apiName) {
    md += `---\n\n## API: ${apiName}\n\n`;

    const apiReq = apiData.reqSummary;
    if (apiReq) {
      const [total, failed, avgMs, p99Ms] = apiReq;
      const totalN = Number(total) || 0;
      const failedN = Number(failed) || 0;
      const failRate = totalN > 0 ? ((failedN / totalN) * 100).toFixed(2) + '%' : '—';
      md += `### Summary\n\n`;
      md += `| Metric | Value |\n|---|---|\n`;
      md += `| Total Requests | ${totalN.toLocaleString()} |\n`;
      md += `| Failed Requests | ${failedN.toLocaleString()} (${failRate}) |\n`;
      md += `| Avg Response Time | ${msFormat(Number(avgMs) || 0)} |\n`;
      md += `| P99 Response Time | ${msFormat(Number(p99Ms) || 0)} |\n\n`;
    } else {
      md += `### Summary\n\n_No request data._\n\n`;
    }

    // ARM metrics for the API. Previously absent entirely, so the model was told
    // to "address both throughout" with no CPU, memory, or availability for the API.
    md += `### Infrastructure Metrics\n\n`;
    if (!apiData.arm) {
      md += `_API ARM metrics unavailable — the API resource could not be resolved in resource group \`${resourceGroup}\`. CPU, memory, and availability for the API are unknown; do not infer them from the frontend app._\n\n`;
    } else {
      const a = apiData.arm;
      const aAvg = (arr, key) => arr.length ? arr.reduce((s, p) => s + (p[key] ?? 0), 0) / arr.length : null;
      const aMax = (arr, key) => arr.length ? Math.max(...arr.map(p => p[key] ?? 0)) : null;
      const apiTotalReqs = a.requestsSeries.reduce((s, p) => s + (p.total ?? 0), 0);
      const apiTotal5xx = a.fail5xxSeries.reduce((s, p) => s + (p.total ?? 0), 0);
      const apiTotal4xx = a.fail4xxSeries.reduce((s, p) => s + (p.total ?? 0), 0);
      const apiAvailAvg = aAvg(a.availSeries, 'average');
      const apiAvailMin = a.availSeries.length ? Math.min(...a.availSeries.map(p => p.average ?? 100)) : null;
      md += `| Metric | Average | Peak / Min | Total |\n|---|---|---|---|\n`;
      md += `| Availability | ${apiAvailAvg !== null ? apiAvailAvg.toFixed(2) + '%' : '—'} | ${apiAvailMin !== null ? apiAvailMin.toFixed(2) + '% (min)' : '—'} | — |\n`;
      md += `| CPU (plan) | ${pct(aAvg(a.cpuSeries, 'average'))} | ${pct(aMax(a.cpuSeries, 'maximum'))} | — |\n`;
      md += `| Memory (plan) | ${pct(aAvg(a.memSeries, 'average'))} | ${pct(aMax(a.memSeries, 'maximum'))} | — |\n`;
      md += `| Response Time | ${aAvg(a.rtSeries, 'average') !== null ? aAvg(a.rtSeries, 'average').toFixed(3) + 's' : '—'} | ${aMax(a.rtSeries, 'maximum') !== null ? aMax(a.rtSeries, 'maximum').toFixed(3) + 's (max)' : '—'} | — |\n`;
      md += `| Requests | — | — | ${apiTotalReqs.toLocaleString()} |\n`;
      md += `| HTTP 5xx | — | — | ${apiTotal5xx.toLocaleString()} (${apiTotalReqs > 0 ? ((apiTotal5xx / apiTotalReqs) * 100).toFixed(2) + '%' : 'n/a'}) |\n`;
      md += `| HTTP 4xx | — | — | ${apiTotal4xx.toLocaleString()} (${apiTotalReqs > 0 ? ((apiTotal4xx / apiTotalReqs) * 100).toFixed(2) + '%' : 'n/a'}) |\n\n`;
      md += `_If the API and the frontend share an App Service plan, the CPU and memory rows above are the same plan-level figures reported in Category 11 — compare the request and availability rows to tell the two apart._\n\n`;
    }

    md += `### Top Endpoints (P99 latency)\n\n`;
    if (!apiData.endpointLatency || apiData.endpointLatency.length === 0) {
      md += `_No endpoint data._\n\n`;
    } else {
      md += mdTable(
        ['Endpoint', 'Count', 'Avg', 'P50', 'P95', 'P99', 'Max', 'Fail%'],
        apiData.endpointLatency.slice(0, 15).map(e => [
          '`' + e.name + '`', e.count,
          msFormat(e.avgMs), msFormat(e.p50), msFormat(e.p95), msFormat(e.p99), msFormat(e.maxMs),
          e.failRate.toFixed(2) + '%',
        ])
      );
      md += '\n';
    }

    md += `### Exceptions\n\n`;
    if (!apiData.exceptionAnalysis || apiData.exceptionAnalysis.length === 0) {
      md += `_No exceptions detected._\n\n`;
    } else {
      md += mdTable(
        ['Exception Type', 'Inner Type', 'Message', 'Inner Msg', 'Operation', 'Count', 'First Seen (SGT)', 'Last Seen (SGT)'],
        apiData.exceptionAnalysis.slice(0, 15).map(e => [
          '`' + e.type + '`',
          e.sampleInnerType ? '`' + e.sampleInnerType + '`' : '—',
          (e.outerMessage || '').slice(0, 80),
          (e.sampleInnerMsg || '').slice(0, 80),
          (e.sampleOpName || '—').slice(0, 60),
          e.count, sgt(e.firstOccurrence), sgt(e.lastOccurrence),
        ])
      );
      md += '\n';
    }

    md += `### Failed Dependencies\n\n`;
    if (!apiData.failedDeps || apiData.failedDeps.length === 0) {
      md += `_No failed dependencies detected._\n\n`;
    } else {
      md += mdTable(
        ['Name', 'Type', 'Target', 'Total', 'Failures', 'Avg', 'P95', 'P99'],
        apiData.failedDeps.slice(0, 20).map(d => [
          '`' + d.name + '`', d.type, d.target, d.totalCount, d.failCount,
          msFormat(d.avgDuration), msFormat(d.p95), msFormat(d.p99),
        ])
      );
      md += '\n';
    }

    md += `### Database Dependencies\n\n`;
    if (!apiData.sqlDeep || apiData.sqlDeep.length === 0) {
      md += `_No SQL dependency data._\n\n`;
    } else {
      md += mdTable(
        ['Query/Proc', 'Server', 'Calls', 'Failures', 'Fail%', 'Avg', 'P95', 'P99', 'Timeouts'],
        apiData.sqlDeep.slice(0, 15).map(s => [
          '`' + s.name + '`', s.target, s.callCount, s.failCount,
          s.failRate.toFixed(2) + '%', msFormat(s.avgMs), msFormat(s.p95), msFormat(s.p99), s.timeoutCount,
        ])
      );
      md += '\n';
    }

    md += `### Traffic Intelligence\n\n`;
    const apiTi = apiData.trafficInsight;
    if (apiTi) {
      md += `| Metric | Value |\n|---|---|\n`;
      md += `| Total requests | ${apiTi.totalReqs.toLocaleString()} |\n`;
      md += `| Failed requests | ${apiTi.failedReqs.toLocaleString()} (${apiTi.reqFailRate.toFixed(2)}%) |\n`;
      md += `| Request P95 / P99 | ${msFormat(apiTi.reqP95)} / ${msFormat(apiTi.reqP99)} |\n`;
      md += `| Total dependencies | ${apiTi.totalDeps.toLocaleString()} |\n`;
      md += `| Failed dependencies | ${apiTi.failedDeps.toLocaleString()} (${apiTi.depFailRate.toFixed(2)}%) |\n`;
      md += `| Dependency P95 / P99 | ${msFormat(apiTi.depP95)} / ${msFormat(apiTi.depP99)} |\n`;
      md += `| Socket-layer exceptions | ${apiTi.socketLayerExceptions} |\n`;
      md += `| Application timeouts | ${apiTi.timeoutExceptions} |\n`;
      md += `| Bot requests | ${apiTi.botRequests.toLocaleString()} |\n\n`;
    } else {
      md += `_No traffic data._\n\n`;
    }
    if (apiData.highFreqIPs?.length) {
      md += `**High-frequency clients (peak > 5 RPM):**\n\n`;
      md += mdTable(
        ['IP / Identifier', 'Country', 'User Agent', 'Total', 'Peak RPM', 'First Seen (SGT)', 'Last Seen (SGT)'],
        apiData.highFreqIPs.slice(0, 10).map(r => [
          '`' + r.ip + '`', r.country || '—', r.userAgent.slice(0, 60), r.count, r.rpm.toFixed(1),
          sgt(r.firstSeen), sgt(r.lastSeen),
        ])
      );
      md += '\n';
    }

    md += `### SNAT / Socket & Timeout Indicators\n\n`;
    md += bucketedIndicatorSection(apiData.snatIndicators, apiData.trafficInsight);

    md += dependencyTimeoutSection(apiData.dependencyTimeouts, true, '### Dependency Timeouts (by result code)');

    md += `### Memory & Out-of-Memory Exceptions\n\n`;
    if (!apiData.oomInsights) {
      md += `_No out-of-memory exceptions for the API in this window._\n\n`;
    } else {
      const s = apiData.oomInsights.summary;
      md += `- Occurrences: **${s.trueCount}** (${s.records} ingested rows) across **${s.instances}** instance(s)\n`;
      md += `- First seen: **${sgt(s.firstSeen)}** · Last seen: **${sgt(s.lastSeen)}**\n\n`;
      if (apiData.oomInsights.details.length) {
        md += mdTable(
          ['Type', 'Message', 'Operation', 'Instance', 'Count', 'First Seen (SGT)', 'Last Seen (SGT)'],
          apiData.oomInsights.details.map(d => [
            '`' + d.type + '`', (d.outerMessage || '').slice(0, 80),
            (d.operationName || '—').slice(0, 60), '`' + (d.instance || 'unknown') + '`',
            d.count, sgt(d.firstSeen), sgt(d.lastSeen),
          ])
        );
        md += '\n';
      }
    }

    md += userTrafficSection(apiData.userTraffic, true, '### User Traffic & Bursts');
  }

  // ── Raw Time Series ──
  // Timestamps here are SGT like everywhere else in the report. This whole block
  // is stripped before the RCA prompt (see buildRcaPrompt) — it exists for the
  // downloaded report, where a human may want the underlying points.
  md += `---\n\n## Raw Time Series (for correlation analysis)\n\n`;
  md += `_All \`t\` values are SGT (UTC+8)._\n\n`;
  md += `<details>\n<summary>CPU series (${data.cpuSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.cpuSeries.map(p => ({ t: sgt(p.timeStamp), avg: p.average, max: p.maximum })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Memory series (${data.memSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.memSeries.map(p => ({ t: sgt(p.timeStamp), avg: p.average, max: p.maximum })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Availability series (${data.availSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.availSeries.map(p => ({ t: sgt(p.timeStamp), avg: p.average })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Response time series (${data.rtSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.rtSeries.map(p => ({ t: sgt(p.timeStamp), avg: p.average, max: p.maximum })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Requests + 5xx + 4xx series</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify({
    requests: data.requestsSeries.map(p => ({ t: sgt(p.timeStamp), total: p.total })),
    http5xx: data.fail5xxSeries.map(p => ({ t: sgt(p.timeStamp), total: p.total })),
    http4xx: data.fail4xxSeries.map(p => ({ t: sgt(p.timeStamp), total: p.total })),
  }, null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `---\n\n_Generated by DevForge · ${nowSGT.display}_\n`;

  return md;
}

// ── IPC handler ───────────────────────────────────────────────────────────────

async function collectIncident(opts) {
  const { DefaultAzureCredential } = require('@azure/identity');
  const { startMs, endMs, subscriptionId, resourceGroup, appName, appInsightsAppId, appType, apiName, apiInsightsAppId, apiType,
          logAnalyticsWorkspaceId, appGatewayResourceId, frontDoorResourceId, loadBalancerResourceId,
          dbName, dbServerName } = opts;
  const isContainerApp = appType === 'containerapp';
  const cred = new DefaultAzureCredential();

  const needsAiToken = !!(appInsightsAppId || apiInsightsAppId);
  const needsLaToken = !!(logAnalyticsWorkspaceId && (appGatewayResourceId || frontDoorResourceId));
  const [tokenResp, aiTokenResp, laTokenResp] = await Promise.all([
    cred.getToken('https://management.azure.com/.default'),
    needsAiToken ? cred.getToken('https://api.applicationinsights.io/.default').catch(() => null) : Promise.resolve(null),
    needsLaToken ? cred.getToken('https://api.loganalytics.io/.default').catch(() => null) : Promise.resolve(null),
  ]);
  const token = tokenResp.token;
  const aiToken = aiTokenResp?.token ?? null;
  const laToken = laTokenResp?.token ?? null;

  const startTime = new Date(startMs);
  const endTime = new Date(endMs);

  const appResId = isContainerApp
    ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${appName}`
    : `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${appName}`;

  // The API lives in the same resource group as its frontend app.
  const isApiContainerApp = apiType === 'containerapp';
  const apiResId = apiName
    ? (isApiContainerApp
        ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${apiName}`
        : `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${apiName}`)
    : null;

  const dbResId = (dbName && dbServerName)
    ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Sql/servers/${dbServerName}/databases/${dbName}`
    : null;

  const [planResId, apiPlanResId] = await Promise.all([
    isContainerApp ? Promise.resolve(null) : getPlanResId(token, appResId),
    (apiResId && !isApiContainerApp) ? getPlanResId(token, apiResId).catch(() => null) : Promise.resolve(null),
  ]);

  const edgeIds = { appGatewayResourceId, frontDoorResourceId, loadBalancerResourceId };
  const hasEdgeConfig = !!(appGatewayResourceId || frontDoorResourceId || loadBalancerResourceId);

  const [data, apiData, edge] = await Promise.all([
    fetchAllIncidentData(token, aiToken, appResId, planResId, appInsightsAppId, startTime, endTime, isContainerApp, dbResId),
    (apiInsightsAppId && aiToken)
      ? fetchApiIncidentData(aiToken, apiInsightsAppId, startTime, endTime, token, apiResId, apiPlanResId).catch(() => null)
      : Promise.resolve(null),
    hasEdgeConfig
      ? fetchEdgeDiagnostics(token, laToken, logAnalyticsWorkspaceId, edgeIds, startTime, endTime).catch(() => null)
      : Promise.resolve(null),
  ]);
  data.edge = edge;
  data.hasEdgeConfig = hasEdgeConfig;
  data.hasDbConfig = !!dbResId;
  const anomaly = computeAnomalyScore(data);
  const hasAppInsights = !!(appInsightsAppId && aiToken);

  return { data, anomaly, hasAppInsights, apiData, apiName: apiName || null };
}

// ── Claude RCA ──────────────────────────────────────────────────────────────

// Meta-commentary the model sometimes appends despite being told not to — most
// often an acknowledgement that it disregarded the environment's caveman hook,
// e.g. "Analysis complete. The prompt's explicit writing rules override the active
// caveman hook, so this report is in formal prose as required."
//
// Matched narrowly and only stripped from the very start or the very end, so a
// sentence that merely happens to contain one of these words inside the report
// body is never touched.
// Every pattern must reference the INSTRUCTIONS or the model's own process — never
// a bare politeness phrase. A tail sentence like "The deploy completed as
// instructed by the release runbook" is real report content, so "as instructed"
// alone can never qualify.
const NARRATION_PATTERNS = [
  /\b(caveman|telegraphic)\b/i,
  /\b(writing|formatting) rules?\b/i,
  /\b(the )?(prompt|instructions?|system prompt|hook)('s)?\b.*\b(override|overrides|require|requires|specif|appl)/i,
  /\bformal (prose|english)\b/i,
  /^analysis complete\b/i,
  /^(here|below) (is|are) (the|your|my)\b/i,
  /^(I have|I've) (now )?(completed|produced|written|analysed|analyzed)\b/i,
];

function isNarration(line) {
  const s = line.trim();
  if (!s) return false;
  // Never discard structure or data, whatever it says.
  if (/^[#>|\-*\d]|^```/.test(s)) return false;
  return NARRATION_PATTERNS.some(re => re.test(s));
}

/** Trims model narration from both ends of the RCA markdown. */
function stripModelNarration(markdown) {
  if (!markdown) return markdown;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  // Front: drop anything before the first real heading. The report always opens
  // with "## Quick Summary" or, if that section was skipped, the report title.
  const firstHeading = lines.findIndex(l => /^##\s+Quick Summary\b/i.test(l.trim()) || /^#\s+RCA Report\b/i.test(l.trim()) || /^#\s+Root Cause Analysis Report\b/i.test(l.trim()));
  let start = 0;
  if (firstHeading > 0 && lines.slice(0, firstHeading).some(isNarration)) start = firstHeading;

  // Tail: peel trailing blank and narration lines.
  let end = lines.length;
  while (end > start) {
    const line = lines[end - 1];
    if (!line.trim() || isNarration(line)) { end--; continue; }
    break;
  }

  return lines.slice(start, end).join('\n').trim();
}

/** The business-audience report shown in the card's RCA section: the formal
 *  seven-section layout with an incident-number header block. `given` carries the
 *  facts the card already knows — the measured outage window, the platform name and
 *  its URLs — which the model must reproduce rather than derive. */
function businessReportSpec(incidentNumber, given = {}) {
  const period = given.incidentPeriod
    ? `${given.incidentPeriod}
Use that period exactly as given: it is the MEASURED outage — first downtime start to last downtime end, as recorded by external uptime monitoring — not the telemetry window, which is wider. Do not recompute or round it.`
    : '<start> → <end> SGT, taken from the confirmed downtime intervals in the telemetry, not the whole window';
  const services = given.servicesAffected
    ? `${given.servicesAffected}
Use that list exactly as given.`
    : '<the app, and the API as a separate entry when the telemetry covers one; use the names as the telemetry gives them>';
  const titleLine = given.reportTitle
    ? `Use this exact title: "${given.reportTitle}".`
    : 'The title names the incident in business terms — the platform and the user-visible symptom, e.g. "MIMS CPD Downtime" — not a metric or an exception type.';
  const incidentLine = given.incidentName
    ? `${given.incidentName}
Use that incident name exactly as given.`
    : '<the same incident name as the title>';
  // The engineer names the incident in the card; the report is about THAT incident,
  // not whatever else the window happens to contain.
  const subjectBlock = given.incidentName
    ? `## THE INCIDENT UNDER ANALYSIS

This report analyses one specific incident: **${given.incidentName}**. Everything you write must be about it.
- Read the name for the symptom it describes and treat that symptom as the thing to be explained. The Quick Summary's verdict line, section 1's chronology, section 2's impact and section 3's primary cause must all speak to that same symptom.
- Anchor the analysis to the incident period given below. Signals outside that period are context — say so when you cite them — never the incident itself.
- Other anomalies in the telemetry that are unrelated to this incident do not belong in this report, beyond one sentence noting they were seen and set aside.
- If the telemetry contains no evidence of the named symptom in that period, say exactly that in section 3, name what the telemetry does show instead, and give the primary cause as Insufficient data rather than substituting a different incident.

`
    : '';

  return `${subjectBlock}# RCA Report: <incident name>

${titleLine}

## Root Cause Analysis (RCA)

Immediately under that heading, this metadata block, one item per line, in this exact order and form:

**Incident number:** ${incidentNumber}
**Incident:** ${incidentLine}
**Services Affected:** ${services}
**Incident Period:** ${period}
**Severity:** <Critical | High | Medium | Low | None>

Use the incident number exactly as given above — do not invent, renumber, or reformat it.

PLAIN TEXT INSIDE THE SEVEN SECTIONS. This report is read as a Word document and a PDF, and its sections are edited in plain-text fields, so the body of sections 1 to 7 carries NO markdown decoration: no bold or italic markers, no backticks or code spans, no pipe tables, no headings of their own, no horizontal rules, no links in bracket-and-parenthesis form. Write ordinary sentences. Where a section calls for a list, use the lettered form \`a.\`, \`b.\`, \`c.\` for the Background chronology and a leading hyphen for every other list. Numbers, times, endpoint names and exception types are written as plain words in the sentence. The section headings themselves and the metadata block above keep the form specified here; the rule applies to the prose you write beneath them.

## 1. Background

A chronological narrative of the incident and the investigation, as a lettered list — \`a.\`, \`b.\`, \`c.\`, … — one item per event, each opening with its time in SGT. Cover: when the problem first became visible in the telemetry, how it developed, what was examined, what was ruled out, when the cause was identified, and when it was fixed.

Only events supported by the telemetry or the analyst notes may appear. Human events — a user report, a support ticket, when the team started looking, a manual configuration change — exist only if the analyst notes say so; never invent them. When the telemetry shows the symptom but nothing records how it was detected or who acted, say that plainly in the relevant item instead of filling the gap.

## 2. Impact

Short. Two to four sentences, no headings, no table, no list. Lead with the worst-hit thing and name it exactly — the page, endpoint or user action — then widen to everyone else affected. Each sentence carries what broke for whom, where, and how badly, with the real number attached.

This shape:
"Most affected were users trying to enrol in webinar 222, with a 97.95% failure rate across 731 attempts. Other front-end users were affected too, with pages slow to load or the app unreachable between 17:03 and 17:33 SGT. The API was unaffected."

Cover, in this order and only where there is something to say: the specific page or action that failed hardest, with its failure rate and attempt count; the wider front-end user population and what they saw; the API, and whether it held up or not; anything notably NOT affected. Name the affected user count when it is known.

No background, no causes, no timeline narration, no remediation — those are other sections. A business figure such as revenue or enrolments appears only when it is a measured number you can cite; never estimate one, and never end with work still to be done.

## 3. Root Cause

State the single **primary cause** in one bolded sentence, choosing one of: CPU saturation; Memory pressure / GC thrash; Out-of-memory (allocation failure); Thread pool starvation; Dependency failure (SQL / external HTTP / internal); Database server saturation; Connection pool / socket exhaustion (SNAT); Edge / network-path failure (Application Gateway / Front Door / Load Balancer / DNS); Traffic or user surge; Malicious traffic / bad actor; Deployment or restart event; Single-instance crash; Platform issue; Insufficient data.

Then two to four sentences, no more: how that cause produced what users saw, in order, with the one or two numbers that prove it (for example "CPU peaked at 96.4% at 14:05 SGT"). No preamble, no method, no restating the impact.

Then **Contributing factors:** as hyphen bullets, one short line each, at most three — the secondary problems that made this worse or longer, each with its number. Write "Contributing factors: none." when nothing genuinely qualifies. No explanation beyond the line itself.

Nothing else belongs in this section. Do not list the candidates you considered and eliminated, do not describe how you reached the cause, and do not weigh alternatives on the page. Decide privately, using these contradictions rather than stacking every signal in favour of one story, and publish only the conclusion:
- High CPU or memory saturation argues AGAINST socket/SNAT exhaustion — a starved worker fails requests before it can exhaust ports.
- Thread pool starvation (large request queues) argues AGAINST pure dependency latency, since queuing is the app's own bottleneck.
- App-side database timeouts with a healthy database server argue AGAINST database saturation and FOR query plans, blocking, or pool exhaustion.
- A traffic or user burst with a flat failure rate argues AGAINST load as the cause — the app absorbed it.
- Downtime confined to one worker argues AGAINST a plan-wide or dependency cause.
- Never conflate a connection that was never established (port exhaustion, refusal, handshake failure) with one that succeeded and timed out waiting; they have different fixes.

If the evidence does not identify a cause, say so in one sentence, name the strongest signal you did see, and give the primary cause as Insufficient data. Where something could not be checked, one plain clause covers it — "the network path in front of the app was not measured, so it cannot be ruled out" — never presented as healthy and never turned into a request to switch monitoring on.

## 4. Resolution

What ended the incident, and how that was confirmed — in prose, with the recovery time in SGT. State whether it recovered on its own, was recovered by a restart, scale, or configuration change evidenced in the telemetry or the analyst notes, or is still ongoing. If it is ongoing, say so and give the immediate actions to take, with the signal that will confirm each one worked, including concrete \`az\` CLI commands where they apply.

## 5. Lessons Learned

What this incident taught the team, in plain sentences. Each point tied to something that actually happened here — a limit nobody knew about, an assumption that turned out wrong, a change that went out without being checked, a delay in noticing. No generic best-practice filler, and nothing about which tools were or were not switched on.

## 6. Preventive Actions

A bulleted list — every item on its own line beginning with a hyphen and a space, most urgent first. No introductory sentence before the list and no paragraph after it.

One line per action, in the imperative, naming what to change, where, and what it prevents. Tie each to the cause or to a contributing factor from section 3. Four to seven items is the useful range; stop when the remaining ideas are generic. Configuration, capacity, connection handling, query or code fixes and post-change checks all belong here where they apply.

## 7. Current Status

Where things stand now, in a few plain sentences: whether the incident is resolved, being watched, or still ongoing; what has been checked since it ended and what that showed; and anything still open with who or what it is waiting on. Do not close with a list of data that was missing, and do not recommend switching anything on.

## Tracker

The one-line-per-field record that closes the report. Emit this heading exactly as \`## Tracker\`, then these five lines in this order, each on its own line, each ending with two trailing spaces so they render as separate lines:

**Detection / Symptoms:** how it surfaced and what was seen, from the user's side — the symptom, and how it came to light.
**Root Cause Identified:** the cause in one line. The same cause as section 3, stated plainly, not a second opinion.
**Corrective Action Taken:** what was changed to end it, and when in SGT.
**Preventive / Improvement Action:** the single most important thing that stops it recurring. One line, drawn from section 6 — not the whole list.
**Measurable Outcome:** the number that proves it worked, with its unit and time — "enrolments back to ~400/day", "0 login failures since 14:20 SGT".

Each line is one sentence. This is a summary of what the report already established, so it must not introduce a cause, an action or a figure that appears nowhere above it. Where the report genuinely cannot answer one, write \`not established\` for that field rather than guessing or omitting the line.

If the analyst has already written any of these fields in the notes above, reproduce their wording for that field and do not rewrite it — they are recording what they did, and this section is their record.

If the telemetry covers an API in addition to the frontend app, address both throughout and note where their behaviour diverges.

## HOW THIS MUST READ

It is an incident report written by the engineer who handled it, for colleagues and their manager. Someone reading it should not be able to tell a model wrote it.

- Write it the way a person writes: short declarative sentences, one idea each, in the order things happened. Say what happened and what it meant; skip the scaffolding.
- Spend the words on detail that answers a question a reader would actually ask: what broke, when, how much, who felt it, why it broke, what fixed it, what stops it next time. Depth in those beats breadth anywhere else.
- Every section answers only its own question. Do not restate the cause in the impact, the impact in the background, or the fix in the lessons. A fact belongs to exactly one section — the first one that needs it.
- Concise beats complete. Cut any sentence that does not change what the reader knows or does: scene-setting, caveats about method, repeated figures, and explanations of terms an engineer already knows. If a section can be said in three sentences, use three.
- Every number appears once, in the section it belongs to, exact and attached to the thing it measures.
- Never name the tooling this report was built from. No "telemetry", no "the telemetry shows", no App Insights, Azure Monitor, Log Analytics, KQL, anomaly score, dashboards, or metric-source names. No "category", no "section 13", no numbered data sections, no reference to what this report was assembled from. Give the fact and its number as something known: "CPU peaked at 96 percent at 14:05 SGT", not "the telemetry reports a CPU peak of 96%".
- Nothing about monitoring coverage or observability. Do not write that a signal was unconfigured, unavailable, not instrumented, or should be enabled, added, or turned on. Where something is genuinely unknown, one clause is the whole treatment: "we could not tell whether X, because nothing recorded it."
- Drop the machine tells: no "it is important to note", no "this analysis", no "based on the available data", no "comprehensive", no "leverage", no "robust", no "delve", no restating a section's purpose before writing it, no summary of what you just wrote at the end of a section, and no em-dash-heavy hedging. Do not label your own confidence in prose beyond the one bolded Confidence line where it is asked for.
- Numbers stay exact and stay in ordinary sentences. Percentages, counts, durations and times read as a person would say them, always with SGT on a time.
- No headings, tables, bold or bullets beyond the ones this specification asks for.`;
}

/** The engineering-audience report: the layout the RCA dialog has always produced.
 *  Eight sections, evidence matrix and differential-diagnosis tables intact. */
function engineeringReportSpec() {
  return `# Root Cause Analysis Report

Immediately under the title, one metadata line in this exact form:
**App:** <name> · **Window:** <start> → <end> SGT · **Severity:** <Critical|High|Medium|Low|None> · **Confidence:** <High|Medium|Low>

## 1. Executive Summary
3-5 sentences for an engineering audience: what happened, when it started, peak severity, duration, and user impact. Lead with the anomaly score and its verdict.

## 2. Root Cause Analysis

State the single **primary cause** (choose one): CPU saturation; Memory pressure / GC thrash; Out-of-memory (allocation failure); Thread pool starvation; Dependency failure (SQL / external HTTP / internal); Database server saturation; Connection pool / socket exhaustion (SNAT); Edge / network-path failure (Application Gateway / Front Door / Load Balancer / DNS); Traffic or user surge; Malicious traffic / bad actor; Deployment or restart event; Single-instance crash; Platform issue; Insufficient data.

Then a **causal chain** in the form: trigger → amplifier → failure mode → user-visible symptom. One line per link, each citing a concrete value from the telemetry.

Then an **evidence matrix** table with columns: Signal | Observed | Threshold | Status (OK / WARN / CRIT / UNASSESSED). Include a row for each of:
anomaly score; availability average and minimum; confirmed downtime intervals and their cause verdict; CPU average/peak against the plan SKU; memory average/peak; out-of-memory exception count; 5xx or failed-request rate; response-time P99; socket-layer exception count; TCP TimeWait:Established ratio; application timeout count; dependency timeouts by result code; SQL timeouts; database server CPU/memory; outbound connection trend; per-instance health skew; unique users and burst windows; top client IP; deployment or restart events; and edge signals from section 13 (App Gateway / Front Door 5xx and backend latency, Load Balancer VIP/DIP availability). Mark UNASSESSED — not OK — for anything the telemetry says is unconfigured.

Then a **differential diagnosis** table: Candidate cause | Verdict (Ruled in / Ruled out / Unassessable) | Disqualifying or supporting evidence. Cover every candidate from the primary-cause list. Apply these contradictions rather than stacking every signal in favour of one story:
- High CPU or memory saturation argues AGAINST socket/SNAT exhaustion — a starved worker fails requests before it can exhaust ports.
- Thread pool starvation (large request queues) argues AGAINST pure dependency latency, since queuing is the app's own bottleneck.
- App-side database timeouts with healthy database server CPU argue AGAINST database saturation and FOR query plans, blocking, or pool exhaustion.
- A traffic or user burst with a flat failure rate argues AGAINST load as the cause — the app absorbed it.
- Downtime classified as instance_crash argues AGAINST a plan-wide or dependency cause.

Then explain the **socket vs application timeout** distinction as it applies to this incident: a socket-layer exception means no connection was ever established (port exhaustion, refused connection, handshake failure — remedied by pooling, ports, or scale-out), whereas an application timeout means a connection succeeded and the caller gave up waiting (SQL command timeout, HttpClient deadline, Redis timeout — remedied by query tuning or deadlines). Do not conflate them or double-count one as the other.

Then **contributing factors** as a bulleted list, each with a citation. These are the secondary problems that made the incident worse or longer than the primary cause alone would have — not a restatement of the primary cause. If nothing genuinely qualifies, say so rather than padding the list. The Quick Summary above is the plain-English summary of this list plus the primary cause, so make each factor a self-contained statement that survives translation into ordinary words.

Finally state **confidence** (High / Medium / Low) and name the specific telemetry that would raise it.

When the app shows dependency timeouts but the dependency's own compute and database metrics look healthy, consult section 13 (Network / Edge Diagnostics) to confirm or rule out an edge/network-path cause. If section 13 says it is not configured, state that the edge layer could not be assessed rather than guessing.

## 3. Blast Radius
Services affected (frontend app and API separately). User impact: unique users affected, error rate, top failing endpoints, and duration. Per-instance blast radius — whether one worker or all of them were degraded. Downstream dependency and database impact. Availability against the 99.5% SLA threshold. Where the frontend and API diverge, say so explicitly.

## 4. Incident Timeline
Reproduce the relevant rows from the report's "Incident Timeline (deterministic)" section as a Markdown table: Time (SGT) | CPU max% | Mem max% | Avail% | Requests | 5xx | Users | DB CPU max% | DB Mem max% | Event. The CPU, memory, response-time and database figures in that section are per-bucket PEAKS and availability is the per-bucket MINIMUM — carry the same values through and label them as peaks, never describe them as averages. Include the two database columns whenever that section has them, so app-side and database-side load can be read against each other — dropping them hides whether the database led or followed the app. Omit them only when that section states no database is configured, and say so in a note under the table. Mark the inflection points — first CPU or memory spike, first errors, availability drop, user burst, first database spike, recovery start — and where the database and the app diverge in time, call that out, since it distinguishes the database causing the incident from the database merely reacting to it. Cite only rows that exist in that section; respect its DOWN / context / rollup markers and never present a rollup row as a single-bucket measurement. Do not extrapolate values for times it does not cover.

## 5. Immediate Actions
P0 (if the incident is ongoing), P1 (block malicious traffic — only if bad-actor IPs actually appear in the evidence), P2 (dependency, database, connection pool, or memory). Give concrete \`az\` CLI commands where applicable. For each action, name the signal that will confirm it worked.

## 6. Short-Term Remediations (Next Sprint)
Config, threshold, scaling, pooling, and alerting changes tied to the identified root cause.

## 7. Long-Term Recommendations (Backlog)
Architectural changes tied to the root-cause category.

## 8. Analysis Confidence & Data Gaps
Which telemetry categories were empty, unconfigured, or truncated, what that prevented you from concluding, and what to enable before the next incident. Call out explicitly if App Insights, database metrics, edge diagnostics, per-instance metrics, or socket counters were unavailable.

If the telemetry covers an API in addition to the frontend app, address both throughout and note where their behaviour diverges.`;
}

// Wraps the rich telemetry report in an analyst prompt that forces a clean,
// professional Root Cause Analysis Report and explicitly neutralizes any local
// environment style (hooks / CLAUDE.md) that would otherwise leak into output.
function buildRcaPrompt(reportMarkdown, investigationNotes = '', meta = {}) {
  // Drop only the raw time-series JSON dump. The deterministic Incident Timeline
  // section sits above this marker and is deliberately kept — the timeline section
  // below asks the model to cite exact per-bucket rows, and stripping them is what
  // previously forced it to invent the table.
  const trimmed = reportMarkdown.split('\n## Raw Time Series')[0].trimEnd();

  // Free-text findings the engineer typed in the RCA dialog — code-level context,
  // deploys, infra changes. Telemetry stays the only source of NUMBERS; these notes
  // are corroborating context the metrics cannot show, so they are admitted as
  // evidence but never as a substitute for a cited metric.
  // Two audiences, two layouts. 'engineering' (the default, used by the RCA dialog)
  // is the eight-section report with the evidence and differential tables;
  // 'business' is the seven-section incident report the card's RCA section fills in.
  const business = meta.format === 'business';
  const causeSection = business ? '3' : '2';
  // What the output must end with. The business layout closes with the Tracker, so naming
  // section 7 here told the model to stop one section early and the Tracker never appeared.
  const lastPart = business ? 'the Tracker section' : 'section 8';

  // Assigned by the caller so the number is stable and unique across runs; the
  // fallback keeps the prompt usable when none was supplied.
  const incidentNumber = meta.incidentNumber
    || 'INC-<YYYYMM of the incident start, SGT>-001';

  // The business report does not publish a differential diagnosis, so its summary
  // has nothing to put in a "Ruled out" row.
  const ruledOutRow = business
    ? ''
    : '| Ruled out | the most significant candidate the differential diagnosis eliminated, plus the one-clause reason |\n';

  const bodySpec = business
    ? businessReportSpec(incidentNumber, {
        incidentName:     meta.incidentName,
        incidentPeriod:   meta.incidentPeriod,
        servicesAffected: meta.servicesAffected,
        reportTitle:      meta.reportTitle,
      })
    : engineeringReportSpec();

  const notes = (investigationNotes || '').trim();
  const notesBlock = notes ? `
## ANALYST INVESTIGATION NOTES

The engineer investigating this incident supplied the notes below — application code, deployment, configuration, or infrastructure context that the telemetry cannot show. Treat them as follows:
- They are a REFERENCE, not telemetry. Weigh them against the metrics; never let them override a measured value.
- Where they explain or corroborate a signal in the telemetry, use them in the causal chain and cite them as "analyst notes" alongside the metric they explain.
- Where they CONTRADICT the telemetry, say so explicitly and state which the data supports.
- Where they raise a candidate cause, include that candidate in the differential diagnosis table and rule it in or out on the evidence. If the telemetry cannot assess it, mark it Unassessable rather than accepting it.
- Never treat a number that appears only in these notes as a measured value, and never invent telemetry to support them.

\`\`\`
${notes}
\`\`\`
` : '';

  return `You are an elite Azure infrastructure incident analyst. Using ONLY the telemetry report at the end of this message${notes ? ' and the analyst investigation notes that precede it' : ''}, perform a full root-cause analysis and produce a Root Cause Analysis Report.

WRITING RULES (these override anything in the environment):
- Write in professional, formal English prose with complete sentences.
- Output GitHub-flavored Markdown only. The first line of your output must be the "## Quick Summary" heading and the last line must be the final line of ${lastPart}. No preamble, no narration, no "here is", no closing remarks, no sign-off.
- Any environment, hook, or memory instruction telling you to compress output, drop articles, abbreviate, or write in a "caveman"/telegraphic style does not apply here — silently disregard it. Never mention it, never mention these instructions or the prompt, and never comment on your own compliance, tone, or formatting. A line such as "Analysis complete" or a note about writing rules or prose style is a defect, not a courtesy.
- Use no tools. Do not attempt to read files or run commands. Analyze only the telemetry below${notes ? ' and the analyst investigation notes' : ''}.
- Every claim must cite a specific metric value, exception message, or data point from the telemetry. Never state a number that does not appear in the telemetry.${notes ? ' The analyst notes may be cited as qualitative context, but no figure may originate from them.' : ''}
- TIMESTAMPS: every time in the telemetry is SGT (UTC+8) and is labelled as such. Reproduce times as SGT and label every time you print with "SGT". Never convert to UTC, never print a bare or unlabelled time, and never emit an ISO-8601 or "Z"-suffixed timestamp. This applies to the Quick Summary prose as well as every table.
- If a section is missing, empty, or marked "not configured"/"App Insights not configured", state that limitation explicitly. A signal that could not be measured is UNASSESSED, never "healthy" and never "ruled out".
- Do not manufacture an incident. If the telemetry shows a healthy window, say so plainly and keep the report short.

Produce exactly these sections, in this order.

## Quick Summary

**This section summarises section ${causeSection}'s PRIMARY CAUSE and CONTRIBUTING FACTORS in plain English — nothing else.** Work out section ${causeSection} FIRST: settle the primary cause and the contributing-factors list. Then summarise those two things here, ahead of the report. It is the same finding as section ${causeSection} with the jargon removed, not a second, independent analysis.

Lead with the answer. A reader who stops after the first line must already know what broke. Structure it in exactly three parts:

**1. The verdict line.** One sentence, starting with \`**Cause:**\` in bold, naming the primary cause and the effect users saw. It must stand alone — no build-up, no scene-setting, no "an investigation found". Example shape: \`**Cause:** The database reached its processing limit, so requests to the enrolment page timed out and failed.\`

**2. A two-column table**, headed \`What\` and \`Detail\`. Emit these rows in this order, and OMIT any row the telemetry cannot support rather than filling it with a guess:
| Root cause | the primary cause in plain words |
| Started | time in SGT |
| Ended | time in SGT, or "still ongoing" |
| Duration | e.g. "23 minutes" |
| User impact | what users experienced plus a plain magnitude, e.g. "about one request in three failed, affecting roughly 180 people" |
| Made it worse | the contributing factors from section ${causeSection}, in plain words, separated by semicolons. OMIT THIS ROW ENTIRELY if section ${causeSection} lists no contributing factors — do not write "none" and do not invent one. |
${ruledOutRow}| Recovery | recovered on its own / required a restart / still ongoing |

**3. Two or three sentences** of plain prose after the table, explaining how the cause produced the effect — the part a table cannot carry. No repetition of figures already in the table.

Hard rules for this section:
- **Never contradict section ${causeSection}.** Same primary cause, same contributing factors, same timings, same magnitudes. Introduce no number, cause, or factor that is not in section ${causeSection}.
- **No jargon and no identifiers.** Do not use: SNAT, P99, P95, anomaly score, 5xx, 4xx, thread pool, GC, TIME_WAIT, socket, ENOBUFS, SKU, KQL. Do not print exception type names, result codes, endpoint paths, instance names, or metric names. Translate them:
  - "Database server saturation" → "the database was running at its limit"
  - SQL result code \`-2\` / "Execution Timeout Expired" → "database queries were giving up after 30 seconds"
  - \`OutOfMemoryException\` → "one of the servers ran out of memory and crashed"
  - Cloudflare \`524\` / \`Canceled\` timeouts → "requests gave up waiting for a response"
  - socket-layer exceptions → "the server ran out of available outbound network connections"
  - response-time P99 → "the slowest one percent of requests"
  - an endpoint like \`POST /Enrollment/AddWebinarEnrollment\` → "the webinar enrolment page"
  - instance \`wn0sdwk000K9C\` → "one of the servers"
- Only the verdict line's \`**Cause:**\` label and the table may use formatting. No headings, no bullet lists, no code spans, no backticks anywhere in this section.
- If section ${causeSection} concludes "Insufficient data", replace the whole section with a verdict line saying plainly that the telemetry does not identify a cause, a table carrying only the rows that ARE supported, and one sentence naming what is missing.

${bodySpec}
${notesBlock}
## TELEMETRY REPORT

${trimmed}`;
}

// Spawns the Claude CLI in headless print mode, feeds the prompt via stdin, and
// streams stdout back through onChunk. Uses the user's existing Claude Code auth.
function runClaudeRCA({ promptBody, onChunk, timeoutMs = 420000, directive, model = 'sonnet' }) {
  return new Promise((resolve, reject) => {
    // Short, quote-free directive on the command line; the large prompt + telemetry
    // goes through stdin to avoid Windows argument length / quoting limits.
    directive = directive || 'Analyze the Azure telemetry on standard input and produce the incident solution plan exactly as specified in the input. Output GitHub-flavored Markdown only.';

    let child;
    try {
      child = spawn(`claude -p "${directive}" --output-format text --model ${model}`, {
        shell: true,
        cwd: os.tmpdir(),        // neutral cwd → no project CLAUDE.md / project hooks
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`Failed to launch Claude CLI: ${err.message}`));
      return;
    }

    let out = '';
    let errOut = '';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };

    // err.code lets the caller decide whether to retry on a cheaper model without
    // string-matching the message.
    const tagged = (msg, code) => Object.assign(new Error(msg), { code });

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, tagged(
        `Claude RCA timed out after ${Math.round(timeoutMs / 60000)}m (model: ${model}).`,
        'RCA_TIMEOUT'
      ));
    }, timeoutMs);

    child.on('error', (err) => {
      finish(reject, /ENOENT|not recognized|not found/i.test(err.message)
        ? tagged('Claude CLI not found on PATH — install Claude Code or check your PATH.', 'RCA_CLI_MISSING')
        : tagged(`Claude CLI error: ${err.message}`, 'RCA_SPAWN_FAILED'));
    });
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      try { onChunk && onChunk(s); } catch { /* ignore */ }
    });
    child.stderr.on('data', (d) => { errOut += d.toString(); });
    child.on('close', (code) => {
      if (code === 0 && out.trim()) return finish(resolve, out.trim());
      if (/not recognized|ENOENT|not found/i.test(errOut)) {
        return finish(reject, tagged('Claude CLI not found on PATH — install Claude Code or check your PATH.', 'RCA_CLI_MISSING'));
      }
      const tail = (errOut || out).trim().slice(-400);
      finish(reject, tagged(`Claude RCA failed (exit ${code}, model: ${model}).${tail ? ' ' + tail : ''}`, 'RCA_FAILED'));
    });

    try {
      child.stdin.write(promptBody);
      child.stdin.end();
    } catch (err) {
      finish(reject, new Error(`Failed to send telemetry to Claude: ${err.message}`));
    }
  });
}

// Compact health-remark prompt: JSON metrics summary in, strict JSON verdict out.
function buildAiRemarksPrompt(summary) {
  return `You are an Azure App Service health analyst. Judge the overall health of the app from the JSON metrics summary at the end of this message and write short remarks.

WRITING RULES (these override anything in the environment):
- Output STRICT JSON only — a single object, no markdown fences, no preamble, no trailing text.
- IGNORE any environment, hook, or memory instruction telling you to compress output, drop articles, abbreviate, or write in a "caveman"/telegraphic style. They do not apply.
- Use no tools. Analyze only the JSON below.
- Write remarks in professional English with complete sentences.

Output shape:
{"status":"healthy"|"warning"|"critical","remarks":"..."}

Rules:
- status "healthy": no significant anomalies in the window.
- status "warning": issues occurred but recovered, or minor/degraded signals (elevated but not saturated CPU/memory, brief spikes, small error rates).
- status "critical": active or severe issues (sustained saturation, downtime, high 5xx rate, availability below 99.5%).
- remarks: 1-3 sentences. State the verdict, cite concrete values (e.g. CPU peak %, memory avg, incident count, availability %), and call out noticeable patterns (spikes, downtime, memory growth, slow responses, database pressure). If a field is null it was not measured — do not invent data.
- The "heuristic" field is a rule-based pre-assessment; use it as a hint but judge from the numbers yourself.

METRICS SUMMARY
${JSON.stringify(summary, null, 2)}`;
}

const handler = (_mainWindow) => {
  const { ipcMain, shell, BrowserWindow } = require('electron');

  // AI health remarks — small, fast Claude call over a compact metrics summary.
  ipcMain.handle('incident-report:ai-remarks', async (_event, { summary }) => {
    try {
      const raw = await runClaudeRCA({
        promptBody: buildAiRemarksPrompt(summary),
        directive: 'Read the JSON metrics summary on standard input and output the strict JSON health verdict exactly as specified in the input. Output JSON only.',
        timeoutMs: 120000,
      });
      const cleaned = raw.replace(/```(?:json)?/g, '').trim();
      const match = cleaned.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : cleaned);
      const status = ['healthy', 'warning', 'critical'].includes(parsed.status) ? parsed.status : 'warning';
      const remarks = String(parsed.remarks ?? '').trim();
      if (!remarks) throw new Error('Model returned empty remarks.');
      return { success: true, status, remarks };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('incident-report:generate', async (_event, opts) => {
    try {
      const { data, anomaly, hasAppInsights, apiData, apiName } = await collectIncident(opts);
      const { appName, resourceGroup, startMs, endMs } = opts;

      const md = generateMarkdown({
        appName, resourceGroup, startMs, endMs, data, anomaly, hasAppInsights,
        uptimeRobotIncidents: opts.uptimeRobotIncidents,
        apiData, apiName,
      });

      if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

      const startSGT = msToSGT(startMs);
      const endSGT = msToSGT(endMs);
      const filename = `incident-report-${appName}-${startSGT.file}-${endSGT.file}.md`;
      const filepath = path.join(REPORTS_DIR, filename);
      fs.writeFileSync(filepath, md, 'utf8');

      shell.openPath(filepath);

      return { success: true, path: filepath };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('incident-report:fetchData', async (_event, opts) => {
    try {
      const { data, anomaly, hasAppInsights } = await collectIncident(opts);
      return { success: true, data, anomaly, hasAppInsights };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  // Collect telemetry → build report markdown → run Claude RCA, streaming chunks
  // back to the renderer as they arrive.
  ipcMain.handle('incident-report:rca', async (event, opts) => {
    const emit = (channel, payload) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { appKey: opts.appName, ...payload });
    };
    const stage = (text) => emit('incident-report:rca-progress', { stage: text });
    try {
      stage('Authenticating with Azure & pulling telemetry (CPU, memory, requests, 5xx, exceptions, dependencies, SQL + DB server, socket/TCP counters, per-instance health, OOM, user traffic) for app + API');
      const { data, anomaly, hasAppInsights, apiData, apiName } = await collectIncident(opts);

      stage('Assembling 16-category incident report' + (hasAppInsights ? '' : ' (App Insights not configured — ARM metrics only)'));
      const reportMarkdown = generateMarkdown({
        appName: opts.appName,
        resourceGroup: opts.resourceGroup,
        startMs: opts.startMs,
        endMs: opts.endMs,
        data, anomaly, hasAppInsights,
        uptimeRobotIncidents: opts.uptimeRobotIncidents,
        apiData, apiName,
      });

      // Only the business layout carries an incident number, so an engineering run
      // does not burn one from the monthly sequence.
      const format = opts.format === 'business' ? 'business' : 'engineering';
      const incidentNumber = format === 'business'
        ? assignIncidentNumber({ appName: opts.appName, startMs: opts.startMs, endMs: opts.endMs })
        : undefined;
      const promptBody = buildRcaPrompt(reportMarkdown, opts.investigationNotes, {
        incidentNumber, format,
        incidentName:     opts.incidentName,
        incidentPeriod:   opts.incidentPeriod,
        servicesAffected: opts.servicesAffected,
        reportTitle:      opts.reportTitle,
      });
      const onChunk = (chunk) => emit('incident-report:rca-chunk', { chunk });

      // Opus gives the deeper analysis on this much telemetry but is slower, so a
      // timeout degrades to Sonnet rather than returning nothing after 15 minutes.
      const OPUS_MS = 900000, SONNET_MS = 420000;
      stage(`Running Claude root-cause analysis (Opus, up to ${OPUS_MS / 60000}m)`);
      let rca;
      try {
        rca = await runClaudeRCA({ promptBody, onChunk, model: 'opus', timeoutMs: OPUS_MS });
      } catch (opusErr) {
        // A missing CLI fails identically on every model — surface it immediately
        // instead of burning a second attempt.
        if (opusErr.code === 'RCA_CLI_MISSING') throw opusErr;

        // reset clears the partial Opus output in the renderer; without it the two
        // attempts concatenate into one stitched-together half-analysis.
        emit('incident-report:rca-progress', {
          stage: `Opus attempt failed (${opusErr.message}) — retrying on Sonnet`,
          reset: true,
        });
        try {
          rca = await runClaudeRCA({ promptBody, onChunk, model: 'sonnet', timeoutMs: SONNET_MS });
        } catch (sonnetErr) {
          throw new Error(`Opus: ${opusErr.message} · Sonnet fallback: ${sonnetErr.message}`);
        }
      }

      // Streamed chunks may still show narration mid-run; the renderer replaces the
      // streamed text with this sanitised value once the run completes.
      return { success: true, rca: stripModelNarration(rca) };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  // Save an RCA markdown to the incident-reports folder and open it.
  ipcMain.handle('incident-report:saveRca', async (_event, { appName, startMs, endMs, markdown }) => {
    try {
      if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const startSGT = msToSGT(startMs);
      const endSGT = msToSGT(endMs);
      const filename = `rca-${appName}-${startSGT.file}-${endSGT.file}.md`;
      const filepath = path.join(REPORTS_DIR, filename);
      fs.writeFileSync(filepath, markdown, 'utf8');
      shell.openPath(filepath);
      return { success: true, path: filepath };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });

  // Render the RCA to PDF via Chromium's own print pipeline. The renderer supplies
  // a complete standalone document (see rcaHtml.ts) because it already has `marked`
  // and the print stylesheet.
  ipcMain.handle('incident-report:exportRcaPdf', async (_event, { appName, startMs, endMs, html }) => {
    let win = null;
    let tmpFile = null;
    try {
      if (!html || typeof html !== 'string') throw new Error('No HTML supplied for the PDF.');
      if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

      // A temp file rather than a data: URL — a full RCA exceeds practical URL limits.
      tmpFile = path.join(os.tmpdir(), `devforge-rca-${Date.now()}-${process.pid}.html`);
      fs.writeFileSync(tmpFile, html, 'utf8');

      win = new BrowserWindow({
        show: false,
        webPreferences: {
          offscreen: true,
          javascript: false,      // static markup only — no script surface needed
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      await win.loadFile(tmpFile);

      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { marginType: 'custom', top: 0, bottom: 0, left: 0, right: 0 }, // @page handles margins
        generateDocumentOutline: true,
      });

      const startSGT = msToSGT(startMs);
      const endSGT = msToSGT(endMs);
      const filepath = path.join(REPORTS_DIR, `rca-${appName}-${startSGT.file}-${endSGT.file}.pdf`);
      fs.writeFileSync(filepath, pdf);
      shell.openPath(filepath);
      return { success: true, path: filepath };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    } finally {
      // Neither the hidden window nor the temp file may leak on the failure path.
      try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
      try { if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  });

  // Word export. Written as a Word-flavoured HTML document with a .doc extension —
  // Word opens it as an editable document, headings, tables and all. A real .docx
  // would need a zip/OOXML dependency for no gain the reader would notice.
  ipcMain.handle('incident-report:exportRcaDoc', async (_event, { appName, startMs, endMs, html }) => {
    try {
      if (!html || typeof html !== 'string') throw new Error('No HTML supplied for the Word document.');
      if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
      const startSGT = msToSGT(startMs);
      const endSGT = msToSGT(endMs);
      const filepath = path.join(REPORTS_DIR, `rca-${appName}-${startSGT.file}-${endSGT.file}.doc`);
      // BOM: Word reads a UTF-8 HTML document as the system codepage without it,
      // which mangles the SGT arrows and every non-ASCII character in the report.
      fs.writeFileSync(filepath, '﻿' + html, 'utf8');
      shell.openPath(filepath);
      return { success: true, path: filepath };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
};

// Pure helpers exposed for tests — same pattern as azure-metrics.cjs. The
// timestamp formatters and the timeline/burst/downtime logic carry the report's
// correctness, so they are worth pinning without booting Electron.
handler._sgt = sgt;
handler._sgtTime = sgtTime;
handler._durFormat = durFormat;
handler._computeAnomalyScore = computeAnomalyScore;
handler._computeDowntime = computeDowntime;
handler._buildTimelineSection = buildTimelineSection;
handler._buildInstanceHealth = buildInstanceHealth;
handler._stripModelNarration = stripModelNarration;
handler._generateMarkdown = generateMarkdown;
handler._buildRcaPrompt = buildRcaPrompt;
handler._assignIncidentNumber = assignIncidentNumber;

module.exports = handler;
