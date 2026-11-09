// Cert & Domain Expiry: the TLS certificate each configured app serves, and how many days
// it has left. Hostnames come from Settings (platform URLs) plus the ones bound in Azure.

const tls = require('tls');
const metrics = require('./azure-metrics.cjs');
const { sharedCredential } = require('./azure-credential.cjs');
const { mapPool } = require('./pool.cjs');

const { _getToken: getToken, _resourceId: resourceId } = metrics;

const DAY_MS = 86_400_000;
const CONNECT_TIMEOUT_MS = 5000;

/** expired (< 0 days), critical (< 14), warning (< 30), else ok. Pure; exported for tests. */
function certStatus(validToMs, nowMs) {
  const daysLeft = Math.floor((validToMs - nowMs) / DAY_MS);
  const status = daysLeft < 0 ? 'expired' : daysLeft < 14 ? 'critical' : daysLeft < 30 ? 'warning' : 'ok';
  return { daysLeft, status };
}

function hostOf(url) {
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase(); } catch { return null; }
}

/** Hostnames an ARM site (App Service or Container App) is bound to. */
function armHosts(site) {
  if (!site) return [];
  const p = site.properties || {};
  const ingress = p.configuration?.ingress;
  return [
    ...(p.hostNames || []),
    ...(ingress?.fqdn ? [ingress.fqdn] : []),
    ...((ingress?.customDomains || []).map((d) => d.name)),
  ];
}

/**
 * Every host to check for one app: its platform URLs, then what Azure has bound to the
 * web app and the API. Kudu (*.scm.*) hosts are skipped. Pure; exported for tests.
 * @returns {{ host: string, site: 'web'|'api'|'url' }[]}
 */
function hostsFor(app, armSites = {}) {
  const out = [];
  const seen = new Set();
  const add = (raw, site) => {
    const host = hostOf(String(raw || ''));
    if (!host || seen.has(host) || /\.scm\./.test(host)) return;
    seen.add(host);
    out.push({ host, site });
  };
  for (const u of app.platformUrls || []) add(u, 'url');
  for (const h of armHosts(armSites.web)) add(h, 'web');
  for (const h of armHosts(armSites.api)) add(h, 'api');
  return out;
}

/**
 * How far the certificate's details can be believed. Node sets `authorized = false` for any
 * problem, so split on the code:
 *  - 'ok'    trusted, or only expired / not yet valid: the dates are the site's own.
 *  - 'host'  valid chain, but the certificate doesn't name this host (a real site problem).
 *  - 'chain' this machine can't build a trusted chain (self-signed, or a TLS-inspecting
 *            proxy answering instead): the dates may be the proxy's.
 * Pure; exported for tests.
 */
function trustOf(authorized, code) {
  if (authorized) return 'ok';
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') return 'ok';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'host';
  return 'chain';
}

/**
 * Reads the certificate a host serves. `rejectUnauthorized: false` is only so an expired
 * or untrusted certificate can still be read and reported: nothing is ever sent on this
 * socket, it is destroyed as soon as the handshake ends, and the trust verdict is shown.
 */
function readCert(host) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: CONNECT_TIMEOUT_MS });
    const done = (result) => { socket.destroy(); resolve({ host, ...result }); };
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return done({ error: 'No certificate returned.' });
      const code = socket.authorizationError ? String(socket.authorizationError) : undefined;
      done({
        validTo: new Date(cert.valid_to).toISOString(),
        issuer: cert.issuer?.O || cert.issuer?.CN || '',
        sans: String(cert.subjectaltname || '').split(',').map((s) => s.trim().replace(/^DNS:/, '')).filter(Boolean),
        authorized: socket.authorized,
        authorizationError: code,
        trust: trustOf(socket.authorized, code),
      });
    });
    // A later resolve is a no-op, so whichever of these comes first wins.
    socket.once('timeout', () => done({ error: 'Timed out connecting on port 443.' }));
    // `on`, not `once`: a second error with no listener would throw in the main process.
    socket.on('error', (err) => done({ error: err.code === 'ENOTFOUND' ? 'Host not found.' : err.message }));
  });
}

async function armSite(token, subscriptionId, siteApp) {
  try {
    const apiVersion = siteApp.type === 'containerapp' ? '2023-05-01' : '2022-03-01';
    const res = await fetch(`https://management.azure.com${resourceId(subscriptionId, siteApp)}?api-version=${apiVersion}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok ? await res.json() : null; // denied or missing: platform URLs only
  } catch { return null; }
}

const DEFAULT_DEPS = { readCert, now: Date.now, armToken: () => getToken(sharedCredential()) };

async function checkApps({ appKeys, config }, deps = DEFAULT_DEPS) {
  const apps = (config?.apps || []).filter((a) => appKeys.includes(a.name));
  let token = null;
  try { token = await deps.armToken(); } catch { /* signed out: platform URLs only */ }

  const targets = (await Promise.all(apps.map(async (app) => {
    const [web, api] = token && config.subscriptionId
      ? await Promise.all([
        armSite(token, config.subscriptionId, app),
        app.apiName ? armSite(token, config.subscriptionId, { name: app.apiName, resourceGroup: app.resourceGroup, type: app.apiType || 'appservice' }) : null,
      ])
      : [null, null];
    return hostsFor(app, { web, api }).map((h) => ({ ...h, appKey: app.name }));
  }))).flat();

  const nowMs = deps.now();
  const results = await mapPool(targets, 6, async (t) => {
    const cert = await deps.readCert(t.host);
    const timing = cert.validTo ? certStatus(Date.parse(cert.validTo), nowMs) : {};
    return { ...t, ...cert, ...timing };
  });
  return { results, checkedAt: new Date(nowMs).toISOString() };
}

const handler = () => {
  const { ipcMain } = require('electron');
  ipcMain.handle('certs:check', async (_event, opts) => {
    try {
      return await checkApps(opts);
    } catch (err) {
      return { results: [], error: (err && err.message) || String(err) };
    }
  });
};

module.exports = handler;
handler._certStatus = certStatus;
handler._hostsFor = hostsFor;
handler._trustOf = trustOf;
handler._checkApps = checkApps;
