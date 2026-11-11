// Release events — when new code reached production.
//
// The card's charts show CPU, memory, restarts and errors over time, but not the one
// event most likely to explain a change in any of them. A release marker on every
// chart turns "CPU doubled at 17:12" into "CPU doubled right after the 17:11 swap".
//
// Two sources, because neither sees every release:
//  - The Activity Log records every slot swap, including manual ones from the portal,
//    but says nothing about which build went out.
//  - Kudu's deployment history (sites/{name}/deployments) is written by the release
//    pipeline: Azure DevOps posts a "Deployment" record when it deploys and a
//    "SlotSwap" record when it swaps, both carrying the build and commit as JSON in
//    `message`. A OneDeploy / zip deploy straight to production shows up only here.
// Container Apps have neither; a new revision is their release.

const ARM = 'https://management.azure.com';
const ACTIVITY_API_VERSION = '2015-04-01';
const KUDU_API_VERSION = '2022-03-01';
const REVISIONS_API_VERSION = '2023-05-01';

const DAY = 24 * 60 * 60 * 1000;
/** How far back the header's "last release" looks when the chart window holds none. */
const LOOKBACK_MS = 30 * DAY;
/** The Activity Log rejects queries reaching further back than its 90-day retention. */
const ACTIVITY_RETENTION_MS = 89 * DAY;
/** The Activity Log and Kudu both record the same swap, ~10 s apart. */
const COLLAPSE_MS = 2 * 60 * 1000;
/** A resource group sees a few hundred events a month; this is headroom, not a limit hit in practice. */
const MAX_ACTIVITY_PAGES = 10;
const MAX_EVENTS = 50;

// Both casings occur: ARM logs `slots/slotsswap/action`, the classic pipeline
// `slots/SlotsSwap/action`, for the same swap. Compared lower-cased.
const SWAP_OPS = new Set([
  'microsoft.web/sites/slotsswap/action',
  'microsoft.web/sites/slots/slotsswap/action',
]);

// Production changes that are not releases, from the same Activity Log records: what a
// person or automation did to the site or its plan. "Was it someone, or the platform?"
// Kudu kills and platform healing are not here; the restart detector has those.
const SITE_CHANGE_OPS = {
  'microsoft.web/sites/restart/action': { kind: 'restart', label: 'Restart' },
  'microsoft.web/sites/stop/action': { kind: 'stop', label: 'Stop' },
  'microsoft.web/sites/start/action': { kind: 'start', label: 'Start' },
  'microsoft.web/sites/config/write': { kind: 'config', label: 'Configuration change (app settings, connection strings or site config)' },
  'microsoft.web/sites/write': { kind: 'site', label: 'Site settings change' },
};
const PLAN_CHANGE_OPS = {
  'microsoft.web/serverfarms/write': { kind: 'plan', label: 'App Service plan change (scale or pricing tier)' },
};

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Kudu deployment status for "Success". */
const KUDU_SUCCESS = 4;

/** GET that keeps the status, so a 403 (no Reader on the RG) reads as "denied", not as "no releases". */
async function armGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    console.warn(`[releases] GET ${res.status} ${res.statusText} — ${url}`);
    return { status: res.status, json: null };
  }
  return { status: res.status, json: await res.json() };
}

const sourceStatus = (status) => (status === 401 || status === 403 ? 'denied' : 'error');

/**
 * Production-impacting slot swaps on one site, from Activity Log records. Pure.
 *
 * A swap is logged on the slot resource (`…/sites/x/slots/staging`), so the site id
 * matches as a prefix — but only up to a `/` boundary, or `prdmeduapp` would also
 * claim `prdmeduapp2`'s swaps.
 */
function parseActivitySwaps(records, siteResId) {
  const site = siteResId.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const r of records ?? []) {
    if (r?.status?.value !== 'Succeeded') continue;
    if (!SWAP_OPS.has(String(r?.operationName?.value ?? '').toLowerCase())) continue;
    const rid = String(r?.resourceId ?? '').toLowerCase();
    if (rid !== site && !rid.startsWith(`${site}/`)) continue;
    if (r.correlationId) {
      if (seen.has(r.correlationId)) continue;
      seen.add(r.correlationId);
    }
    const at = new Date(r.eventTimestamp);
    if (Number.isNaN(at.getTime())) continue;
    const slot = rid.match(/\/slots\/([^/]+)/)?.[1];
    out.push({
      at: at.toISOString(),
      source: 'swap',
      // A pipeline swaps as a service principal, logged as its bare object id; left
      // out so Kudu's record of the same swap can name the person who released.
      by: r.caller && !GUID.test(r.caller) ? r.caller : undefined,
      message: slot ? `Swap from slot ${slot}` : 'Slot swap',
    });
  }
  return out;
}

/**
 * Restarts, stop/start, config writes and plan changes on one production site, from
 * Activity Log records. Only the site itself (a slot's change is not production) and,
 * when known, its own App Service plan. Pure.
 */
function parseActivityChanges(records, siteResId, planResId = null) {
  const site = siteResId.toLowerCase();
  const plan = planResId ? planResId.toLowerCase() : null;
  const seen = new Set();
  const out = [];
  for (const r of records ?? []) {
    if (r?.status?.value !== 'Succeeded') continue;
    const op = String(r?.operationName?.value ?? '').toLowerCase();
    const rid = String(r?.resourceId ?? '').toLowerCase();
    // config/write is logged on …/sites/x/config/appsettings; the rest on the site itself.
    const onSite = rid === site || (op.startsWith('microsoft.web/sites/config/') && rid.startsWith(`${site}/config`));
    const hit = (onSite && SITE_CHANGE_OPS[op]) || (plan && rid === plan && PLAN_CHANGE_OPS[op]);
    if (!hit) continue;
    const key = r.correlationId ? `${r.correlationId}|${op}` : null;
    if (key) { if (seen.has(key)) continue; seen.add(key); }
    const at = new Date(r.eventTimestamp);
    if (Number.isNaN(at.getTime())) continue;
    out.push({
      at: at.toISOString(),
      kind: hit.kind,
      label: hit.label,
      // A bare object id is a service principal: automation, not a person.
      by: r.caller ? (GUID.test(r.caller) ? 'automation (service principal)' : r.caller) : undefined,
    });
  }
  // One portal save writes appsettings and slotConfigNames separately: one change, not two.
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .filter((c, i, all) => !all.slice(0, i).some(p => p.kind === c.kind && Date.parse(c.at) - Date.parse(p.at) < COLLAPSE_MS));
}

/** The pipeline's JSON message, or null for a plain-text one ("OneDeploy"). */
function parseKuduMessage(message) {
  if (typeof message !== 'string' || !message.trim().startsWith('{')) return null;
  try { return JSON.parse(message); } catch { return null; }
}

/**
 * Successful deployments and swaps from Kudu's history for the production site. Pure.
 *
 * A pipeline that deploys to a staging slot still posts its "Deployment" record to the
 * production site, a minute or two before the swap that actually releases it. That
 * record is dropped when a SlotSwap with the same release (or commit) exists — the code
 * was not live until the swap.
 */
function parseKuduDeployments(records) {
  const rows = (records ?? [])
    .map(r => r?.properties ?? {})
    .filter(p => p.status === KUDU_SUCCESS && (p.end_time || p.start_time));
  const parsed = rows.map(p => ({ p, meta: parseKuduMessage(p.message) }));
  const swapped = new Set(parsed
    .filter(x => x.meta?.type === 'SlotSwap')
    .flatMap(x => [x.meta.releaseId, x.meta.commitId].filter(Boolean).map(String)));

  const out = [];
  for (const { p, meta } of parsed) {
    const isSwap = meta?.type === 'SlotSwap';
    if (!isSwap && meta && [meta.releaseId, meta.commitId].some(id => id && swapped.has(String(id)))) continue;
    const at = new Date(p.end_time || p.start_time);
    if (Number.isNaN(at.getTime())) continue;
    const by = p.author && p.author !== 'N/A' ? p.author : (p.deployer || undefined);
    out.push({
      at: at.toISOString(),
      source: isSwap ? 'swap' : 'deploy',
      by,
      build: meta?.buildNumber ? String(meta.buildNumber) : undefined,
      commit: meta?.commitId ? String(meta.commitId).slice(0, 8) : undefined,
      // Azure DevOps posts Build.SourceBranchName: the last segment only ("2026.11" for release/2026.11).
      branch: meta?.branch ? String(meta.branch) : undefined,
      message: meta ? undefined : (p.message || undefined),
    });
  }
  return out;
}

/** Container App revisions, one release each. Pure. */
function parseRevisions(records) {
  const out = [];
  for (const r of records ?? []) {
    const at = new Date(r?.properties?.createdTime);
    if (Number.isNaN(at.getTime())) continue;
    out.push({ at: at.toISOString(), source: 'revision', message: r.name ? `Revision ${r.name}` : undefined });
  }
  return out;
}

/**
 * One timeline from every source, oldest first. Pure.
 *
 * Events closer than COLLAPSE_MS are the same release seen twice (the Activity Log's
 * swap and Kudu's SlotSwap record), so they merge: the earliest time, "swap" if either
 * was one, and each field from whichever source had it — the Activity Log knows who
 * swapped, Kudu knows which build.
 */
function mergeReleases(...lists) {
  const all = lists.flat().filter(Boolean).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const merged = [];
  for (const ev of all) {
    const prev = merged[merged.length - 1];
    if (prev && Date.parse(ev.at) - Date.parse(prev.at) < COLLAPSE_MS) {
      if (ev.source === 'swap') prev.source = 'swap';
      for (const k of ['by', 'build', 'commit', 'branch', 'message']) if (!prev[k] && ev[k]) prev[k] = ev[k];
      continue;
    }
    merged.push({ ...ev });
  }
  // Undefined keys dropped so the payload crossing IPC stays minimal.
  return merged.map(ev => Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)));
}

/** Every Activity Log record for the resource group in the range; swaps and changes are parsed from them. */
async function fetchActivityRecords(token, { subscriptionId, resourceGroup, startIso, endIso }) {
  const filter = `eventTimestamp ge '${startIso}' and eventTimestamp le '${endIso}' and resourceGroupName eq '${resourceGroup}'`;
  let url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Insights/eventtypes/management/values` +
    `?api-version=${ACTIVITY_API_VERSION}&$filter=${encodeURIComponent(filter)}` +
    `&$select=${encodeURIComponent('eventTimestamp,operationName,resourceId,status,correlationId,caller')}`;
  const records = [];
  for (let page = 0; url && page < MAX_ACTIVITY_PAGES; page++) {
    const { status, json } = await armGet(url, token);
    if (!json) {
      // A later page failing still leaves the earlier ones usable.
      if (page === 0) return { status: sourceStatus(status), records: [] };
      break;
    }
    records.push(...(json.value ?? []));
    url = json.nextLink || null;
  }
  return { status: 'ok', records };
}

/** The site's App Service plan id, so plan changes can be matched; null when unreadable. */
async function fetchPlanId(token, siteResId) {
  const { json } = await armGet(`${ARM}${siteResId}?api-version=${KUDU_API_VERSION}`, token);
  return json?.properties?.serverFarmId ?? null;
}

async function fetchKuduDeployments(token, siteResId) {
  const { status, json } = await armGet(`${ARM}${siteResId}/deployments?api-version=${KUDU_API_VERSION}`, token);
  if (!json) return { status: sourceStatus(status), events: [] };
  return { status: 'ok', events: parseKuduDeployments(json.value) };
}

async function fetchRevisions(token, siteResId) {
  const { status, json } = await armGet(`${ARM}${siteResId}/revisions?api-version=${REVISIONS_API_VERSION}`, token);
  if (!json) return { status: sourceStatus(status), events: [] };
  return { status: 'ok', events: parseRevisions(json.value) };
}

/**
 * Releases for one site up to `endIso`, with the newest as `last`.
 *
 * Looks back at least LOOKBACK_MS even for a one-hour chart: the header's "last
 * release" is most useful exactly when the window holds none. Markers outside the
 * chart window are dropped by the chart itself.
 */
async function fetchReleases(token, { subscriptionId, resourceGroup, siteResId, isAppService, startIso, endIso }) {
  const endMs = Date.parse(endIso);
  const queryStartMs = Math.max(
    Math.min(Date.parse(startIso), endMs - LOOKBACK_MS),
    Date.now() - ACTIVITY_RETENTION_MS,
  );
  const queryStartIso = new Date(queryStartMs).toISOString();

  let parts;
  let sources;
  let changes = [];
  if (isAppService) {
    const [activity, kudu, planResId] = await Promise.all([
      fetchActivityRecords(token, { subscriptionId, resourceGroup, startIso: queryStartIso, endIso })
        .catch(() => ({ status: 'error', records: [] })),
      fetchKuduDeployments(token, siteResId).catch(() => ({ status: 'error', events: [] })),
      fetchPlanId(token, siteResId).catch(() => null),
    ]);
    parts = [parseActivitySwaps(activity.records, siteResId), kudu.events];
    changes = parseActivityChanges(activity.records, siteResId, planResId).filter(c => Date.parse(c.at) <= endMs).slice(-MAX_EVENTS);
    sources = { activityLog: activity.status, kudu: kudu.status };
  } else {
    const revisions = await fetchRevisions(token, siteResId).catch(() => ({ status: 'error', events: [] }));
    parts = [revisions.events];
    sources = { revisions: revisions.status };
  }

  // Kudu's history is not windowed, so later-than-window records are cut here.
  const events = mergeReleases(...parts).filter(ev => Date.parse(ev.at) <= endMs).slice(-MAX_EVENTS);
  return { events, last: events[events.length - 1] ?? null, sources, changes };
}

function siteResourceId(subscriptionId, site) {
  if (site.type === 'appservice') {
    return `/subscriptions/${subscriptionId}/resourceGroups/${site.resourceGroup}/providers/Microsoft.Web/sites/${site.name}`;
  }
  return `/subscriptions/${subscriptionId}/resourceGroups/${site.resourceGroup}/providers/Microsoft.App/containerApps/${site.name}`;
}

/** Releases for one configured app entry, per site: its frontend and, when it has one, its API. */
async function fetchAppReleases(token, { subscriptionId, app, startIso, endIso }) {
  const forSite = (site) => fetchReleases(token, {
    subscriptionId,
    resourceGroup: site.resourceGroup,
    siteResId: siteResourceId(subscriptionId, site),
    isAppService: site.type === 'appservice',
    startIso,
    endIso,
  }).catch(() => null);
  const [fe, api] = await Promise.all([
    forSite({ ...app, type: app.type || 'appservice' }),
    app.apiName ? forSite({ type: app.apiType || 'appservice', resourceGroup: app.resourceGroup, name: app.apiName }) : null,
  ]);
  return { fe, api };
}

module.exports = {
  siteResourceId,
  fetchAppReleases,
  COLLAPSE_MS,
  LOOKBACK_MS,
  MAX_ACTIVITY_PAGES,
  parseActivitySwaps,
  parseActivityChanges,
  parseKuduDeployments,
  parseRevisions,
  mergeReleases,
  fetchReleases,
};
