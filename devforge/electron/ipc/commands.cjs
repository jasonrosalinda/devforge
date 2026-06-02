'use strict';

const { ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');

// ── Registry table ────────────────────────────────────────────────────────────

function buildRegistryTable(subscriptionId, apps) {
  const header = [
    '| RG | App | API | App Insights ID | API Insights ID | Type | Sub ID |',
    '|---|---|---|---|---|---|---|',
  ];
  const rows = apps.map(a =>
    '| `' + (a.resourceGroup || '') + '` | `' + (a.name || '') + '` | `' +
    (a.apiName || '—') + '` | `' + (a.appInsightsAppId || '—') + '` | `' +
    (a.apiInsightsAppId || '—') + '` | ' + (a.type || 'appservice') + ' | `' +
    (subscriptionId || '') + '` |'
  );
  return header.concat(rows).join('\n');
}

// ── ARM fetch section ─────────────────────────────────────────────────────────

function buildArmFetchSection(subscriptionId, apps) {
  const sub = subscriptionId || '';
  const lines = [
    'For each app in the registry above, fire curl calls in parallel. General pattern:',
    '',
    '```bash',
    'QS="?timespan=${TIMESPAN}&interval=PT5M&aggregation=Average,Maximum&api-version=2018-01-01"',
    '',
  ];

  apps.forEach((a, i) => {
    const rg = a.resourceGroup || '';
    const name = a.name || '';
    const tag = 'inc_' + name.replace(/[^a-z0-9]/gi, '_');

    if (a.type === 'containerapp') {
      lines.push(
        '# Container App — CPU + Memory (' + name + ')',
        'curl -sH "Authorization: Bearer $TOKEN" \\',
        '  "${BASE}/resourceGroups/' + rg + '/providers/Microsoft.App/containerApps/' + name + '/providers/microsoft.insights/metrics${QS}&metricnames=CpuUsageNanoCores,MemoryWorkingSetBytes" \\',
        '  > /tmp/' + tag + '_metrics.json &',
        '',
      );
    } else {
      // Assume ASP name follows pattern: uppercase(name) + "-ASP" — best guess if unknown
      const aspName = a.aspName || (name.toUpperCase() + '-ASP');
      const aspRg = a.aspResourceGroup || rg;
      lines.push(
        '# App Service CPU — ' + name + ' (from ASP)',
        'curl -sH "Authorization: Bearer $TOKEN" \\',
        '  "${BASE}/resourceGroups/' + aspRg + '/providers/Microsoft.Web/serverfarms/' + aspName + '/providers/microsoft.insights/metrics${QS}&metricnames=CpuPercentage" \\',
        '  > /tmp/' + tag + '_cpu.json &',
        '',
        '# App Service metrics — ' + name,
        'curl -sH "Authorization: Bearer $TOKEN" \\',
        '  "${BASE}/resourceGroups/' + rg + '/providers/Microsoft.Web/sites/' + name + '/providers/microsoft.insights/metrics${QS}&metricnames=MemoryWorkingSet,HttpResponseTime,HealthCheckStatus,Requests,Http5xx,Http4xx" \\',
        '  > /tmp/' + tag + '_app.json &',
        '',
      );
      if (a.apiName) {
        const apiTag = 'inc_' + a.apiName.replace(/[^a-z0-9]/gi, '_');
        lines.push(
          '# App Service metrics — ' + a.apiName + ' (API)',
          'curl -sH "Authorization: Bearer $TOKEN" \\',
          '  "${BASE}/resourceGroups/' + rg + '/providers/Microsoft.Web/sites/' + a.apiName + '/providers/microsoft.insights/metrics${QS}&metricnames=MemoryWorkingSet,HttpResponseTime,Requests,Http5xx,Http4xx" \\',
          '  > /tmp/' + apiTag + '_app.json &',
          '',
        );
      }
    }
  });

  lines.push('wait', '```');
  return lines.join('\n');
}

// ── App Insights section ──────────────────────────────────────────────────────

function buildAppInsightsSection(apps) {
  const lines = [
    '# App Insights IDs are embedded in the registry above — use the ID for the matched RG.',
    '# Look up the matched app row, extract App Insights ID, then:',
    '',
    '# Example: if matched app has appInsightsAppId = "abc-123-..."',
    'AI_APPID="<appInsightsAppId from registry for the matched RG>"',
    'AI_ENDPOINT="https://api.applicationinsights.io/v1/apps/${AI_APPID}/query"',
  ];

  // Also list the mapping explicitly for quick reference
  const hasIds = apps.some(a => a.appInsightsAppId || a.apiInsightsAppId);
  if (hasIds) {
    lines.push('', '# Quick reference:');
    apps.forEach(a => {
      if (a.appInsightsAppId) lines.push('# ' + a.resourceGroup + ' / ' + a.name + ' → ' + a.appInsightsAppId);
      if (a.apiInsightsAppId && a.apiName) lines.push('# ' + a.resourceGroup + ' / ' + a.apiName + ' → ' + a.apiInsightsAppId);
    });
  }

  return lines.join('\n');
}

// ── Full command markdown ─────────────────────────────────────────────────────

function generateIncidentCommand(subscriptionId, apps) {
  const sub = subscriptionId || '';
  const registryTable = buildRegistryTable(subscriptionId, apps);
  const armFetchSection = buildArmFetchSection(subscriptionId, apps);
  const appInsightsSection = buildAppInsightsSection(apps);

  return `You are an elite Azure infrastructure incident analyst. When invoked, autonomously perform a full RCA and produce a structured solution plan. No narration, no confirmations, no step-by-step output. Silence until the final plan is ready.

## Step 1: Parse Arguments

Arguments: \`$ARGUMENTS\`

Extract a **resource group** and optionally a **date** from the argument string. Accepted formats:

| Input | RG | Date interpreted as |
|---|---|---|
| \`prdmedu-rg-060126\` | \`prdmedu-rg\` | DDMMYY → 2026-06-01 |
| \`prdmedu-rg-20260601\` | \`prdmedu-rg\` | YYYYMMDD → 2026-06-01 |
| \`PRDMSP-RG-010626\` | \`PRDMSP-RG\` | DDMMYY → 2026-06-01 |
| \`prdmedu-rg 2026-06-01\` | \`prdmedu-rg\` | ISO date |
| \`prdmedu-rg\` | \`prdmedu-rg\` | Today SGT |

**Date parsing rule:** Check the last hyphen-delimited segment. If it is exactly 6 digits → DDMMYY (day=first 2, month=next 2, year=20+last 2). If 8 digits → YYYYMMDD. ISO (YYYY-MM-DD) used directly. No date found → today's date in SGT (UTC+8).

**Analysis window:** Full day — 00:00 SGT to 23:59 SGT on the parsed date.

**SGT → UTC conversion:** subtract 8 hours. Example: 2026-06-01 00:00 SGT → 2026-05-31T16:00:00Z.

**Known app registry** (auto-generated from devForge settings):

${registryTable}

If RG does not match any registry entry, use raw RG and discover app names via: \`az webapp list --resource-group {rg} --query "[].name" -o tsv\`

## Step 2: Search for Existing Incident Report

Use the Glob tool to search this directory:
\`C:\\Users\\JasonRosalinda\\.claude\\agents\\incident-reports\\\`

Filename format: \`incident-report-{appName}-{YYYYMMDDHHmm}-{YYYYMMDDHHmm}.md\`

Search strategy (try in order, stop at first match):
1. Glob \`incident-report-{appName}-{YYYYMMDD}*.md\` where YYYYMMDD = the parsed date
2. If multiple matches, prefer the one with the earliest start timestamp (closest to 00:00 of the incident date)
3. If RG is known but you are unsure which appName to use, try both the app name and API name

**If a report file is found:** Read it with the Read tool. Skip Step 3. Proceed to Step 4.

**If no report file is found:** Proceed to Step 3 (live Azure fetch).

## Step 3: Fetch Live Data from Azure CLI (Fallback Only)

Only execute this step when no existing report was found in Step 2.

### 3a. Authenticate

\`\`\`bash
TOKEN=$(az account get-access-token --resource https://management.azure.com --query accessToken -o tsv)
AI_TOKEN=$(az account get-access-token --resource https://api.applicationinsights.io --query accessToken -o tsv)
\`\`\`

If auth fails, stop and output: \`Azure CLI not authenticated. Run: az login\`

### 3b. Set variables

\`\`\`bash
SUB=${sub}
BASE=https://management.azure.com/subscriptions/\${SUB}
# Timespan = UTC equivalent of the full incident day in SGT
# Example for 2026-06-01 SGT: TIMESPAN="2026-05-31T16:00:00Z/2026-06-01T15:59:00Z"
\`\`\`

### 3c. Fetch ARM metrics in parallel

${armFetchSection}

### 3d. App Insights KQL queries in parallel

\`\`\`bash
${appInsightsSection}

ai_query() {
  curl -s -X POST "$AI_ENDPOINT" \\
    -H "Authorization: Bearer $AI_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d "{\\"query\\":\\"$1\\",\\"timespan\\":\\"${TIMESPAN}\\"}"
}

# Exception analysis
ai_query "exceptions | summarize count=count(), firstOccurrence=min(timestamp), lastOccurrence=max(timestamp), sampleMsg=any(innermostMessage), sampleType=any(innermostType) by outerMessage | order by count desc | take 20" > /tmp/inc_exc.json &

# Failed dependencies
ai_query "dependencies | where success == false | summarize failCount=count(), p99=percentile(duration,99), avgMs=avg(duration) by name, type, target | order by failCount desc | take 20" > /tmp/inc_deps.json &

# SQL deep dive
ai_query "dependencies | where type has_any ('SQL','sqlclient') | summarize callCount=count(), failCount=countif(success==false), avgMs=avg(duration), p99=percentile(duration,99), timeoutCount=countif(duration > 30000) by name, target | order by p99 desc | take 15" > /tmp/inc_sql.json &

# SNAT indicators
ai_query "exceptions | where outerMessage has_any ('SocketException','No buffer space','ENOBUFS','actively refused','SNAT') | summarize count=count() by outerMessage" > /tmp/inc_snat.json &

# Deployment events
ai_query "traces | where message has_any ('deploy','restart','swap','Application started','Application is shutting down') | order by timestamp asc | project timestamp, message, severityLevel, cloud_RoleInstance | take 50" > /tmp/inc_dep.json &

# High-frequency IPs
ai_query "requests | extend ip=coalesce(tostring(customDimensions['Client IP Address']), client_IP) | summarize totalCount=count() by ip, client_CountryOrRegion | top 10 by totalCount desc" > /tmp/inc_ips.json &

wait
\`\`\`

If App Insights ID is \`—\` (not configured), skip KQL queries and note "App Insights unavailable — ARM-only analysis" in the plan.

## Step 4: Generate Solution Plan

Analyze all loaded data (from report file or live Azure fetch) and produce the following output. Every claim must cite a specific metric value, exception message, or data point.

---

\`\`\`
═══════════════════════════════════════════════════════════
  INCIDENT SOLUTION PLAN
═══════════════════════════════════════════════════════════
  App:            {appName} ({resourceGroup})
  Incident Date:  {parsedDate} SGT (full day)
  Data Source:    [Existing report: {filename}] OR [Live Azure fetch]
  Anomaly Score:  {score}/100 — {NOMINAL|LOW|MEDIUM|HIGH|CRITICAL}
  Generated:      {nowSGT}
═══════════════════════════════════════════════════════════
\`\`\`

### 1. EXECUTIVE SUMMARY

3–5 bullets. What happened, when it started, peak severity, how long, user impact. If anomaly score available, lead with it and the verdict.

### 2. ROOT CAUSE ANALYSIS

**Primary cause** — pick exactly one:
- CPU saturation (compute overwhelmed by volume or computation)
- Memory pressure / GC thrash (heap exhaustion, excessive Gen 2 GC)
- Thread pool starvation (async over-synchronization, insufficient workers)
- Dependency failure (SQL, external HTTP, internal service)
- SNAT port exhaustion (outbound connection pool depleted)
- Traffic spike / bad actor (abnormal volume from specific IPs or bots)
- Deployment / restart event (new deploy or platform restart caused downtime)
- Platform issue (Azure infrastructure, unrelated to app code)
- Insufficient data (cannot determine)

**Evidence matrix:**

| Signal | Observed | Threshold | Status |
|---|---|---|---|
| Anomaly score | X/100 | >70=HIGH | ✅/⚠️/❌ |
| CPU avg / peak | X% / Y% | 70%W / 90%C | ... |
| Memory avg / peak | XMB / YMB | 1500MB W / 2000MB C | ... |
| 5xx error rate | X% | >2% concern | ... |
| Response time P99 | Xms | >5000ms concern | ... |
| SNAT indicators | N events | >10 concern | ... |
| SQL timeouts | N | >5 concern | ... |
| Deployment event | Yes/No | — | ... |
| Top client IP | IP (N req) | — | ... |

**Contributing factors:** List all secondary signals with citations.

### 3. BLAST RADIUS

- **Services affected:** App name + API name if applicable
- **User impact:** Error rate, affected endpoints (top 5xx URLs), duration
- **Downstream:** Failed dependencies, SQL failures, external service calls
- **SLA impact:** Availability % for period vs 99.5% threshold

### 4. INCIDENT TIMELINE

5-minute window reconstruction. Mark inflection points: first CPU spike, first 5xx, availability drop, recovery start.

| Time (SGT) | CPU% | Mem% | Avail% | 5xx | Event |
|---|---|---|---|---|---|
| HH:mm | ... | ... | ... | ... | ... |

### 5. IMMEDIATE ACTIONS

**P0 — If incident is ONGOING:**
\`\`\`bash
# Check app state
az webapp show --name {appName} --resource-group {rg} --query state -o tsv

# Restart if stopped/degraded
az webapp restart --name {appName} --resource-group {rg}

# Scale out if CPU critical
az appservice plan update --name {asp} --resource-group {rg} --number-of-workers 3

# Check Activity Log for platform events
az monitor activity-log list --resource-group {rg} --start-time {utcStart} \\
  --query "[].{time:eventTimestamp,op:operationName.value,status:status.value}" -o table
\`\`\`

**P1 — Block malicious traffic** (only if bad actor IPs found in evidence):
\`\`\`bash
az webapp config access-restriction add \\
  --resource-group {rg} --name {appName} \\
  --action Deny --ip-address {IP}/32 --priority 100
\`\`\`

**P2 — Address dependency / SNAT issues** (only if evidence shows this as a factor):
List specific actions based on which dependency category failed (SQL connection pool, external HTTP, SNAT exhaustion).

### 6. SHORT-TERM REMEDIATIONS (Next Sprint)

Config and threshold changes to prevent recurrence:
- Specific settings to tune based on identified root cause category
- Scaling thresholds to review (auto-scale rules, worker count)
- Alerting rules to add: CPU >70% sustained 5min, 5xx rate >1%, availability <99.5%
- Monitoring gaps to close based on which data was missing in this analysis

### 7. LONG-TERM RECOMMENDATIONS (Backlog)

Architectural changes based on root cause:
- **Thread pool starvation:** async/await audit, remove sync-over-async patterns, review \`ConfigureAwait\`
- **GC thrash:** memory profiling, LOH allocation review, allocation-free hot paths
- **SNAT exhaustion:** NAT Gateway, \`IHttpClientFactory\`, connection pool tuning, \`ServicePointManager.DefaultConnectionLimit\`
- **Dependency failures:** circuit breaker (Polly), retry policies with jitter, health check endpoints, fallback strategies
- **Traffic spikes:** Azure WAF, CDN, rate limiting middleware, auto-scale on request queue depth
- **Deployment-related:** blue-green slots, slot warming with health probe, canary releases

### 8. VERIFICATION CHECKLIST

After applying any remediations:
- [ ] App running: \`az webapp show --name {appName} --resource-group {rg} --query state -o tsv\` → \`Running\`
- [ ] Health endpoint returning 200 (check \`/health\` or configured health path)
- [ ] CPU and memory at baseline: run \`/app-health-check {key} last 1h\`
- [ ] 5xx rate <0.1% for 15+ consecutive minutes
- [ ] No new SNAT or SQL timeout exceptions in App Insights
- [ ] Incident report updated with resolution time and confirmed root cause

### 9. FOLLOW-UP

- [ ] File post-mortem ticket if SLA breached (availability <99.5%)
- [ ] Notify stakeholders if user-facing impact was significant
- [ ] Save confirmed root cause to \`~/.claude/agent-memory/app-health-check/MEMORY.md\` as a new pattern entry

---

## Behavioral Rules

- **Autonomous.** Parse, fetch, analyze, output. No confirmations, no questions, no "shall I proceed."
- **No narration.** Do not describe what you are doing. Output only the final solution plan.
- **Parallel fetches.** All curl calls use \`&\` + \`wait\`. Never fetch sequentially.
- **SGT always.** All timestamps in output must be SGT (UTC+8). Never expose raw UTC strings.
- **Evidence-based.** Every RCA claim cites a specific metric value, exception message, or data point.
- **Graceful degradation.** If App Insights unavailable, complete the plan with ARM-only data and note which categories lack coverage.
- **No Electron IPC.** Never reference \`window.electronAPI\`. Data access is Bash (\`az\`, \`curl\`) + file reads only.
`;
}

// ── IPC handler registration ──────────────────────────────────────────────────

module.exports = function registerCommandsHandlers() {
  ipcMain.handle('commands:sync', async (_event, { subscriptionId, apps }) => {
    try {
      if (!fs.existsSync(COMMANDS_DIR)) fs.mkdirSync(COMMANDS_DIR, { recursive: true });

      const incidentMd = generateIncidentCommand(subscriptionId, apps || []);
      fs.writeFileSync(path.join(COMMANDS_DIR, 'incident.md'), incidentMd, 'utf8');

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
};
