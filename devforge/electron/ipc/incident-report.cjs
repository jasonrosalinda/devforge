'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

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

function msFormat(ms) {
  if (ms == null || isNaN(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

// ── ARM metric fetch ──────────────────────────────────────────────────────────

async function fetchMetric(token, resId, metricName, startTime, endTime, interval, aggregations) {
  const aggStr = aggregations.join(',').toLowerCase();
  const ts = `${startTime.toISOString()}/${endTime.toISOString()}`;
  const url =
    `https://management.azure.com${resId}/providers/microsoft.insights/metrics` +
    `?api-version=2023-10-01&metricnames=${encodeURIComponent(metricName)}` +
    `&timespan=${encodeURIComponent(ts)}&interval=${interval}&aggregation=${aggStr}`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return data.value?.[0]?.timeseries?.[0]?.data || [];
  } catch { return []; }
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

async function fetchSnatIndicators(appId, aiToken, timespan) {
  const rows = await runKQL(appId, aiToken, timespan, `
exceptions
| where outerMessage has_any ("SocketException", "No buffer space", "ENOBUFS", "actively refused",
    "Connection refused", "timed out", "ETIMEDOUT", "SNAT", "HttpRequestException")
| summarize count=count() by outerMessage, bin(timestamp, 5m)
| order by timestamp asc`);
  if (!rows) return null;
  return rows.map(([outerMessage, timestamp, count]) => ({
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
  const rows = await runKQL(appId, aiToken, timespan, `
let deps=dependencies|summarize TotalDeps=count(),FailedDeps=countif(success==false),DepFailRate=round(todouble(countif(success==false))/count()*100,2),DepP95=percentile(duration,95),DepP99=percentile(duration,99);
let reqs=requests|summarize TotalReqs=count(),FailedReqs=countif(success==false),ReqFailRate=round(todouble(countif(success==false))/count()*100,2),ReqP95=percentile(duration,95),ReqP99=percentile(duration,99);
let ex=exceptions|summarize SocketExceptions=countif(outerMessage has_any("SocketException","timeout","ENOBUFS","No buffer space"));
let bots=requests|extend ua=tostring(customDimensions["User-Agent"])|where ua contains "bot" or ua contains "crawl" or ua contains "spider"|summarize BotRequests=count();
deps|extend JK=1|join kind=inner(reqs|extend JK=1) on JK|join kind=inner(ex|extend JK=1) on JK|join kind=inner(bots|extend JK=1) on JK|project-away JK,JK1,JK2,JK3`);
  if (!rows || !rows.length) return null;
  const row = rows[0];
  return {
    totalDeps: Number(row[0]) || 0,
    failedDeps: Number(row[1]) || 0,
    depFailRate: Number(row[2]) || 0,
    depP95: Math.round(Number(row[3]) || 0),
    depP99: Math.round(Number(row[4]) || 0),
    totalReqs: Number(row[5]) || 0,
    failedReqs: Number(row[6]) || 0,
    reqFailRate: Number(row[7]) || 0,
    reqP95: Math.round(Number(row[8]) || 0),
    reqP99: Math.round(Number(row[9]) || 0),
    socketExceptions: Number(row[10]) || 0,
    botRequests: Number(row[11]) || 0,
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

// ── Data assembly ─────────────────────────────────────────────────────────────

async function fetchAllIncidentData(token, aiToken, resId, planResId, appId, startTime, endTime, isContainerApp = false) {
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
  ]) : Promise.resolve(Array(12).fill(null));

  const [[cpuSeries, memSeries, rtSeries, rawAvailSeries, requestsSeries, fail5xxSeries, fail4xxSeries],
         [exceptionAnalysis, endpointLatency, sqlDeep, deploymentEvents, snatIndicators,
          failedDeps, trafficInsight, highFreqIPs, threadPoolCounters, gcCounters,
          failedUrlsByStatus, slowUrls]]
    = await Promise.all([armPromises, kqlPromises]);

  // Normalize Container App RunningReplicas to 0/100 availability scale
  const availSeries = isContainerApp
    ? rawAvailSeries.map(p => ({ ...p, average: (p.average ?? 0) > 0 ? 100 : 0 }))
    : rawAvailSeries;

  return {
    cpuSeries, memSeries, rtSeries, availSeries, requestsSeries, fail5xxSeries, fail4xxSeries,
    exceptionAnalysis, endpointLatency, sqlDeep, deploymentEvents, snatIndicators,
    failedDeps, trafficInsight, highFreqIPs, threadPoolCounters, gcCounters,
    failedUrlsByStatus, slowUrls,
  };
}

// ── API data fetch ────────────────────────────────────────────────────────────

async function fetchApiIncidentData(aiToken, appId, startTime, endTime) {
  const timespan = `${startTime.toISOString()}/${endTime.toISOString()}`;
  const [endpointLatency, exceptionAnalysis, failedDeps, sqlDeep, trafficInsight, highFreqIPs, snatIndicators] =
    await Promise.allSettled([
      fetchEndpointLatency(appId, aiToken, timespan),
      fetchExceptionAnalysis(appId, aiToken, timespan),
      fetchFailedDeps(appId, aiToken, timespan),
      fetchSqlDependencyDeep(appId, aiToken, timespan),
      fetchTrafficInsight(appId, aiToken, timespan),
      fetchHighFreqIPs(appId, aiToken, timespan),
      fetchSnatIndicators(appId, aiToken, timespan),
    ]);
  const reqRows = await runKQL(appId, aiToken, timespan,
    `requests | summarize total=count(), failed=countif(success==false), avgMs=round(avg(duration),0), p99Ms=round(percentile(duration,99),0)`
  ).catch(() => null);
  return {
    endpointLatency: endpointLatency.status === 'fulfilled' ? endpointLatency.value : null,
    exceptionAnalysis: exceptionAnalysis.status === 'fulfilled' ? exceptionAnalysis.value : null,
    failedDeps: failedDeps.status === 'fulfilled' ? failedDeps.value : null,
    sqlDeep: sqlDeep.status === 'fulfilled' ? sqlDeep.value : null,
    trafficInsight: trafficInsight.status === 'fulfilled' ? trafficInsight.value : null,
    highFreqIPs: highFreqIPs.status === 'fulfilled' ? highFreqIPs.value : null,
    snatIndicators: snatIndicators.status === 'fulfilled' ? snatIndicators.value : null,
    reqSummary: reqRows?.[0] ?? null,
  };
}

// ── Anomaly score ─────────────────────────────────────────────────────────────

function computeAnomalyScore(data) {
  const { availSeries, cpuSeries, rtSeries, fail5xxSeries, snatIndicators, sqlDeep, trafficInsight } = data;

  const avg = (arr, key) => arr.length ? arr.reduce((s, p) => s + (p[key] ?? 0), 0) / arr.length : 0;
  const sum = (arr, key) => arr.reduce((s, p) => s + (p[key] ?? 0), 0);

  const availPct = avg(availSeries, 'average');
  const cpuAvg = avg(cpuSeries, 'average');
  const rtP99 = rtSeries.length ? Math.max(...rtSeries.map(p => p.maximum ?? p.average ?? 0)) : 0;
  const total5xx = sum(fail5xxSeries, 'total');
  const totalReqs = data.requestsSeries.reduce((s, p) => s + (p.total ?? 0), 0);
  const failRate = totalReqs > 0 ? (total5xx / totalReqs) * 100 : 0;
  const snatCount = snatIndicators ? snatIndicators.reduce((s, r) => s + r.count, 0) : 0;
  const sqlTimeouts = sqlDeep ? sqlDeep.reduce((s, r) => s + r.timeoutCount, 0) : 0;

  let score = 0;
  if (availPct > 0 && availPct < 99) score += 30;
  if (cpuAvg > 80) score += 15;
  if (rtP99 > 5000) score += 15;
  if (failRate > 2) score += 20;
  if (snatCount > 10) score += 10;
  if (sqlTimeouts > 5) score += 10;
  if (trafficInsight?.socketExceptions > 5) score += 5;

  return { score: Math.min(score, 100), availPct, cpuAvg, rtP99, failRate, snatCount, sqlTimeouts };
}

// ── Markdown generation ───────────────────────────────────────────────────────

function mdTable(headers, rows) {
  if (!rows || rows.length === 0) return '_No data._\n';
  const head = '| ' + headers.join(' | ') + ' |';
  const sep = '|' + headers.map(() => '---').join('|') + '|';
  const body = rows.map(r => '| ' + r.map(c => c === null || c === undefined ? '—' : String(c).replace(/\|/g, '\\|')).join(' | ') + ' |').join('\n');
  return `${head}\n${sep}\n${body}\n`;
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

  const anomalyLabel = anomaly.score > 70 ? 'HIGH' : anomaly.score > 40 ? 'MEDIUM' : anomaly.score > 10 ? 'LOW' : 'NOMINAL';

  let md = `# Azure App Service Incident Report

> **AI Agent Instructions:** This report contains structured Azure App Service telemetry across 12 RCA categories. Use it to determine: (1) what happened, (2) why it happened, (3) which component caused it, (4) blast radius, (5) mitigation actions. Correlate signals across categories — do not rely on single metrics. Distinguish infrastructure vs. application vs. dependency vs. traffic causes.

**App**: ${appName}
**Resource Group**: ${resourceGroup}
**Analysis Period**: ${startSGT.display} → ${endSGT.display} (UTC+8)
**Generated**: ${nowSGT.display}
**App Insights**: ${hasAppInsights ? 'configured' : 'NOT configured — Categories 1, 4, 5, 6, 7, 8, 10 will show no data'}

---

## Anomaly Score

| Metric | Value |
|---|---|
| **Score** | **${anomaly.score} / 100 — ${anomalyLabel}** |
| Availability avg | ${anomaly.availPct ? anomaly.availPct.toFixed(2) + '%' : 'n/a'} |
| CPU avg | ${anomaly.cpuAvg.toFixed(1)}% |
| Response time P99 (max) | ${msFormat(anomaly.rtP99)} |
| 5xx failure rate | ${anomaly.failRate.toFixed(2)}% |
| SNAT/socket indicators | ${anomaly.snatCount} |
| SQL timeouts | ${anomaly.sqlTimeouts} |

Scoring: avail<99% (+30) · CPU>80% (+15) · RT P99>5s (+15) · 5xx>2% (+20) · SNAT>10 (+10) · SQL timeouts>5 (+10) · socket exceptions>5 (+5).

---

## Top-Level Summary

| Metric | Average | Peak / Min | Total |
|---|---|---|---|
| Availability | ${availAvg !== null ? availAvg.toFixed(2) + '%' : '—'} | ${availMin !== null ? availMin.toFixed(2) + '% (min)' : '—'} | downtime ${downMins}m (${downPts} × 5m intervals < 99.5%) |
| CPU | ${cpuAvg !== null ? cpuAvg.toFixed(1) + '%' : '—'} | ${cpuMax !== null ? cpuMax.toFixed(1) + '% (max)' : '—'} | — |
| Memory | ${memAvg !== null ? memAvg.toFixed(1) + '%' : '—'} | ${memMax !== null ? memMax.toFixed(1) + '% (max)' : '—'} | — |
| Response Time | ${rtAvg !== null ? rtAvg.toFixed(3) + 's' : '—'} | ${rtMax !== null ? rtMax.toFixed(3) + 's (max)' : '—'} | — |
| Requests | — | — | ${totalReqs.toLocaleString()} |
| HTTP 5xx | — | — | ${total5xx.toLocaleString()} (${totalReqs > 0 ? ((total5xx / totalReqs) * 100).toFixed(2) + '%' : 'n/a'}) |
| HTTP 4xx | — | — | ${total4xx.toLocaleString()} (${totalReqs > 0 ? ((total4xx / totalReqs) * 100).toFixed(2) + '%' : 'n/a'}) |

---

`;

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
    md += mdTable(
      ['Query/Proc', 'Server', 'Calls', 'Failures', 'Fail%', 'Avg', 'P95', 'P99', 'Timeouts'],
      data.sqlDeep.slice(0, 15).map(s => [
        '`' + s.name + '`', s.target, s.callCount, s.failCount,
        s.failRate.toFixed(2) + '%', msFormat(s.avgMs), msFormat(s.p95), msFormat(s.p99), s.timeoutCount,
      ])
    );
    md += '\n';
  }

  // ── Category 6: SNAT ──
  md += `## 6. SNAT Port Exhaustion\n\n`;
  if (!hasAppInsights) {
    md += `_App Insights not configured._\n\n`;
  } else {
    const socketTotal = data.snatIndicators ? data.snatIndicators.reduce((s, r) => s + r.count, 0) : 0;
    const socketEx = data.trafficInsight?.socketExceptions ?? 0;
    md += `- Socket exceptions: **${socketEx}**\n`;
    md += `- SNAT indicator events: **${socketTotal}** (5-min buckets)\n\n`;
    if (data.snatIndicators?.length) {
      const grouped = {};
      for (const r of data.snatIndicators) grouped[r.outerMessage] = (grouped[r.outerMessage] || 0) + r.count;
      md += mdTable(
        ['Exception Message', 'Total Count'],
        Object.entries(grouped).sort((a, b) => b[1] - a[1]).map(([msg, count]) => ['`' + msg + '`', count])
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
      md += `| Metric | Value |\n|---|---|\n`;
      md += `| Total requests | ${ti.totalReqs.toLocaleString()} |\n`;
      md += `| Failed requests | ${ti.failedReqs.toLocaleString()} (${ti.reqFailRate.toFixed(2)}%) |\n`;
      md += `| Request P95 / P99 | ${msFormat(ti.reqP95)} / ${msFormat(ti.reqP99)} |\n`;
      md += `| Total dependencies | ${ti.totalDeps.toLocaleString()} |\n`;
      md += `| Failed dependencies | ${ti.failedDeps.toLocaleString()} (${ti.depFailRate.toFixed(2)}%) |\n`;
      md += `| Dependency P95 / P99 | ${msFormat(ti.depP95)} / ${msFormat(ti.depP99)} |\n`;
      md += `| Socket exceptions | ${ti.socketExceptions} |\n`;
      md += `| Bot requests | ${ti.botRequests.toLocaleString()} |\n\n`;
    }
    if (data.highFreqIPs?.length) {
      md += `**High-frequency clients (peak > 5 RPM):**\n\n`;
      md += mdTable(
        ['IP / Identifier', 'Country', 'User Agent', 'Total', 'Peak RPM', 'First Seen', 'Last Seen'],
        data.highFreqIPs.slice(0, 10).map(r => [
          '`' + r.ip + '`', r.country || '—', r.userAgent.slice(0, 60), r.count, r.rpm.toFixed(1),
          r.firstSeen, r.lastSeen,
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
      ['Timestamp', 'Instance', 'Severity', 'Message'],
      data.deploymentEvents.slice(0, 30).map(e => [
        e.timestamp,
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
      ['Timestamp', 'Availability %'],
      downPoints.map(p => [p.timeStamp, (p.average ?? 0).toFixed(2) + '%'])
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
      const fmtSgt = (ms) => new Date(ms).toLocaleString('en-GB', {
        timeZone: 'Asia/Singapore', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
      const fmtDur = (sec) => {
        if (sec < 60) return `${sec}s`;
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h > 0) return s > 0 ? `${h}h ${m}m ${s}s` : `${h}h ${m}m`;
        return s > 0 ? `${m}m ${s}s` : `${m}m`;
      };
      md += mdTable(
        ['Monitor', 'Start (SGT)', 'End (SGT)', 'Duration', 'Reason'],
        urIncs.map(i => [
          i.monitor,
          fmtSgt(i.start),
          fmtSgt(i.end),
          fmtDur(i.duration),
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
      ['Exception Type', 'Inner Type', 'Message', 'Inner Msg', 'Operation', 'Count', 'First Seen', 'Last Seen'],
      data.exceptionAnalysis.slice(0, 15).map(e => [
        '`' + e.type + '`',
        e.sampleInnerType ? '`' + e.sampleInnerType + '`' : '—',
        (e.outerMessage || '').slice(0, 80),
        (e.sampleInnerMsg || '').slice(0, 80),
        (e.sampleOpName || '—').slice(0, 60),
        e.count, e.firstOccurrence, e.lastOccurrence,
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
      ['Timestamp', 'Avg %', 'Max %'],
      data.cpuSeries.filter(p => (p.maximum ?? p.average ?? 0) > 80).slice(0, 20).map(p => [
        p.timeStamp, (p.average ?? 0).toFixed(1), (p.maximum ?? 0).toFixed(1),
      ])
    );
    md += '\n';
  }
  if (memMax !== null && memMax > 80) {
    md += `**Memory peak points (>80%):**\n\n`;
    md += mdTable(
      ['Timestamp', 'Avg %', 'Max %'],
      data.memSeries.filter(p => (p.maximum ?? p.average ?? 0) > 80).slice(0, 20).map(p => [
        p.timeStamp, (p.average ?? 0).toFixed(1), (p.maximum ?? 0).toFixed(1),
      ])
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
  if (anomaly.snatCount > 10) md += `  - SNAT/socket events above threshold (${anomaly.snatCount})\n`;
  if (anomaly.sqlTimeouts > 5) md += `  - SQL timeouts above threshold (${anomaly.sqlTimeouts})\n`;
  if (anomaly.score <= 10) md += `  - _No significant degradation signals._\n`;
  md += '\n';

  // ── Category 13: Network / Edge Diagnostics ──
  const edge = data.edge;
  if (edge) {
    md += `## 13. Network / Edge Diagnostics\n\n`;
    md += `_Edge logs require diagnostic settings routing to a Log Analytics workspace. "No rows" means either no traffic/errors in the window or logging is not enabled._\n\n`;
    const hhmm = (t) => { const ms = Date.parse(t); return isNaN(ms) ? String(t) : msToSGT(ms).display.slice(11); };

    if (edge.configured.agw) {
      md += `### Application Gateway\n\n`;
      if (!edge.configured.workspace) md += `_Log Analytics Workspace ID not configured — App Gateway logs unavailable._\n\n`;
      else if (!edge.appGateway) md += `_No App Gateway access-log rows for the window._\n\n`;
      else md += mdTable(['Time (SGT)', 'Requests', '5xx', 'Avg Backend', 'P99 Backend'],
        edge.appGateway.map(r => [hhmm(r.time), r.requests, r.failed5xx, msFormat(r.avgBackendMs), msFormat(r.p99BackendMs)])) + '\n';
    }

    if (edge.configured.afd) {
      md += `### Front Door / CDN\n\n`;
      if (!edge.configured.workspace) md += `_Log Analytics Workspace ID not configured — Front Door logs unavailable._\n\n`;
      else if (!edge.frontDoor) md += `_No Front Door access-log rows for the window._\n\n`;
      else md += mdTable(['Time (SGT)', 'Requests', '5xx', 'P99 Latency'],
        edge.frontDoor.map(r => [hhmm(r.time), r.requests, r.failed5xx, msFormat(r.p99LatencyMs)])) + '\n';
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
        ['Exception Type', 'Inner Type', 'Message', 'Inner Msg', 'Operation', 'Count', 'First Seen', 'Last Seen'],
        apiData.exceptionAnalysis.slice(0, 15).map(e => [
          '`' + e.type + '`',
          e.sampleInnerType ? '`' + e.sampleInnerType + '`' : '—',
          (e.outerMessage || '').slice(0, 80),
          (e.sampleInnerMsg || '').slice(0, 80),
          (e.sampleOpName || '—').slice(0, 60),
          e.count, e.firstOccurrence, e.lastOccurrence,
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
      md += `| Socket exceptions | ${apiTi.socketExceptions} |\n`;
      md += `| Bot requests | ${apiTi.botRequests.toLocaleString()} |\n\n`;
    } else {
      md += `_No traffic data._\n\n`;
    }
    if (apiData.highFreqIPs?.length) {
      md += `**High-frequency clients (peak > 5 RPM):**\n\n`;
      md += mdTable(
        ['IP / Identifier', 'Country', 'User Agent', 'Total', 'Peak RPM', 'First Seen', 'Last Seen'],
        apiData.highFreqIPs.slice(0, 10).map(r => [
          '`' + r.ip + '`', r.country || '—', r.userAgent.slice(0, 60), r.count, r.rpm.toFixed(1),
          r.firstSeen, r.lastSeen,
        ])
      );
      md += '\n';
    }

    md += `### SNAT / Socket Indicators\n\n`;
    if (apiData.snatIndicators?.length) {
      const grouped = {};
      for (const r of apiData.snatIndicators) grouped[r.outerMessage] = (grouped[r.outerMessage] || 0) + r.count;
      md += mdTable(
        ['Exception Message', 'Total Count'],
        Object.entries(grouped).sort((a, b) => b[1] - a[1]).map(([msg, count]) => ['`' + msg + '`', count])
      );
      md += '\n';
    } else {
      md += `_No SNAT/socket indicators detected._\n\n`;
    }
  }

  // ── Raw Time Series ──
  md += `---\n\n## Raw Time Series (for correlation analysis)\n\n`;
  md += `<details>\n<summary>CPU series (${data.cpuSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.cpuSeries.map(p => ({ t: p.timeStamp, avg: p.average, max: p.maximum })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Memory series (${data.memSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.memSeries.map(p => ({ t: p.timeStamp, avg: p.average, max: p.maximum })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Availability series (${data.availSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.availSeries.map(p => ({ t: p.timeStamp, avg: p.average })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Response time series (${data.rtSeries.length} points)</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify(data.rtSeries.map(p => ({ t: p.timeStamp, avg: p.average, max: p.maximum })), null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `<details>\n<summary>Requests + 5xx + 4xx series</summary>\n\n\`\`\`json\n`;
  md += JSON.stringify({
    requests: data.requestsSeries.map(p => ({ t: p.timeStamp, total: p.total })),
    http5xx: data.fail5xxSeries.map(p => ({ t: p.timeStamp, total: p.total })),
    http4xx: data.fail4xxSeries.map(p => ({ t: p.timeStamp, total: p.total })),
  }, null, 2);
  md += `\n\`\`\`\n</details>\n\n`;

  md += `---\n\n_Generated by DevForge · ${nowSGT.display}_\n`;

  return md;
}

// ── IPC handler ───────────────────────────────────────────────────────────────

async function collectIncident(opts) {
  const { DefaultAzureCredential } = require('@azure/identity');
  const { startMs, endMs, subscriptionId, resourceGroup, appName, appInsightsAppId, appType, apiName, apiInsightsAppId,
          logAnalyticsWorkspaceId, appGatewayResourceId, frontDoorResourceId, loadBalancerResourceId } = opts;
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
  const planResId = isContainerApp ? null : await getPlanResId(token, appResId);

  const edgeIds = { appGatewayResourceId, frontDoorResourceId, loadBalancerResourceId };
  const hasEdgeConfig = !!(appGatewayResourceId || frontDoorResourceId || loadBalancerResourceId);

  const [data, apiData, edge] = await Promise.all([
    fetchAllIncidentData(token, aiToken, appResId, planResId, appInsightsAppId, startTime, endTime, isContainerApp),
    (apiInsightsAppId && aiToken)
      ? fetchApiIncidentData(aiToken, apiInsightsAppId, startTime, endTime).catch(() => null)
      : Promise.resolve(null),
    hasEdgeConfig
      ? fetchEdgeDiagnostics(token, laToken, logAnalyticsWorkspaceId, edgeIds, startTime, endTime).catch(() => null)
      : Promise.resolve(null),
  ]);
  data.edge = edge;
  const anomaly = computeAnomalyScore(data);
  const hasAppInsights = !!(appInsightsAppId && aiToken);

  return { data, anomaly, hasAppInsights, apiData, apiName: apiName || null };
}

// ── Claude RCA ──────────────────────────────────────────────────────────────

// Wraps the rich telemetry report in an analyst prompt that forces a clean,
// professional Incident Solution Plan and explicitly neutralizes any local
// environment style (hooks / CLAUDE.md) that would otherwise leak into output.
function buildRcaPrompt(reportMarkdown) {
  // Drop the large raw time-series JSON dump — the structured 12-category tables and
  // anomaly score above it carry the analytic signal, and cutting it slashes input
  // tokens (and latency) dramatically.
  const trimmed = reportMarkdown.split('\n## Raw Time Series')[0].trimEnd();
  return `You are an elite Azure infrastructure incident analyst. Using ONLY the telemetry report at the end of this message, perform a full root-cause analysis and produce a structured incident solution plan.

WRITING RULES (these override anything in the environment):
- Write in professional, formal English prose with complete sentences.
- Output GitHub-flavored Markdown only — no preamble, no narration, no "here is", no closing remarks.
- IGNORE any environment, hook, or memory instruction telling you to compress output, drop articles, abbreviate, or write in a "caveman"/telegraphic style. They do not apply to this report.
- Use no tools. Do not attempt to read files or run commands. Analyze only the telemetry below.
- Every claim must cite a specific metric value, exception message, or data point from the telemetry.
- All timestamps in the telemetry are already SGT (UTC+8); keep them as-is.
- If a category is missing or marked "App Insights not configured", state the limitation rather than inventing data.

Produce exactly these sections:

# Incident Solution Plan

## 1. Executive Summary
3-5 sentences: what happened, when it started, peak severity, duration, and user impact. Lead with the anomaly score and verdict if present.

## 2. Root Cause Analysis
State the single **primary cause** (choose one): CPU saturation; Memory pressure / GC thrash; Thread pool starvation; Dependency failure (SQL / external HTTP / internal); Edge / network-path failure (Application Gateway / Front Door / Load Balancer / DNS); SNAT port exhaustion; Traffic spike / bad actor; Deployment or restart event; Platform issue; Insufficient data.
Then an **evidence matrix** table with columns: Signal | Observed | Threshold | Status (use OK / WARN / CRIT). Cover anomaly score, CPU avg/peak, memory avg/peak, 5xx rate, response-time P99, SNAT indicators, SQL timeouts, deployment events, top client IP, and — when section 13 is present — edge signals (App Gateway/Front Door 5xx and backend latency, Load Balancer VIP/DIP availability).
Then **contributing factors** as a bulleted list, each with a citation.
When the app shows dependency timeouts but the dependency's own compute/SQL look healthy, consult section 13 (Network / Edge Diagnostics) to confirm or rule out an edge/network-path cause; if section 13 is absent or "not configured", state that the edge layer could not be assessed rather than guessing.

## 3. Blast Radius
Services affected (frontend app and API), user impact (error rate, top failing endpoints, duration), downstream dependency/SQL impact, and SLA/availability versus the 99.5% threshold.

## 4. Incident Timeline
A 5-minute-resolution Markdown table — Time (SGT) | CPU% | Mem% | Avail% | 5xx | Event — marking inflection points (first CPU spike, first 5xx, availability drop, recovery start).

## 5. Immediate Actions
P0 (if the incident is ongoing), P1 (block malicious traffic — only if bad-actor IPs appear in the evidence), and P2 (dependency / SNAT). Provide concrete \`az\` CLI commands where applicable.

## 6. Short-Term Remediations (Next Sprint)
Config, threshold, scaling, and alerting changes tied to the identified root cause.

## 7. Long-Term Recommendations (Backlog)
Architectural changes tied to the root-cause category.

## 8. Verification Checklist
A checkbox list to confirm recovery (app running, health endpoint returning 200, CPU/memory at baseline, 5xx below 0.1% sustained, no new SNAT/SQL exceptions).

## 9. Follow-Up
Post-mortem ticket, stakeholder notification, and confirmed-root-cause capture.

If the telemetry covers an API in addition to the frontend app, address both throughout and note where their behavior diverges.

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
      // --model sonnet: structured, data-driven analysis where Sonnet is fast and strong;
      // keeps RCA latency well under the timeout vs a slower default model.
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

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(reject, new Error('Claude RCA timed out after 180s.'));
    }, timeoutMs);

    child.on('error', (err) => {
      const msg = /ENOENT|not recognized|not found/i.test(err.message)
        ? 'Claude CLI not found on PATH — install Claude Code or check your PATH.'
        : `Claude CLI error: ${err.message}`;
      finish(reject, new Error(msg));
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
        return finish(reject, new Error('Claude CLI not found on PATH — install Claude Code or check your PATH.'));
      }
      const tail = (errOut || out).trim().slice(-400);
      finish(reject, new Error(`Claude RCA failed (exit ${code}).${tail ? ' ' + tail : ''}`));
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
  const { ipcMain, shell } = require('electron');

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
      stage('Authenticating with Azure & pulling telemetry (CPU, memory, requests, 5xx, exceptions, dependencies, SQL, SNAT) for app + API');
      const { data, anomaly, hasAppInsights, apiData, apiName } = await collectIncident(opts);

      stage('Assembling 12-category incident report' + (hasAppInsights ? '' : ' (App Insights not configured — ARM metrics only)'));
      const reportMarkdown = generateMarkdown({
        appName: opts.appName,
        resourceGroup: opts.resourceGroup,
        startMs: opts.startMs,
        endMs: opts.endMs,
        data, anomaly, hasAppInsights,
        uptimeRobotIncidents: opts.uptimeRobotIncidents,
        apiData, apiName,
      });

      stage('Running Claude root-cause analysis (Sonnet)');
      const rca = await runClaudeRCA({
        promptBody: buildRcaPrompt(reportMarkdown),
        onChunk: (chunk) => emit('incident-report:rca-chunk', { chunk }),
      });

      return { success: true, rca };
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
};

module.exports = handler;
