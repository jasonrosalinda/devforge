'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

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
  const { startMs, endMs, subscriptionId, resourceGroup, appName, appInsightsAppId, appType, apiName, apiInsightsAppId } = opts;
  const isContainerApp = appType === 'containerapp';
  const cred = new DefaultAzureCredential();

  const needsAiToken = !!(appInsightsAppId || apiInsightsAppId);
  const [tokenResp, aiTokenResp] = await Promise.all([
    cred.getToken('https://management.azure.com/.default'),
    needsAiToken ? cred.getToken('https://api.applicationinsights.io/.default').catch(() => null) : Promise.resolve(null),
  ]);
  const token = tokenResp.token;
  const aiToken = aiTokenResp?.token ?? null;

  const startTime = new Date(startMs);
  const endTime = new Date(endMs);

  const appResId = isContainerApp
    ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${appName}`
    : `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${appName}`;
  const planResId = isContainerApp ? null : await getPlanResId(token, appResId);

  const [data, apiData] = await Promise.all([
    fetchAllIncidentData(token, aiToken, appResId, planResId, appInsightsAppId, startTime, endTime, isContainerApp),
    (apiInsightsAppId && aiToken)
      ? fetchApiIncidentData(aiToken, apiInsightsAppId, startTime, endTime).catch(() => null)
      : Promise.resolve(null),
  ]);
  const anomaly = computeAnomalyScore(data);
  const hasAppInsights = !!(appInsightsAppId && aiToken);

  return { data, anomaly, hasAppInsights, apiData, apiName: apiName || null };
}

const handler = (_mainWindow) => {
  const { ipcMain, shell } = require('electron');

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
};

module.exports = handler;
