// Config Diff: compares the app settings and connection strings of two App Service sites
// or slots, e.g. staging vs production before a swap, or UAT vs PRD before a release.
//
// Values are secrets. They are read here, compared here, and never leave the main
// process: the renderer gets names and a same / differs status only. Error messages never
// include a response body, since a body can carry values.

const metrics = require('./azure-metrics.cjs');
const { sharedCredential } = require('./azure-credential.cjs');

const { _getToken: getToken, _resourceId: resourceId } = metrics;

const API = '2022-03-01';

class DeniedError extends Error {}

/** One site of a configured app: the web app itself or its App Service API. */
function siteApp(config, appKey, site) {
  const app = config?.apps?.find((a) => a.name === appKey);
  if (!app) throw new Error(`App "${appKey}" is not in Settings.`);
  if (site === 'api') {
    if (!app.apiName) throw new Error(`${appKey} has no API configured.`);
    if ((app.apiType || 'appservice') !== 'appservice') throw new Error('Container Apps have no App Service settings to compare.');
    return { name: app.apiName, resourceGroup: app.resourceGroup, type: 'appservice' };
  }
  if (app.type !== 'appservice') throw new Error('Container Apps have no App Service settings to compare.');
  return app;
}

function siteResId(subscriptionId, app, slot) {
  const base = resourceId(subscriptionId, app);
  return slot && slot !== 'production' ? `${base}/slots/${encodeURIComponent(slot)}` : base;
}

async function arm(token, path, method = 'GET') {
  const post = method === 'POST';
  const res = await fetch(`https://management.azure.com${path}?api-version=${API}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(post ? { 'Content-Type': 'application/json' } : {}) },
    ...(post ? { body: '{}' } : {}),
  });
  if (res.status === 401 || res.status === 403) throw new DeniedError('denied');
  if (!res.ok) throw new Error(`Azure responded ${res.status}.`);
  return res.json();
}

/** 'production' plus every deployment slot's short name. */
async function listSlots(token, subscriptionId, app) {
  const json = await arm(token, `${resourceId(subscriptionId, app)}/slots`);
  const names = (json.value || []).map((s) => String(s.name || '').split('/').pop()).filter(Boolean);
  return ['production', ...names.sort()];
}

async function readSide(token, subscriptionId, app, slot) {
  const id = siteResId(subscriptionId, app, slot);
  const [settings, conns] = await Promise.all([
    arm(token, `${id}/config/appsettings/list`, 'POST'),
    arm(token, `${id}/config/connectionstrings/list`, 'POST'),
  ]);
  // Sticky (slot) setting names live on the production site only. Optional: Reader can't always read them.
  let sticky = {};
  try {
    sticky = (await arm(token, `${resourceId(subscriptionId, app)}/config/slotConfigNames`)).properties || {};
  } catch { /* shown as not sticky */ }
  return {
    settings: settings.properties || {},
    conns: conns.properties || {},
    stickySettings: sticky.appSettingNames || [],
    stickyConns: sticky.connectionStringNames || [],
  };
}

/**
 * Name-level diff of two sides. Values are compared but never returned. Pure; exported for tests.
 * @returns {{ name: string, kind: 'setting'|'connstr', status: 'only-left'|'only-right'|'same'|'differs', sticky: boolean, type?: string }[]}
 */
function diffConfig(left, right) {
  const rows = [];
  const add = (kind, l, r, sticky, compareValue, typeOf) => {
    const names = [...new Set([...Object.keys(l), ...Object.keys(r)])].sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const inL = Object.prototype.hasOwnProperty.call(l, name);
      const inR = Object.prototype.hasOwnProperty.call(r, name);
      const status = !inR ? 'only-left' : !inL ? 'only-right' : compareValue(l[name]) === compareValue(r[name]) ? 'same' : 'differs';
      const row = { name, kind, status, sticky: sticky.has(name) };
      if (typeOf) row.type = typeOf(inL ? l[name] : r[name]);
      rows.push(row);
    }
  };
  add('setting', left.settings, right.settings,
    new Set([...left.stickySettings, ...right.stickySettings]),
    (v) => String(v ?? ''));
  add('connstr', left.conns, right.conns,
    new Set([...left.stickyConns, ...right.stickyConns]),
    (v) => `${v?.type ?? ''}\u0000${v?.value ?? ''}`,
    (v) => String(v?.type ?? ''));
  return rows;
}

const deniedMessage = (app) => `No permission to read settings on ${app.name}: needs Website Contributor (the config/list action) on ${app.resourceGroup}.`;

const errText = (err, app) => (err instanceof DeniedError ? deniedMessage(app) : (err && err.message) || String(err));

async function compare(token, config, left, right) {
  const sides = [left, right].map((s) => {
    try { return { app: siteApp(config, s.appKey, s.site), slot: s.slot }; } catch (err) { return { error: errText(err) }; }
  });
  const read = await Promise.all(sides.map(async (s) => {
    if (s.error) return s;
    try { return { data: await readSide(token, config.subscriptionId, s.app, s.slot) }; } catch (err) { return { error: errText(err, s.app) }; }
  }));
  const errors = { left: read[0].error, right: read[1].error };
  if (errors.left || errors.right) return { rows: [], errors };
  return { rows: diffConfig(read[0].data, read[1].data), errors: {} };
}

const handler = () => {
  const { ipcMain } = require('electron');

  ipcMain.handle('azure-config:slots', async (_event, { appKey, site, config }) => {
    try {
      const app = siteApp(config, appKey, site);
      return { slots: await listSlots(await getToken(sharedCredential()), config.subscriptionId, app) };
    } catch (err) {
      return { slots: ['production'], error: err instanceof DeniedError ? 'No permission to list deployment slots.' : errText(err) };
    }
  });

  ipcMain.handle('azure-config:diff', async (_event, { left, right, config }) => {
    if (!config?.subscriptionId) return { rows: [], errors: { left: 'No Azure subscription in Settings.' } };
    try {
      return await compare(await getToken(sharedCredential()), config, left, right);
    } catch (err) {
      return { rows: [], errors: { left: errText(err) } };
    }
  });
};

module.exports = handler;
handler._diffConfig = diffConfig;
handler._compare = compare;
handler._listSlots = listSlots;
handler._siteApp = siteApp;
