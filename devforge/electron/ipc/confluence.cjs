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
    const res = await sess().fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = sniffImageMime(buf);
    if (!mime) return { ok: false, status: res.status, notImage: true, buf };
    return { ok: true, status: res.status, mime, buf };
  } catch (err) {
    return { ok: false, status: 0, error: (err && err.message) || String(err) };
  }
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

      // Download attachments via session cookies.
      const attachments = [];
      const attDebug = { connected, listStatus: 0, listed: 0, downloaded: 0, firstErr: undefined };
      let next = `/rest/api/content/${pageId}/child/attachment?limit=50&expand=extensions`;
      let guard = 0;
      while (next && guard < 20 && attachments.length < 300) {
        guard += 1;
        const aRes = await fetch(`${wiki}${next}`, { headers });
        attDebug.listStatus = aRes.status;
        if (!aRes.ok) break;
        const a = await aRes.json();
        const items = a.results || [];
        attDebug.listed += items.length;
        for (const att of items) {
          const dl = att && att._links && att._links.download;
          if (!dl) continue;
          const absolute = dl.startsWith('http') ? dl : `${wiki}${dl}`;
          const r = await fetchImageViaSession(absolute);
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
            id: att.id != null ? String(att.id) : undefined,
            fileId: (att.extensions && att.extensions.fileId) ? String(att.extensions.fileId) : undefined,
          });
        }
        next = (a._links && a._links.next) || null;
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
