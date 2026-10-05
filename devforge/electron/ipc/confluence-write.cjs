'use strict';

// Confluence page read/write for the Runbook Editor, over REST with API-token
// Basic auth. Every call takes `fetchImpl` so the tests can stand in for the
// network; the IPC handlers in confluence.cjs pass the global fetch.

const SAVE_MESSAGE = 'Updated via devForge Runbook Editor';

function pageIdFromUrl(url) {
  if (!url) return null;
  if (/^\d+$/.test(String(url).trim())) return String(url).trim();
  const m = url.match(/\/pages\/(\d+)/) || url.match(/[?&]pageId=(\d+)/);
  return m ? m[1] : null;
}

function authHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function normalizeBase(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '').replace(/\/wiki$/i, '');
}

// Read a short snippet of an error response body. Atlassian states the actual
// reason there ("Current user not permitted to use Confluence", a scope error,
// …); without it every failure collapses into a bare status number.
async function errDetail(res) {
  try {
    const text = (await res.text()).slice(0, 400);
    try {
      const j = JSON.parse(text);
      return String(j.message || j.reason || (j.data && j.data.message) || text).slice(0, 220);
    } catch {
      return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    }
  } catch {
    return '';
  }
}

function jsonHeaders(email, apiToken, withBody) {
  const h = { Accept: 'application/json', Authorization: authHeader(email, apiToken) };
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}

async function failure(res, hint) {
  const detail = await errDetail(res);
  const error = [`Confluence responded ${res.status}.`, detail, hint].filter(Boolean).join(' ').replace(/\. —/, ' —');
  return { ok: false, status: res.status, error };
}

const EDIT_HINT = '— your account (or a scoped API token) cannot edit this page.';

const storageBody = (storage) => ({ storage: { value: storage, representation: 'storage' } });

async function getPage({ baseUrl, email, apiToken, pageUrl }, fetchImpl) {
  const pageId = pageIdFromUrl(pageUrl);
  if (!pageId) return { ok: false, error: 'Could not parse a page ID from that URL.' };
  const wiki = `${normalizeBase(baseUrl)}/wiki`;
  try {
    const res = await fetchImpl(`${wiki}/rest/api/content/${pageId}?expand=body.storage,version,space,ancestors`, {
      headers: jsonHeaders(email, apiToken),
    });
    if (!res.ok) return failure(res);
    const c = await res.json();
    const ancestors = c.ancestors || [];
    return {
      ok: true,
      pageId: String(c.id),
      title: c.title,
      version: c.version && c.version.number,
      by: (c.version && c.version.by && c.version.by.displayName) || '',
      when: (c.version && c.version.when) || '',
      spaceKey: (c.space && c.space.key) || '',
      parentId: ancestors.length ? String(ancestors[ancestors.length - 1].id) : '',
      storage: (c.body && c.body.storage && c.body.storage.value) || '',
      url: c._links && c._links.webui ? `${wiki}${c._links.webui}` : '',
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Saves `storage` as version baseVersion + 1. A 409 means someone saved after
// the editor loaded the page: report who, never retry or overwrite.
async function updatePage({ baseUrl, email, apiToken, pageId, title, storage, baseVersion }, fetchImpl) {
  const wiki = `${normalizeBase(baseUrl)}/wiki`;
  try {
    const res = await fetchImpl(`${wiki}/rest/api/content/${pageId}`, {
      method: 'PUT',
      headers: jsonHeaders(email, apiToken, true),
      body: JSON.stringify({
        id: String(pageId),
        type: 'page',
        title,
        version: { number: baseVersion + 1, message: SAVE_MESSAGE },
        body: storageBody(storage),
      }),
    });
    if (res.ok) {
      const c = await res.json();
      return { ok: true, version: c.version && c.version.number };
    }
    if (res.status === 409) {
      const latest = await fetchImpl(`${wiki}/rest/api/content/${pageId}?expand=version`, { headers: jsonHeaders(email, apiToken) });
      const v = latest.ok ? ((await latest.json()).version || {}) : {};
      return {
        ok: false,
        conflict: true,
        latestVersion: v.number,
        by: (v.by && v.by.displayName) || '',
        when: v.when || '',
        error: 'The page changed in Confluence since you loaded it.',
      };
    }
    return failure(res, res.status === 403 ? EDIT_HINT : '');
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function createPage({ baseUrl, email, apiToken, spaceKey, parentId, title, storage }, fetchImpl) {
  const wiki = `${normalizeBase(baseUrl)}/wiki`;
  try {
    const res = await fetchImpl(`${wiki}/rest/api/content`, {
      method: 'POST',
      headers: jsonHeaders(email, apiToken, true),
      body: JSON.stringify({
        type: 'page',
        title,
        space: { key: spaceKey },
        ...(parentId ? { ancestors: [{ id: String(parentId) }] } : {}),
        body: storageBody(storage),
      }),
    });
    if (res.ok) {
      const c = await res.json();
      return {
        ok: true,
        pageId: String(c.id),
        version: c.version && c.version.number,
        url: c._links && c._links.webui ? `${wiki}${c._links.webui}` : '',
      };
    }
    const out = await failure(res, res.status === 403 ? '— your account (or a scoped API token) cannot create pages in this space.' : '');
    return /already exists/i.test(out.error) ? { ...out, duplicateTitle: true } : out;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

async function searchUsers({ baseUrl, email, apiToken, query }, fetchImpl) {
  // Quotes would break out of the CQL string literal.
  const q = String(query || '').replace(/["\\]/g, '').trim();
  if (!q) return { ok: true, users: [] };
  const wiki = `${normalizeBase(baseUrl)}/wiki`;
  try {
    const cql = encodeURIComponent(`user.fullname~"${q}"`);
    const res = await fetchImpl(`${wiki}/rest/api/search/user?limit=8&cql=${cql}`, { headers: jsonHeaders(email, apiToken) });
    if (!res.ok) return failure(res);
    const j = await res.json();
    const users = (j.results || [])
      .map(r => r.user)
      .filter(u => u && u.accountId)
      .map(u => ({ accountId: u.accountId, displayName: u.displayName || u.publicName || u.accountId }));
    return { ok: true, users };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Names for the account ids in existing @mentions (the storage body has ids only).
async function lookupUsers({ baseUrl, email, apiToken, accountIds }, fetchImpl) {
  const ids = [...new Set((accountIds || []).filter(Boolean))];
  if (!ids.length) return { ok: true, users: [] };
  const wiki = `${normalizeBase(baseUrl)}/wiki`;
  try {
    const qs = ids.map(id => `accountId=${encodeURIComponent(id)}`).join('&');
    const res = await fetchImpl(`${wiki}/rest/api/user/bulk?${qs}`, { headers: jsonHeaders(email, apiToken) });
    if (!res.ok) return failure(res);
    const j = await res.json();
    const users = (j.results || [])
      .filter(u => u && u.accountId)
      .map(u => ({ accountId: u.accountId, displayName: u.displayName || u.publicName || u.accountId }));
    return { ok: true, users };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// Adds a file to the page. The editor names screenshots uniquely, so this
// never replaces an existing attachment (Confluence rejects a duplicate name).
async function uploadAttachment({ baseUrl, email, apiToken, pageId, filename, mediaType, bytes }, fetchImpl) {
  const wiki = `${normalizeBase(baseUrl)}/wiki`;
  try {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mediaType || 'application/octet-stream' }), filename);
    form.append('minorEdit', 'true');
    const res = await fetchImpl(`${wiki}/rest/api/content/${pageId}/child/attachment`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: authHeader(email, apiToken), 'X-Atlassian-Token': 'nocheck' },
      body: form,
    });
    return res.ok ? { ok: true } : failure(res, res.status === 403 ? '— your account cannot add attachments to this page.' : '');
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// A page attachment as a data URI, for previews and for copying to a new page.
async function fetchAttachment({ baseUrl, email, apiToken, pageId, filename }, fetchImpl) {
  const wiki = `${normalizeBase(baseUrl)}/wiki`;
  try {
    const list = await fetchImpl(`${wiki}/rest/api/content/${pageId}/child/attachment?filename=${encodeURIComponent(filename)}`, { headers: jsonHeaders(email, apiToken) });
    if (!list.ok) return failure(list);
    const download = ((await list.json()).results || [])[0]?._links?.download;
    if (!download) return { ok: false, error: `No attachment named ${filename} on this page.` };
    const res = await fetchImpl(`${wiki}${download}`, { headers: { Authorization: authHeader(email, apiToken) } });
    if (!res.ok) return failure(res);
    const type = (res.headers && res.headers.get('content-type')) || 'application/octet-stream';
    const b64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { ok: true, dataUri: `data:${type.split(';')[0]};base64,${b64}` };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

module.exports = {
  pageIdFromUrl, authHeader, normalizeBase, errDetail,
  getPage, updatePage, createPage, searchUsers, lookupUsers, uploadAttachment, fetchAttachment,
};
