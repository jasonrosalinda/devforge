'use strict';

const fs = require('fs');
const path = require('path');

const SESSION_PARTITION = 'persist:confluence';

function extractPageId(url) {
    const m = String(url || '').match(/\/pages\/(\d+)/);
    return m ? m[1] : null;
}

function authHeader(email, token) {
    const raw = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
    return `Basic ${raw}`;
}

function getConfluenceSession() {
    const { session } = require('electron');
    return session.fromPartition(SESSION_PARTITION);
}

async function getCookieHeader(baseUrl) {
    try {
        const sess = getConfluenceSession();
        const cookies = await sess.cookies.get({ url: baseUrl });
        if (!cookies.length) return '';
        return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch {
        return '';
    }
}

async function buildAuthHeaders(baseUrl, email, apiToken) {
    const cookieHeader = await getCookieHeader(baseUrl);
    const headers = { Accept: 'application/json' };
    if (cookieHeader) {
        headers.Cookie = cookieHeader;
    } else if (email && apiToken) {
        headers.Authorization = authHeader(email, apiToken);
    }
    return headers;
}

async function fetchJson(url, headers) {
    const res = await fetch(url, { headers });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
    return res.json();
}

function trimBaseUrl(baseUrl) {
    return String(baseUrl || '').replace(/\/+$/, '');
}

const handler = (_mainWindow) => {
    const { ipcMain, clipboard, nativeImage, dialog, BrowserWindow } = require('electron');
    const { importBrowserSession } = require('./confluence-cookies.cjs');

    ipcMain.handle('confluence:try-silent-login', async (_event, opts) => {
        try {
            const { baseUrl } = opts || {};
            const result = await importBrowserSession(trimBaseUrl(baseUrl));
            return result;
        } catch (err) {
            return { success: false, error: err.message || String(err), skipped: { v20: 0, malformed: 0 } };
        }
    });

    ipcMain.handle('confluence:sign-in', async (_event, opts) => {
        try {
            const { baseUrl } = opts || {};
            if (!baseUrl) return { success: false, error: 'Base URL required.' };
            const trimmed = trimBaseUrl(baseUrl);
            const sess = getConfluenceSession();

            return await new Promise((resolve) => {
                const win = new BrowserWindow({
                    width: 1024,
                    height: 768,
                    title: 'Sign in to Confluence',
                    autoHideMenuBar: true,
                    webPreferences: {
                        partition: SESSION_PARTITION,
                        contextIsolation: true,
                        nodeIntegration: false,
                    },
                });
                let resolved = false;
                const done = async (cancelled) => {
                    if (resolved) return;
                    resolved = true;
                    const cookies = await sess.cookies.get({ url: trimmed });
                    resolve({ success: !cancelled, signedIn: cookies.length > 0 });
                };
                win.on('closed', () => done(false));
                win.loadURL(`${trimmed}/wiki/`);
            });
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('confluence:check-session', async (_event, opts) => {
        try {
            const { baseUrl } = opts || {};
            if (!baseUrl) return { signedIn: false };
            const trimmed = trimBaseUrl(baseUrl);
            const sess = getConfluenceSession();
            const cookies = await sess.cookies.get({ url: trimmed });

            let earliestExpiry = null;
            let totalWithExpiry = 0;
            for (const c of cookies) {
                if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
                    totalWithExpiry += 1;
                    if (earliestExpiry == null || c.expirationDate < earliestExpiry) {
                        earliestExpiry = c.expirationDate;
                    }
                }
            }
            const nowSec = Math.floor(Date.now() / 1000);
            const expired = earliestExpiry != null && earliestExpiry <= nowSec;

            return {
                signedIn: cookies.length > 0 && !expired,
                cookieCount: cookies.length,
                earliestExpiry,
                expired,
                hasPersistentCookies: totalWithExpiry > 0,
            };
        } catch (err) {
            return { signedIn: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('confluence:sign-out', async (_event, opts) => {
        try {
            const { baseUrl } = opts || {};
            if (!baseUrl) return { success: false, error: 'Base URL required.' };
            const trimmed = trimBaseUrl(baseUrl);
            const sess = getConfluenceSession();
            const cookies = await sess.cookies.get({ url: trimmed });
            for (const c of cookies) {
                const scheme = c.secure ? 'https' : 'http';
                const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
                const url = `${scheme}://${domain}${c.path || '/'}`;
                try {
                    await sess.cookies.remove(url, c.name);
                } catch {
                    // ignore individual cookie removal failure
                }
            }
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('confluence:fetch-page', async (_event, opts) => {
        try {
            const { url, baseUrl, email, apiToken } = opts || {};
            if (!baseUrl) return { success: false, error: 'Confluence base URL is not configured. Open Settings → API Keys.' };

            const pageId = extractPageId(url);
            if (!pageId) return { success: false, error: 'Could not extract a page ID from the URL. Expect a path like /pages/12345/...' };

            const trimmed = trimBaseUrl(baseUrl);
            const headers = await buildAuthHeaders(trimmed, email, apiToken);
            if (!headers.Cookie && !headers.Authorization) {
                return { success: false, error: 'Not signed in to Confluence and no API token configured. Click "Sign in to Confluence" or add credentials in Settings.' };
            }

            const pageUrl = `${trimmed}/wiki/rest/api/content/${pageId}?expand=body.view,version,space`;
            const page = await fetchJson(pageUrl, headers);
            console.log('[confluence] fetchPage raw API response:', JSON.stringify({
                id: page?.id,
                title: page?.title,
                version: page?.version,
                space: page?.space,
                _links: page?._links,
                bodyViewLength: page?.body?.view?.value?.length ?? 0,
                bodyViewPreview: page?.body?.view?.value?.slice(0, 500),
            }, null, 2));

            const html = page?.body?.view?.value || '';
            const webUrl = page?._links?.webui ? `${trimmed}/wiki${page._links.webui}` : null;

            return {
                success: true,
                page: {
                    id: page.id,
                    title: page.title,
                    version: page.version?.number ?? null,
                    webUrl,
                },
                html,
                attachments: [],
            };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('confluence:copy-to-clipboard', async (_event, opts) => {
        try {
            const { html, text, primaryImageDataUri } = opts || {};
            const payload = {};
            if (typeof html === 'string') payload.html = html;
            if (typeof text === 'string') payload.text = text;
            if (primaryImageDataUri) {
                try {
                    payload.image = nativeImage.createFromDataURL(primaryImageDataUri);
                } catch {
                    // ignore — write text/html only
                }
            }
            clipboard.write(payload);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });

    ipcMain.handle('confluence:save-attachments', async (_event, opts) => {
        try {
            const { attachments, folderName } = opts || {};
            if (!Array.isArray(attachments) || attachments.length === 0) {
                return { success: false, error: 'No attachments to save.' };
            }
            const pick = await dialog.showOpenDialog({
                title: 'Choose a folder to save attachments',
                properties: ['openDirectory', 'createDirectory'],
            });
            if (pick.canceled || !pick.filePaths?.[0]) {
                return { success: false, error: 'Save cancelled.' };
            }
            const baseDir = pick.filePaths[0];
            const safeFolder = String(folderName || 'confluence-page').replace(/[\\/:*?"<>|]/g, '_').trim() || 'confluence-page';
            const outDir = path.join(baseDir, safeFolder);
            if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

            const saved = [];
            for (const att of attachments) {
                if (!att?.dataUri) continue;
                const m = att.dataUri.match(/^data:[^;]+;base64,(.+)$/);
                if (!m) continue;
                const buf = Buffer.from(m[1], 'base64');
                const filename = String(att.title || `attachment-${att.id}`).replace(/[\\/:*?"<>|]/g, '_');
                const filepath = path.join(outDir, filename);
                fs.writeFileSync(filepath, buf);
                saved.push(filepath);
            }
            return { success: true, path: outDir, count: saved.length };
        } catch (err) {
            return { success: false, error: err.message || String(err) };
        }
    });
};

module.exports = handler;
