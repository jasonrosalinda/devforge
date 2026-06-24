'use strict';

const { ipcMain, BrowserWindow, session, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PARTITION = 'persist:confluence';
const AUTH_COOKIE = /session\.token|cloud\.session|tenant\.session/i;

// ── Helpers ─────────────────────────────────────────────────────────────────

function pageIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/pages\/(\d+)/) || url.match(/[?&]pageId=(\d+)/);
  return m ? m[1] : null;
}

function authHeader(email, token) {
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

function normalizeBase(baseUrl) {
  return (baseUrl || '').replace(/\/+$/, '').replace(/\/wiki$/i, '');
}

function sess() {
  return session.fromPartition(PARTITION);
}

async function hasAuthCookie(base) {
  try {
    const cookies = await sess().cookies.get({ url: base });
    return cookies.some(c => AUTH_COOKIE.test(c.name));
  } catch {
    return false;
  }
}

// Detect image type from actual bytes (magic numbers). null = not an image
// (e.g. an HTML login page returned with status 200).
function sniffImageMime(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6) {
    const g = buf.toString('ascii', 0, 6);
    if (g === 'GIF89a' || g === 'GIF87a') return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 256)).trim().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  return null;
}

// Download an image using the logged-in Confluence session cookies (Chromium
// net stack, follows the /wiki/download → signed-media redirect like a browser).
async function fetchImageViaSession(url) {
  try {
    // Atlassian's download edge 403s cookie-auth'd requests that don't look like
    // a real in-page image load — send the same-origin Referer + browser fetch
    // metadata a Chromium <img> would. (REST _links.download tolerates bare
    // requests; the raw /wiki/download/attachments/…?api=v2 URLs do not.)
    let headers;
    try {
      const u = new URL(url);
      headers = {
        Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8',
        Referer: `${u.origin}/wiki/`,
        'X-Atlassian-Token': 'no-check',
        'Sec-Fetch-Dest': 'image',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'same-origin',
      };
    } catch { headers = undefined; }
    const res = await sess().fetch(url, { credentials: 'include', ...(headers ? { headers } : {}) });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = sniffImageMime(buf);
    if (!mime) return { ok: false, status: res.status, notImage: true, buf };
    return { ok: true, status: res.status, mime, buf };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || String(err) };
  }
}

// Download image bytes over plain HTTP with explicit headers (e.g. the REST API
// token via Basic auth). Use this when the API token has access but the browser
// session cookies don't — the common case for restricted Confluence spaces.
async function fetchImageWithHeaders(url, hdrs) {
  try {
    const res = await fetch(url, { headers: hdrs });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = sniffImageMime(buf);
    if (!mime) return { ok: false, status: res.status, notImage: true, buf };
    return { ok: true, status: res.status, mime, buf };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || String(err) };
  }
}

// GET JSON via the logged-in session cookies (the browser's auth). The REST
// API token can see a narrower set of attachments than the signed-in user, so
// listing through the session surfaces the same images the browser renders.
async function sessGetJson(url) {
  try {
    const res = await sess().fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true, status: res.status, json: await res.json() };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || String(err) };
  }
}

// Run fn over items with a bounded number of concurrent workers; preserves
// input order in the returned results array.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

module.exports = function registerConfluenceHandlers() {
  // Open a login window; resolve once the Atlassian session cookie appears.
  ipcMain.handle('confluence:login', async (_event, { baseUrl }) => {
    const base = normalizeBase(baseUrl);
    if (!base) return { ok: false, error: 'No Confluence base URL configured.' };

    return await new Promise((resolve) => {
      let settled = false;
      const win = new BrowserWindow({
        width: 1024,
        height: 820,
        title: 'Sign in to Confluence',
        autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
      });

      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { if (!win.isDestroyed()) win.destroy(); } catch { /* noop */ }
        resolve(result);
      };

      const check = async () => {
        if (await hasAuthCookie(base)) finish({ ok: true });
      };

      win.webContents.on('did-navigate', check);
      win.webContents.on('did-frame-navigate', check);
      win.webContents.on('did-finish-load', check);
      win.on('closed', async () => {
        if (settled) return;
        const ok = await hasAuthCookie(base);
        finish(ok ? { ok: true } : { ok: false, error: 'Login window closed before sign-in completed.' });
      });

      win.loadURL(`${base}/wiki`);
    });
  });

  // Report whether a usable session cookie exists.
  ipcMain.handle('confluence:authStatus', async (_event, { baseUrl }) => {
    const base = normalizeBase(baseUrl);
    return { connected: base ? await hasAuthCookie(base) : false };
  });

  // Sign out — clear the session's cookies/storage.
  ipcMain.handle('confluence:logout', async () => {
    try { await sess().clearStorageData(); return { ok: true }; }
    catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
  });

  // Fetch page content + metadata (REST, via API token) and download every
  // attachment via the logged-in session cookies (the only auth the media CDN
  // accepts). The renderer rewrites each <img> to the matching base64 data URI.
  ipcMain.handle('confluence:fetchRunbook', async (_event, { baseUrl, email, apiToken, pageUrl }) => {
    try {
      if (!baseUrl) return { ok: false, error: 'Missing Confluence base URL — configure it in Settings.' };

      const pageId = pageIdFromUrl(pageUrl);
      if (!pageId) return { ok: false, error: 'Could not parse a page ID from that URL.' };

      const base = normalizeBase(baseUrl);
      const wiki = `${base}/wiki`;
      const connected = await hasAuthCookie(base);

      // Page content + attachment list via REST (API token works for REST).
      const headers = { Accept: 'application/json' };
      if (email && apiToken) headers.Authorization = authHeader(email, apiToken);

      const cRes = await fetch(
        `${wiki}/rest/api/content/${pageId}?expand=body.export_view,body.storage,version,history,space`,
        { headers },
      );
      if (cRes.status === 401) return { ok: false, error: 'Auth failed (401) — check email / API token, or Connect Confluence.' };
      if (cRes.status === 404) return { ok: false, error: 'Page not found (404) — check the URL / access.' };
      if (!cRes.ok) return { ok: false, error: `Confluence responded ${cRes.status}.` };
      const c = await cRes.json();

      const html = (c.body && c.body.export_view && c.body.export_view.value) ||
                   (c.body && c.body.storage && c.body.storage.value) || '';

      // Token-auth JSON GET (REST API token); pairs with sessGetJson (cookies).
      const tokenGetJson = async (u) => {
        try {
          const r = await fetch(u, { headers });
          return r.ok ? { ok: true, status: r.status, json: await r.json() } : { ok: false, status: r.status };
        } catch (err) { return { ok: false, status: 0, error: (err && err.message) || String(err) }; }
      };

      // Page v1 child/attachment with a given JSON getter → download descriptors.
      const listV1 = async (getJson) => {
        const out = [];
        let next = `/rest/api/content/${pageId}/child/attachment?limit=100&expand=extensions`;
        let guard = 0;
        while (next && guard < 20 && out.length < 300) {
          guard += 1;
          const res = await getJson(`${wiki}${next}`);
          attDebug.listStatus = res.status;
          if (!res.ok) break;
          const a = res.json || {};
          for (const att of (a.results || [])) {
            const dl = att && att._links && att._links.download;
            if (!dl) continue;
            out.push({
              title: att.title,
              absolute: dl.startsWith('http') ? dl : `${wiki}${dl}`,
              id: att.id != null ? String(att.id) : undefined,
              fileId: (att.extensions && att.extensions.fileId) ? String(att.extensions.fileId) : undefined,
            });
          }
          next = (a._links && a._links.next) || null;
        }
        return out;
      };

      // Phase 1: list attachments. The signed-in user (session cookies) usually
      // sees more attachments than the REST API token — list via the session
      // first, fall back to the token only if the session sees nothing.
      const attDebug = { connected, listStatus: 0, listed: 0, downloaded: 0, firstErr: undefined };
      let pending = await listV1(sessGetJson);
      attDebug.sessListed = pending.length;
      if (pending.length === 0) {
        pending = await listV1(tokenGetJson);
        attDebug.tokenListed = pending.length;
      }
      attDebug.listed = pending.length;
      const toDownload = pending.slice(0, 300);

      // Download attachment bytes with the API token (Basic auth) — it has the
      // access the browser session lacks here. Fall back to session cookies (for
      // anonymously-downloadable assets like macro icons).
      const dlHeaders = {
        Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8',
        ...(headers.Authorization ? { Authorization: headers.Authorization } : {}),
      };
      const downloadImage = async (url) => {
        const t = await fetchImageWithHeaders(url, dlHeaders);
        if (t.ok) return t;
        const s = await fetchImageViaSession(url);
        return s.ok ? s : t; // surface the token error if both fail
      };

      // Phase 2: download attachment bytes in parallel (bounded concurrency) —
      // this is the dominant cost; serial fetching made loads take 15-30s+.
      const downloaded = await mapPool(toDownload, 8, async (att) => {
        const r = await downloadImage(att.absolute);
        return { att, r };
      });

      const attachments = [];
      for (const { att, r } of downloaded) {
        if (!r.ok) {
          if (attDebug.firstErr === undefined) {
            attDebug.firstErr = `${att.title}: status ${r.status}${r.notImage ? ' (not-image)' : ''}`;
          }
          continue;
        }
        attDebug.downloaded += 1;
        attachments.push({
          filename: att.title,
          mediaType: r.mime,
          isImage: true,
          dataUri: `data:${r.mime};base64,${r.buf.toString('base64')}`,
          id: att.id,
          fileId: att.fileId,
        });
      }

      // Phase 3: editor "media" images frequently aren't returned by
      // child/attachment (REST may list only macro icons). Pull every <img>
      // download URL straight from the page HTML and fetch it via the SAME
      // session that worked above, then key it by its source URL.
      const haveNames = new Set(attachments.map(a => String(a.filename).toLowerCase()));
      const seenUrls = new Set();
      const htmlImgs = [];
      const imgRe = /<img\b[^>]*?\ssrc=["']([^"']+)["']/gi;
      let m;
      while ((m = imgRe.exec(html)) !== null) {
        const u = m[1].replace(/&amp;/g, '&');
        if (!/^https?:\/\//i.test(u) || seenUrls.has(u)) continue;
        const base = decodeURIComponent((u.split('?')[0].split('/').pop()) || '');
        if (!base || haveNames.has(base.toLowerCase())) continue; // already have it via REST
        // The container page id is embedded in /download/attachments/{id}/…
        const cidMatch = u.match(/\/download\/attachments\/(\d+)\//);
        seenUrls.add(u);
        htmlImgs.push({ url: u, base, cid: cidMatch ? cidMatch[1] : pageId });
      }

      // A bare /wiki/download/attachments/…?api=v2 URL 403s for non-browser
      // clients; the signed _links.download (with version/modificationDate) does
      // not. Look that up per filename (session cookies first, then token), then
      // download the signed link.
      const resolveSignedDownload = async (containerId, name) => {
        const q = `${wiki}/rest/api/content/${containerId}/child/attachment?filename=${encodeURIComponent(name)}&expand=version`;
        for (const getJson of [sessGetJson, tokenGetJson]) {
          const res = await getJson(q);
          if (!res.ok) continue;
          const att = ((res.json && res.json.results) || [])[0];
          const dl = att && att._links && att._links.download;
          if (dl) return dl.startsWith('http') ? dl : `${wiki}${dl}`;
        }
        return null;
      };

      // One-shot probe of the first unmatched image — pins exactly which path
      // (session vs token list, signed vs raw download) works, so we stop guessing.
      if (htmlImgs[0]) {
        const it = htmlImgs[0];
        const q = `${wiki}/rest/api/content/${it.cid}/child/attachment?filename=${encodeURIComponent(it.base)}`;
        const sf = await sessGetJson(q);
        const tf = await tokenGetJson(q);
        const cnt = (res) => (res.ok && res.json && res.json.results) ? res.json.results.length : 0;
        const signed = await resolveSignedDownload(it.cid, it.base);
        const rawDl = await fetchImageViaSession(it.url);
        const signedDl = signed ? await fetchImageViaSession(signed) : null;
        attDebug.probe = {
          base: it.base,
          sessFilename: `${sf.status}/${cnt(sf)}`,
          tokenFilename: `${tf.status}/${cnt(tf)}`,
          signedUrl: signed ? 'found' : 'none',
          rawDownload: `${rawDl.status}${rawDl.ok ? ' OK' : rawDl.notImage ? ' notImage' : ''}`,
          signedDownload: signedDl ? `${signedDl.status}${signedDl.ok ? ' OK' : signedDl.notImage ? ' notImage' : ''}` : 'n/a',
        };
      }

      const htmlDownloaded = await mapPool(htmlImgs, 6, async (it) => {
        const signed = await resolveSignedDownload(it.cid, it.base);
        const r = await downloadImage(signed || it.url);
        return { it, r };
      });
      for (const { it, r } of htmlDownloaded) {
        attDebug.listed += 1;
        if (!r.ok) {
          if (attDebug.firstErr === undefined) {
            attDebug.firstErr = `${it.base}: status ${r.status}${r.notImage ? ' (not-image)' : ''}`;
          }
          continue;
        }
        attDebug.downloaded += 1;
        attachments.push({
          filename: it.base,
          mediaType: r.mime,
          isImage: true,
          dataUri: `data:${r.mime};base64,${r.buf.toString('base64')}`,
          srcUrl: it.url,
        });
      }

      return {
        ok: true,
        connected,
        pageId,
        url: pageUrl,
        title: c.title,
        version: c.version && c.version.number,
        author:
          (c.history && c.history.createdBy && c.history.createdBy.displayName) ||
          (c.version && c.version.by && c.version.by.displayName) ||
          '',
        when: (c.version && c.version.when) || '',
        spaceKey: (c.space && c.space.key) || '',
        html,
        attachments,
        attDebug,
      };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // Fetch arbitrary image URLs via session cookies (renderer fallback).
  ipcMain.handle('confluence:fetchImages', async (_event, { urls }) => {
    const list = Array.isArray(urls) ? urls : [];
    const results = await Promise.all(list.map(async (url) => {
      const r = await fetchImageViaSession(url);
      if (r.ok) {
        return { url, ok: true, status: r.status, mediaType: r.mime, isImage: true, dataUri: `data:${r.mime};base64,${r.buf.toString('base64')}` };
      }
      const textHead = r.notImage && r.buf ? r.buf.toString('utf8', 0, Math.min(r.buf.length, 160)) : undefined;
      return { url, ok: false, status: r.status, error: textHead ? 'not-an-image' : 'fetch-failed', textHead };
    }));
    return { results };
  });

  // Write the full-quality summary HTML to a file and open it (bypasses the
  // clipboard/Teams paste-size limit; attach the file or print to PDF).
  ipcMain.handle('confluence:saveSummary', async (_event, { html, title }) => {
    try {
      const safe = String(title || 'release-summary').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'release-summary';
      const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${safe}</title></head>` +
        `<body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;max-width:900px;margin:24px auto;padding:0 16px">${html}</body></html>`;
      const dir = path.join(os.homedir(), 'Downloads');
      const target = fs.existsSync(dir) ? dir : os.tmpdir();
      const filepath = path.join(target, `${safe}.html`);
      fs.writeFileSync(filepath, doc, 'utf8');
      shell.openPath(filepath);
      return { ok: true, path: filepath };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });
};
