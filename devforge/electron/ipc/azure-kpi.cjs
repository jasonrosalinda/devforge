// Service KPI: one calendar month's figures per configured app, the ones the monthly
// Service KPI report asks for. CPU / memory / DB are the mean of daily averages, 5xx is
// the App Insights total (same 5xx rule as the Health Check card), cost comes from
// Cost Management grouped by resource group and service. Every figure fails on its own:
// one missing permission or resource never blanks the rest of the page.

const metrics = require('./azure-metrics.cjs');

const {
  _getToken: getToken,
  _resourceId: resourceId,
  _sqlDbResourceId: sqlDbResourceId,
  _getPlanInfo: getPlanInfo,
  _resolveSiteAppId: resolveSiteAppId,
  _RC_5XX_EXPR: RC_5XX_EXPR,
} = metrics;
const { sharedCredential } = require('./azure-credential.cjs');

const COST_API = '2023-03-01';
// shortcut: stops after this many Cost Management pages; one month of one subscription grouped by RG x service fits easily, raise it if the total ever reads short.
const MAX_COST_PAGES = 10;

function mean(values) {
  const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n));
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
}

function errMessage(err) {
  return (err && err.message) || String(err);
}

/** A value, or "No data" when Azure returned none for the month. */
function cellOf(value) {
  return value == null ? { value: null, note: 'No data in this month' } : { value };
}

/** Runs one figure; a throw becomes that cell's error instead of failing the row. */
async function settle(fn) {
  try { return cellOf(await fn()); }
  catch (err) { return { value: null, error: errMessage(err) }; }
}

/** Mean of the daily averages of one metric over the window. Null when there are no points. */
async function monthlyAverage(client, resId, metricName, timespan) {
  const res = await client.queryResource(resId, [metricName], {
    timespan,
    granularity: 'P1D',
    aggregations: ['Average'],
  });
  const data = res.metrics?.[0]?.timeseries?.[0]?.data || [];
  return mean(data.map((d) => d.average));
}

/** Total 5xx requests in the window, weighted by itemCount so sampling doesn't undercount. */
async function countFiveXx(appId, credential, startIso, endIso) {
  const aiToken = (await credential.getToken('https://api.applicationinsights.io/.default')).token;
  const query = `requests | extend rc=toint(resultCode) | where ${RC_5XX_EXPR} | summarize total=sum(itemCount)`;
  const res = await fetch(`https://api.applicationinsights.io/v1/apps/${appId}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${aiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, timespan: `${startIso}/${endIso}` }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`App Insights ${res.status}: ${txt}`.slice(0, 300));
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return Number(data.tables?.[0]?.rows?.[0]?.[0]) || 0;
}

/** The configured app entry, narrowed to one site: its own type, name and resource id. */
function siteEntry(app, site) {
  return site === 'api'
    ? { type: app.apiType || 'appservice', resourceGroup: app.resourceGroup, name: app.apiName }
    : { type: app.type, resourceGroup: app.resourceGroup, name: app.name };
}

async function fetchTarget(ctx, app, site) {
  const { client, cred, token, subscriptionId, window } = ctx;
  const timespan = { startTime: new Date(window.startIso), endTime: new Date(window.endIso) };
  const entry = siteEntry(app, site);
  const resId = resourceId(subscriptionId, entry);

  // App Service CPU / memory are published on the plan (what the portal dashboards chart).
  const metricsResId = entry.type === 'appservice'
    ? getPlanInfo(token, resId).then((plan) => {
        if (!plan?.farmId) throw new Error(`App Service plan not found for ${entry.name}`);
        return plan.farmId;
      })
    : Promise.resolve(resId);
  // Sites on one plan report the same CPU / memory; naming the plan makes that visible.
  const scope = await metricsResId.then(
    (id) => (entry.type === 'appservice' ? `Plan ${id.split('/').pop()}` : 'Container app'),
    () => null,
  );

  const hasDb = site === 'web' && !!(app.dbName && app.dbServerName);
  const aiAppId = await resolveSiteAppId(app, site, token, subscriptionId).catch(() => null);

  const [cpu, memory, db, errors5xx] = await Promise.all([
    settle(async () => monthlyAverage(client, await metricsResId, 'CpuPercentage', timespan)),
    settle(async () => monthlyAverage(client, await metricsResId, 'MemoryPercentage', timespan)),
    hasDb ? settle(() => monthlyAverage(client, sqlDbResourceId(subscriptionId, app), 'cpu_percent', timespan)) : null,
    aiAppId ? settle(() => countFiveXx(aiAppId, cred, window.startIso, window.endIso)) : null,
  ]);
  return { scope, cpu, memory, db, errors5xx };
}

/** Sums Cost Management rows into a total and per-service / per-resource-group lines, largest first. */
function aggregateCost(columns, rows) {
  const col = (name) => columns.findIndex((c) => String(c).toLowerCase() === name);
  const iCost = col('cost');
  const iRg = col('resourcegroupname');
  const iSvc = col('servicename');
  const iCur = col('currency');
  if (iCost < 0) throw new Error('Cost Management returned no Cost column');

  const byService = new Map();
  const byRg = new Map();
  let total = 0;
  let currency = '';
  for (const r of rows) {
    const cost = Number(r[iCost]) || 0;
    total += cost;
    if (!currency && iCur >= 0) currency = String(r[iCur] || '');
    const svc = (iSvc >= 0 && r[iSvc]) || '(no service)';
    // Subscription-level charges (support plans, Defender) carry no resource group.
    const rg = (iRg >= 0 && r[iRg]) || '(subscription level)';
    byService.set(svc, (byService.get(svc) || 0) + cost);
    // Cost Management spells one group in several cases; key on lower case, keep the first spelling.
    const rgKey = String(rg).toLowerCase();
    const group = byRg.get(rgKey) || { name: rg, cost: 0, services: new Map() };
    group.cost += cost;
    // Per-group services: the report's cost lines (App Service, SQL Database...) are per platform.
    group.services.set(svc, (group.services.get(svc) || 0) + cost);
    byRg.set(rgKey, group);
  }
  const sorted = (lines) => lines.filter((l) => l.cost !== 0).sort((a, b) => b.cost - a.cost);
  const lines = (map) => sorted([...map].map(([name, cost]) => ({ name, cost })));
  return {
    ok: true,
    currency: currency || 'USD',
    total,
    byService: lines(byService),
    byResourceGroup: sorted([...byRg.values()].map((g) => ({ name: g.name, cost: g.cost, services: lines(g.services) }))),
  };
}

const RETRY_HEADERS = [
  'x-ms-ratelimit-microsoft.costmanagement-entity-retry-after',
  'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after',
  'retry-after',
];
const MAX_RETRY_WAIT_S = 15;

/** Cost Management throttles hard (a few queries a minute): on 429 wait as told (capped) and try once more. */
async function postCost(url, init) {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;
  const told = RETRY_HEADERS.map((h) => Number.parseFloat(res.headers?.get?.(h) ?? '')).find((n) => Number.isFinite(n));
  const waitS = Math.min(told ?? 5, MAX_RETRY_WAIT_S);
  await new Promise((r) => setTimeout(r, waitS * 1000));
  return fetch(url, init);
}

async function fetchCost(token, subscriptionId, window) {
  const body = JSON.stringify({
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from: window.costFrom, to: window.costTo },
    dataset: {
      granularity: 'None',
      aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
      grouping: [
        { type: 'Dimension', name: 'ResourceGroupName' },
        { type: 'Dimension', name: 'ServiceName' },
      ],
    },
  });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  let columns = null;
  const rows = [];
  for (let page = 0; url && page < MAX_COST_PAGES; page++) {
    const res = await postCost(url, { method: 'POST', headers, body });
    if (res.status === 401 || res.status === 403) {
      throw new Error('No access to Cost Management. Ask for the Cost Management Reader role on this subscription.');
    }
    if (res.status === 429) throw new Error('Cost Management is limiting requests. Wait a minute, then Fetch again.');
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Cost Management ${res.status}: ${txt}`.slice(0, 300));
    }
    const data = await res.json();
    columns = columns || (data.properties?.columns || []).map((c) => c.name);
    rows.push(...(data.properties?.rows || []));
    url = data.properties?.nextLink || null;
  }
  return aggregateCost(columns || [], rows);
}

/** The whole request: every target in parallel, plus the cost query. */
async function fetchServiceKpi({ client, cred }, { config, window, targets }) {
  if (!config?.subscriptionId || !config?.apps?.length) {
    return { _error: 'No Azure configuration. Open Settings and configure your subscription and apps.' };
  }
  const token = await getToken(cred);
  const ctx = { client, cred, token, subscriptionId: config.subscriptionId, window };
  const apps = new Map(config.apps.map((a) => [a.name, a]));

  const [entries, cost] = await Promise.all([
    Promise.all(targets.map(async (t) => {
      const key = `${t.appName}::${t.site}`;
      const app = apps.get(t.appName);
      if (!app) {
        const missing = { value: null, error: `App "${t.appName}" not found in Settings.` };
        return [key, { scope: null, cpu: missing, memory: missing, db: null, errors5xx: null }];
      }
      return [key, await fetchTarget(ctx, app, t.site)];
    })),
    fetchCost(token, config.subscriptionId, window).catch((err) => ({ ok: false, error: errMessage(err) })),
  ]);
  return { targets: Object.fromEntries(entries), cost };
}

const handler = () => {
  const { ipcMain } = require('electron');
  const { MetricsQueryClient } = require('@azure/monitor-query');

  // The shared credential keeps no failed token, so a fresh `az login` works on retry
  // without dropping anything here.
  let shared = null;
  const azure = () => {
    const cred = sharedCredential();
    if (shared?.cred !== cred) shared = { cred, client: new MetricsQueryClient(cred) };
    return shared;
  };

  ipcMain.handle('azure-kpi:fetch', async (_event, opts) => {
    try {
      return await fetchServiceKpi(azure(), opts);
    } catch (err) {
      return { _error: errMessage(err) };
    }
  });
};

module.exports = handler;
handler._mean = mean;
handler._monthlyAverage = monthlyAverage;
handler._countFiveXx = countFiveXx;
handler._aggregateCost = aggregateCost;
handler._fetchCost = fetchCost;
handler._fetchServiceKpi = fetchServiceKpi;
