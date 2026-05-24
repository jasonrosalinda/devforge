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

async function fetchBuffer(url, headers) {
    let currentUrl = url;
    let currentHeaders = { ...headers, Accept: '*/*' };
    for (let hops = 0; hops < 6; hops++) {
        const res = await fetch(currentUrl, { headers: currentHeaders, redirect: 'manual' });
        if (res.status >= 200 && res.status < 300) {
            const arr = await res.arrayBuffer();
            return Buffer.from(arr);
        }
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc) throw new Error(`HTTP ${res.status} redirect with no Location for ${currentUrl}`);
            const nextUrl = new URL(loc, currentUrl).toString();
            const sameOrigin = new URL(nextUrl).origin === new URL(currentUrl).origin;
            currentUrl = nextUrl;
            currentHeaders = sameOrigin ? { ...headers, Accept: '*/*' } : { Accept: '*/*' };
            continue;
        }
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${currentUrl}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
    throw new Error(`Too many redirects starting from ${url}`);
}

function trimBaseUrl(baseUrl) {
    return String(baseUrl || '').replace(/\/+$/, '');
}

function rewriteImageSources(html, attachments) {
    if (!html) return html;
    const byTitle = new Map();
    const byTitleLower = new Map();
    const byMediaId = new Map();
    const byId = new Map();
    const byIdNumeric = new Map();
    for (const att of attachments) {
        if (!att.dataUri) continue;
        if (att.title) {
            byTitle.set(att.title, att.dataUri);
            byTitleLower.set(String(att.title).toLowerCase(), att.dataUri);
        }
        if (att.mediaId) byMediaId.set(att.mediaId, att.dataUri);
        if (att.id) {
            byId.set(att.id, att.dataUri);
            const numeric = String(att.id).replace(/^att/, '');
            byIdNumeric.set(numeric, att.dataUri);
        }
    }

    const extractFilename = (urlOrPath) => {
        if (!urlOrPath) return '';
        try {
            const noQuery = urlOrPath.split('?')[0];
            const last = noQuery.split('/').pop() || '';
            return decodeURIComponent(last);
        } catch {
            return '';
        }
    };

    const findByFilename = (raw) => {
        if (!raw) return null;
        if (byTitle.has(raw)) return byTitle.get(raw);
        const lower = raw.toLowerCase();
        if (byTitleLower.has(lower)) return byTitleLower.get(lower);
        return null;
    };

    let totalImgs = 0;
    let matched = 0;
    const unmatchedSamples = [];

    const result = html.replace(/<img\b[^>]*>/gi, (tag) => {
        totalImgs += 1;
        const setSrc = (uri) => {
            matched += 1;
            if (/\bsrc="[^"]*"/i.test(tag)) return tag.replace(/\bsrc="[^"]*"/i, `src="${uri}"`);
            return tag.replace(/<img\b/i, `<img src="${uri}"`);
        };

        const m1 = tag.match(/data-media-id="([^"]+)"/i);
        if (m1 && byMediaId.has(m1[1])) return setSrc(byMediaId.get(m1[1]));

        const m2 = tag.match(/data-linked-resource-id="([^"]+)"/i);
        if (m2) {
            if (byId.has(m2[1])) return setSrc(byId.get(m2[1]));
            if (byIdNumeric.has(m2[1])) return setSrc(byIdNumeric.get(m2[1]));
        }

        const m3 = tag.match(/data-linked-resource-default-alias="([^"]+)"/i);
        if (m3) {
            const hit = findByFilename(m3[1]);
            if (hit) return setSrc(hit);
        }

        const altMatch = tag.match(/\balt="([^"]+)"/i);
        if (altMatch) {
            const hit = findByFilename(altMatch[1]);
            if (hit) return setSrc(hit);
        }

        const imageSrcMatch = tag.match(/data-image-src="([^"]+)"/i);
        if (imageSrcMatch) {
            const fn = extractFilename(imageSrcMatch[1]);
            const hit = findByFilename(fn);
            if (hit) return setSrc(hit);
        }

        const srcMatch = tag.match(/\bsrc="([^"]+)"/i);
        if (srcMatch) {
            const fn = extractFilename(srcMatch[1]);
            const hit = findByFilename(fn);
            if (hit) return setSrc(hit);
        }

        if (unmatchedSamples.length < 3) {
            unmatchedSamples.push(tag.slice(0, 240));
        }
        return tag;
    });

    console.log(`[confluence] rewriteImageSources matched ${matched}/${totalImgs} img tags (attachments cached: ${byTitle.size})`);
    if (unmatchedSamples.length) {
        console.log('[confluence] unmatched img samples:', unmatchedSamples);
    }
    return result;
}

function resolveUrl(baseUrl, link) {
    if (!link) return '';
    if (/^https?:\/\//i.test(link)) return link;
    if (link.startsWith('/wiki/')) return `${baseUrl}${link}`;
    if (link.startsWith('/')) return `${baseUrl}/wiki${link}`;
    return `${baseUrl}/wiki/${link}`;
}

function stripApiV2(url) {
    return url.replace(/([?&])api=v2(&|$)/, (_, before, after) => (after ? before : '')).replace(/[?&]$/, '');
}

async function fetchAttachments(baseUrl, pageId, headers) {
    const url = `${baseUrl}/wiki/rest/api/content/${pageId}/child/attachment?limit=100&expand=version`;
    const data = await fetchJson(url, headers).catch((e) => {
        console.error('[confluence] attachments fetch failed:', e.message);
        return { results: [] };
    });
    const items = Array.isArray(data?.results) ? data.results : [];
    const enriched = [];
    for (const item of items) {
        const mediaType = item.extensions?.mediaType || item.metadata?.mediaType || '';
        const downloadLink = item._links?.download || '';
        const fullUrl = resolveUrl(baseUrl, downloadLink);
        const att = {
            id: item.id,
            title: item.title || `attachment-${item.id}`,
            mediaType,
            mediaId: item.extensions?.fileId || item.metadata?.mediaId || null,
            sizeBytes: typeof item.extensions?.fileSize === 'number' ? item.extensions.fileSize : 0,
            downloadUrl: fullUrl,
            dataUri: null,
        };
        if (mediaType.startsWith('image/') && fullUrl) {
            const candidates = [];
            const legacy = stripApiV2(fullUrl);
            candidates.push(legacy);
            const manual = `${baseUrl}/wiki/download/attachments/${pageId}/${encodeURIComponent(att.title)}`;
            if (!candidates.includes(manual)) candidates.push(manual);
            let lastErr = null;
            for (const candidate of candidates) {
                try {
                    const buf = await fetchBuffer(candidate, headers);
                    att.dataUri = `data:${mediaType};base64,${buf.toString('base64')}`;
                    att.sizeBytes = buf.length;
                    att.downloadUrl = candidate;
                    lastErr = null;
                    break;
                } catch (err) {
                    lastErr = err;
                }
            }
            if (lastErr) {
                console.warn(`[confluence] failed to download attachment "${att.title}":`, lastErr.message);
            }
        }
        enriched.push(att);
    }
    return enriched;
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

            const attachments = await fetchAttachments(trimmed, pageId, headers);
            const rawHtml = page?.body?.view?.value || '';
            const rewrittenHtml = rewriteImageSources(rawHtml, attachments);

            const webUrl = page?._links?.webui ? `${trimmed}/wiki${page._links.webui}` : null;

            return {
                success: true,
                page: {
                    id: page.id,
                    title: page.title,
                    version: page.version?.number ?? null,
                    webUrl,
                },
                html: rewrittenHtml,
                attachments: attachments.map((a) => ({
                    id: a.id,
                    title: a.title,
                    mediaType: a.mediaType,
                    sizeBytes: a.sizeBytes,
                    dataUri: a.dataUri,
                    downloadUrl: a.downloadUrl,
                })),
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
