'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const REPORTS_DIR = path.join(os.homedir(), '.claude', 'agents', 'medu-downtime-reports');

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

async function fetchMetric(token, resId, metricName, startTime, endTime, interval, aggregations) {
  const aggStr = aggregations.join(',').toLowerCase();
  const ts = `${startTime.toISOString()}/${endTime.toISOString()}`;
  const url =
    `https://management.azure.com${resId}/providers/microsoft.insights/metrics` +
    `?api-version=2023-10-01&metricnames=${encodeURIComponent(metricName)}` +
    `&timespan=${encodeURIComponent(ts)}&interval=${interval}&aggregation=${aggStr}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.value?.[0]?.timeseries?.[0]?.data || [];
}

async function getPlanResId(token, resId) {
  const res = await fetch(`https://management.azure.com${resId}?api-version=2022-03-01`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.properties?.serverFarmId || null;
}

function extractDowntimeEvents(series, threshold = 99.5) {
  const events = [];
  let start = null;
  let minAvail = 100;
  for (const p of series) {
    const avail = p.average ?? 100;
    if (avail < threshold) {
      if (start === null) { start = new Date(p.timeStamp).getTime(); minAvail = avail; }
      else if (avail < minAvail) minAvail = avail;
    } else if (start !== null) {
      events.push({ start, end: new Date(p.timeStamp).getTime(), minAvail });
      start = null; minAvail = 100;
    }
  }
  if (start !== null) {
    events.push({ start, end: new Date(series[series.length - 1].timeStamp).getTime(), minAvail });
  }
  return events;
}

function statusIcon(val, warnThresh, critThresh, lowerIsBetter = false) {
  if (lowerIsBetter) return val <= critThresh ? '🔴' : val <= warnThresh ? '⚠️' : '✅';
  return val >= critThresh ? '🔴' : val >= warnThresh ? '⚠️' : '✅';
}

function buildMetricsSummary({ appName, startMs, endMs, availSeries, cpuSeries, memSeries, responseTimeSeries, events }) {
  const startSGT = msToSGT(startMs);
  const endSGT = msToSGT(endMs);

  const totalPoints = availSeries.length;
  const downPoints = availSeries.filter(p => (p.average ?? 100) < 99.5).length;
  const availPct = totalPoints > 0 ? Math.round((1 - downPoints / totalPoints) * 1000) / 10 : 100;

  const cpuAvg = cpuSeries.length > 0 ? cpuSeries.reduce((s, p) => s + (p.average ?? 0), 0) / cpuSeries.length : null;
  const cpuMax = cpuSeries.length > 0 ? Math.max(...cpuSeries.map(p => p.maximum ?? p.average ?? 0)) : null;

  const toMB = v => v / 1048576;
  const memAvgMB = memSeries.length > 0 ? toMB(memSeries.reduce((s, p) => s + (p.average ?? 0), 0) / memSeries.length) : null;
  const memMinMB = memSeries.length > 0 ? toMB(Math.min(...memSeries.map(p => p.minimum ?? p.average ?? 0))) : null;

  const rtAvg = responseTimeSeries.length > 0 ? responseTimeSeries.reduce((s, p) => s + (p.average ?? 0), 0) / responseTimeSeries.length : null;
  const rtMax = responseTimeSeries.length > 0 ? Math.max(...responseTimeSeries.map(p => p.maximum ?? p.average ?? 0)) : null;

  const incidentSummary = events.map((ev, i) => ({
    index: i + 1,
    startSGT: msToSGT(ev.start).display,
    endSGT: msToSGT(ev.end).display,
    durationMins: Math.round((ev.end - ev.start) / 60000),
    minAvailability: (ev.minAvail ?? 0).toFixed(1),
  }));

  return {
    appName,
    period: { start: startSGT.display, end: endSGT.display },
    availability: { pct: availPct, downtimeMins: downPoints * 5, incidents: events.length },
    cpu: cpuAvg !== null ? { avgPct: cpuAvg.toFixed(1), maxPct: cpuMax.toFixed(1) } : null,
    memory: memAvgMB !== null ? { avgAvailMB: memAvgMB.toFixed(0), minAvailMB: memMinMB.toFixed(0) } : null,
    responseTime: rtAvg !== null ? { avgSec: rtAvg.toFixed(3), maxSec: rtMax.toFixed(3) } : null,
    incidents: incidentSummary,
    availabilityTimeline: availSeries.slice(0, 100).map(p => ({
      t: msToSGT(new Date(p.timeStamp).getTime()).display,
      avail: (p.average ?? 100).toFixed(1),
    })),
  };
}

async function callClaude(anthropicApiKey, summary) {
  const systemPrompt = `You are an Azure App Service reliability analyst. Analyze the metrics data and return ONLY valid JSON — no markdown fences, no explanation.

JSON schema:
{
  "executiveSummary": "2-4 sentences. Overall health, incident count, total downtime, SLA impact. Specific numbers.",
  "incidents": [
    {
      "index": 1,
      "rootCauseHints": "1-3 sentences. What the metrics suggest caused this incident — resource saturation, spike patterns, likely trigger. Use exact metric values."
    }
  ],
  "recommendations": [
    "Specific actionable recommendation 1",
    "Specific actionable recommendation 2"
  ]
}

Rules:
- incidents array must match incident count in the data (same order)
- 3-5 recommendations, prioritized by impact, no generic advice
- Be concise and technical. No hedging.`;

  const userMessage = `Analyze this Azure App Service incident data:\n\n${JSON.stringify(summary, null, 2)}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  try {
    return JSON.parse(text);
  } catch {
    // Strip markdown fences if Claude wrapped despite instructions
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1]);
    throw new Error('Claude returned invalid JSON: ' + text.slice(0, 200));
  }
}

function generateMarkdown({ startMs, endMs, appName, resourceGroup, availSeries, cpuSeries, memSeries, responseTimeSeries, aiData }) {
  const nowSGT = msToSGT(Date.now());
  const startSGT = msToSGT(startMs);
  const endSGT = msToSGT(endMs);

  const events = extractDowntimeEvents(availSeries);
  const totalPoints = availSeries.length;
  const downPoints = availSeries.filter(p => (p.average ?? 100) < 99.5).length;
  const availPct = totalPoints > 0 ? Math.round((1 - downPoints / totalPoints) * 1000) / 10 : 100;
  const downtimeMins = downPoints * 5;
  const slaOk = availPct >= 99.5;

  const fmtFull = (ms) => msToSGT(ms).display;

  let md = `# Azure App Service Downtime Report
**Report Generated**: ${nowSGT.display}
**Analysis Period**: ${startSGT.display} to ${endSGT.display} (UTC+8)
**App Services Analyzed**: ${appName} (${resourceGroup})
${aiData ? '**Analysis**: AI-assisted (Claude)\n' : ''}
---

`;

  // Executive Summary
  md += `## AI Analysis\n\n### Executive Summary\n\n`;
  if (aiData?.executiveSummary) {
    md += aiData.executiveSummary + '\n\n';
  } else {
    if (events.length === 0) {
      md += `${appName} maintained availability during the analysis period with no detected downtime events. Overall availability was **${availPct}%**, ${slaOk ? 'meeting' : 'breaching'} the 99.5% SLA threshold.\n\n`;
    } else {
      const totalDown = events.reduce((s, e) => s + Math.round((e.end - e.start) / 60000), 0);
      md += `${appName} experienced **${events.length} incident${events.length > 1 ? 's' : ''}** during the analysis period with a combined downtime of **${totalDown} minutes**. Overall availability was **${availPct}%**, ${slaOk ? 'meeting' : 'breaching'} the 99.5% SLA threshold.\n\n`;
    }
  }

  md += `## Overall Availability
| App Service | Availability % | SLA Status | Total Downtime |
|-------------|----------------|------------|----------------|
| ${appName} | ${availPct}% | ${slaOk ? '✅' : '❌'} | ${downtimeMins}m |

`;

  if (events.length > 0) {
    md += `## Downtime Events\n`;
    events.forEach((ev, i) => {
      const durMins = Math.round((ev.end - ev.start) / 60000);
      const severity = (ev.minAvail ?? 100) === 0 ? 'Complete Outage' : ev.minAvail < 50 ? 'Partial Outage' : 'Degraded Performance';
      const perIncidentHints = aiData?.incidents?.[i]?.rootCauseHints;
      const rootCauseHints = perIncidentHints
        ? perIncidentHints
        : 'Review Http5xx spikes, deployment events, and dependency failures in this window.';
      md += `
### Incident ${i + 1}: ${appName}
- **Start Time**: ${fmtFull(ev.start)}
- **End Time**: ${fmtFull(ev.end)}
- **Duration**: ${durMins} minutes
- **Severity**: ${severity}
- **Min Availability**: ${(ev.minAvail ?? 0).toFixed(1)}%
- **Reported By**: jason.rosalinda@mims.com
- **Status**: Resolved
- **Root Cause Hints**: ${rootCauseHints}
- **Resolution/Action Taken**: Under investigation.

`;
    });
  }

  if (responseTimeSeries.length > 0) {
    const avgRT = responseTimeSeries.reduce((s, p) => s + (p.average ?? 0), 0) / responseTimeSeries.length;
    const maxRT = Math.max(...responseTimeSeries.map(p => p.maximum ?? p.average ?? 0));
    md += `## Performance Observations
- Average response time: **${avgRT.toFixed(3)}s**
- Peak response time: **${maxRT.toFixed(3)}s**
${avgRT > 1 ? '- ⚠️ Average response time exceeded 1s — indicative of degraded performance.' : '- ✅ Response times within acceptable range.'}

`;
  }

  md += `## Recommendations\n`;
  if (aiData?.recommendations?.length) {
    aiData.recommendations.forEach(r => { md += `- ${r}\n`; });
  } else {
    md += `- Review Application Insights for Http5xx traces and dependency failures during incident windows.
- Check for deployment events or configuration changes immediately before incidents.
- Evaluate auto-scaling thresholds if CPU/memory saturation was observed.
- Verify health check endpoint accuracy — false negatives inflate downtime metrics.
- Consider adding alerting on HealthCheckStatus < 99.5% for proactive response.
`;
  }
  md += '\n';

  md += `---\n*Report generated by DevForge · ${nowSGT.display}*\n`;

  return md;
}

const handler = (_mainWindow) => {
  const { ipcMain, shell } = require('electron');
  const { DefaultAzureCredential } = require('@azure/identity');

  ipcMain.handle('downtime-report:generate', async (_event, { startMs, endMs, subscriptionId, resourceGroup, appName, anthropicApiKey }) => {
    try {
      const cred = new DefaultAzureCredential();
      const tokenResp = await cred.getToken('https://management.azure.com/.default');
      const token = tokenResp.token;

      const startTime = new Date(startMs);
      const endTime = new Date(endMs);

      const appResId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Web/sites/${appName}`;
      const planResId = await getPlanResId(token, appResId);
      const cpuResId = planResId || appResId;

      const [availSeries, cpuSeries, memSeries, responseTimeSeries] = await Promise.all([
        fetchMetric(token, appResId, 'HealthCheckStatus', startTime, endTime, 'PT5M', ['Average']),
        fetchMetric(token, cpuResId, 'CpuPercentage', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
        fetchMetric(token, cpuResId, 'MemoryPercentage', startTime, endTime, 'PT5M', ['Average', 'Minimum']),
        fetchMetric(token, appResId, 'HttpResponseTime', startTime, endTime, 'PT5M', ['Average', 'Maximum']),
      ]);

      const events = extractDowntimeEvents(availSeries);

      let aiData = null;
      if (anthropicApiKey) {
        const summary = buildMetricsSummary({ appName, startMs, endMs, availSeries, cpuSeries, memSeries, responseTimeSeries, events });
        aiData = await callClaude(anthropicApiKey, summary);
      }

      const md = generateMarkdown({
        startMs, endMs, appName, resourceGroup,
        availSeries, cpuSeries, memSeries, responseTimeSeries,
        aiData,
      });

      if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

      const startSGT = msToSGT(startMs);
      const endSGT = msToSGT(endMs);
      const filename = `medu-downtime-report-${startSGT.file}-${endSGT.file}.md`;
      const filepath = path.join(REPORTS_DIR, filename);
      fs.writeFileSync(filepath, md, 'utf8');

      shell.openPath(filepath);

      return { success: true, path: filepath, aiUsed: !!anthropicApiKey };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
};

module.exports = handler;
