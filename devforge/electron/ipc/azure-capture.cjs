// ipc/azure-capture.cjs — Azure Chart Capture IPC handlers (Puppeteer)
// Registered in main.js via:  require('./ipc/azure-capture.cjs')(mainWindow)

'use strict';

const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');

// Uses puppeteer-core (no bundled Chromium) and finds an installed browser automatically.
// Install with:  npm install puppeteer-core
async function getPuppeteer() {
    const mod = await import('puppeteer-core');
    return mod.default ?? mod;
}

// Find an installed Chromium-based browser to use with puppeteer-core.
// Checks Edge (Windows default) then common Chrome paths.
function findBrowser() {
    const candidates = [
        // Edge — default on Windows
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        // Chrome
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        // macOS
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        // Linux
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// electron-store v9+ is ESM-only — use a plain JSON file for settings instead
const SETTINGS_FILE = path.join(app.getPath('userData'), 'azure-settings.json');

function readSettings() {
    try {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function writeSettings(incoming) {
    const current = readSettings();
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...current, ...incoming }, null, 2), 'utf8');
}

function getSetting(key, fallback) {
    return readSettings()[key] ?? fallback;
}
const AUTH_FILE = path.join(app.getPath('userData'), 'azure-auth.json');
const SHOTS_DIR = path.join(app.getPath('userData'), 'azure-screenshots');
fs.mkdirSync(SHOTS_DIR, { recursive: true });

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Azure Portal uses MSAL which stores its token cache in sessionStorage.
// We must capture cookies + sessionStorage (not localStorage) to restore a session.

async function saveAuthState(page) {
    const cookies = await page.cookies();

    // Capture sessionStorage — this is where MSAL keeps its token cache
    const sessionStorage = await page.evaluate(() => {
        const data = {};
        for (let i = 0; i < window.sessionStorage.length; i++) {
            const key = window.sessionStorage.key(i);
            data[key] = window.sessionStorage.getItem(key);
        }
        return data;
    });

    // Also capture localStorage as a fallback (some Azure tenants use it)
    const localStorage = await page.evaluate(() => {
        const data = {};
        for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            data[key] = window.localStorage.getItem(key);
        }
        return data;
    });

    fs.writeFileSync(
        AUTH_FILE,
        JSON.stringify({ cookies, sessionStorage, localStorage }, null, 2),
        'utf8',
    );
}

async function loadAuthState(page) {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8');
    const { cookies, sessionStorage, localStorage } = JSON.parse(raw);

    // Restore cookies first
    if (cookies?.length) {
        await page.setCookie(...cookies);
    }

    // Restore sessionStorage (MSAL token cache) 
    // Wait for the browser to be on the origin, then inject safely.
    if (sessionStorage && Object.keys(sessionStorage).length) {
        await page.evaluate((data) => {
            for (const [key, value] of Object.entries(data)) {
                // Keep only MSAL/ADAL auth keys. Filter out Azure Portal's UI/dashboard cache
                if (key.match(/msal|adal|token|login|auth|account/i) || key.includes('-') && key.length >= 30) {
                    window.sessionStorage.setItem(key, String(value));
                }
            }
        }, sessionStorage);
    }

    // IMPORTANT: Deliberately do NOT restore localStorage.
    // Azure Portal UI aggressively caches `fxs-last-dashboard` and other layout state heavily in localStorage.
    // Injecting it causes the portal to bypass the URL and force-load the last viewed dashboard.
}

// Returns true if the current page is still on an MS login/MFA page
async function isOnLoginPage(page) {
    try {
        // Microsoft login pages always have this input
        await page.waitForSelector('input[name="loginfmt"], input[name="passwd"], #idSIButton9', {
            timeout: 4000,
        });
        return true;
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = function registerAzureCaptureHandlers(win) {

    function info(msg) {
        console.log(msg);
        win.webContents.send('azure:log', `info: ${msg}`);
    }

    function warn(msg) {
        console.warn(msg);
        win.webContents.send('azure:log', `warn: ${msg}`);
    }

    function error(msg) {
        console.error(msg);
        win.webContents.send('azure:log', `error: ${msg}`);
    }
    // ── azure:auth-exists ──────────────────────────────────────────────────────
    ipcMain.handle('azure:auth-exists', () => fs.existsSync(AUTH_FILE));

    // ── azure:save-auth ────────────────────────────────────────────────────────
    // Only needs portal.azure.com — dashboard URL is NOT required for authentication.
    // Dashboard URL is only used during capture to navigate to the specific dashboard.
    ipcMain.handle('azure:save-auth', async (_e, cfg = {}) => {
        const timezone = getSetting('timezone', 'Asia/Singapore');
        const maxWait = Number(cfg.waitSeconds || getSetting('waitSeconds', 120)) * 1000;

        // Always sign in via the portal home — no dashboard URL needed
        const portalUrl = 'https://portal.azure.com';

        let browser;
        try {
            info('Launching browser for MFA login...');
            const puppeteer = await getPuppeteer();
            const executablePath = getSetting('browserPath') || findBrowser();
            if (!executablePath) throw new Error('No browser found. Set a browser path in Settings.');
            info(`Using browser: ${executablePath}`);
            browser = await puppeteer.launch({
                headless: false,
                executablePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--window-size=1440,900',
                ],
                defaultViewport: null,
            });

            const page = await browser.newPage();
            await page.emulateTimezone(timezone);

            info(`Navigating to: ${portalUrl}`);
            await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

            warn('Please complete MFA in the browser window...');
            info('Waiting for Azure Portal to load after sign-in...');

            const deadline = Date.now() + maxWait;
            let portalLoaded = false;

            while (Date.now() < deadline) {
                await new Promise(res => setTimeout(res, 3000));

                const currentUrl = page.url();
                const remaining = Math.round((deadline - Date.now()) / 1000);

                if (currentUrl.includes('login.microsoftonline.com') ||
                    currentUrl.includes('login.microsoft.com')) {
                    warn(`Still on sign-in page... ${remaining}s remaining`);
                    continue;
                }

                try {
                    await page.waitForSelector(
                        '.fxs-tile, .fxs-blade, .fxs-topbar, #fxshell-container, [data-telemetryid]',
                        { timeout: 4000 },
                    );
                    portalLoaded = true;
                    break;
                } catch {
                    warn(`Portal loading... ${remaining}s remaining`);
                }
            }

            if (!portalLoaded) {
                error('Timed out waiting for Azure Portal to load.');
                await browser.close();
                win.webContents.send('azure:done', { success: false });
                return { success: false, error: 'Timed out' };
            }

            // Give MSAL a moment to write its token cache to sessionStorage
            await new Promise(res => setTimeout(res, 2000));

            await saveAuthState(page);
            info('Auth saved — cookies + sessionStorage captured');
            await browser.close();
            win.webContents.send('azure:done', { success: true });
            return { success: true };
        } catch (err) {
            error(`${err.message}`);
            if (browser) await browser.close().catch(() => { });
            win.webContents.send('azure:done', { success: false });
            return { success: false, error: err.message };
        }
    });

    // ── azure:capture ──────────────────────────────────────────────────────────
    ipcMain.handle('azure:capture', async (_e, cfg = {}) => {
        const dashUrl = cfg.dashboardUrl || getSetting('dashboardUrl') || process.env.AZURE_DASHBOARD_URL;
        const timezone = getSetting('timezone', 'Asia/Singapore');
        const hiDpi = getSetting('hiDpi', true);

        if (!fs.existsSync(AUTH_FILE)) {
            error('azure-auth.json not found — run Save Auth first.');
            win.webContents.send('azure:done', { success: false });
            return { success: false };
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const folder = path.join(SHOTS_DIR, timestamp);
        fs.mkdirSync(folder, { recursive: true });

        let browser;
        try {
            info('Launching headless browser...');
            const puppeteer = await getPuppeteer();
            const executablePath = getSetting('browserPath') || findBrowser();
            if (!executablePath) throw new Error('No browser found. Set a browser path in Settings.');
            browser = await puppeteer.launch({
                headless: true,          // ← invisible — auth is already saved
                executablePath,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--window-size=1920,1080',
                ],
                defaultViewport: {
                    width: 1920,
                    height: 1080,
                    deviceScaleFactor: hiDpi ? 2 : 1,
                },
            });

            const page = await browser.newPage();
            await page.emulateTimezone(timezone);

            // Read auth state
            info('Injecting auth session...');
            const authRaw = fs.readFileSync(AUTH_FILE, 'utf8');
            const authData = JSON.parse(authRaw);

            // Step 1: Pre-set cookies (can be set before navigating to the domain)
            if (authData.cookies?.length) {
                await page.setCookie(...authData.cookies);
            }

            // Step 2: Navigate DIRECTLY to the dashboard URL (not portal.azure.com first!)
            // This ensures the SPA loads with the correct dashboard from the start
            info(`Opening dashboard: ${dashUrl}`);
            await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            // Step 3: Check if we landed on the login page (session expired)
            if (await isOnLoginPage(page)) {
                warn('Session expired — re-run Save Auth.');
                await browser.close();
                win.webContents.send('azure:done', { success: false });
                return { success: false };
            }

            // Step 4: Now that we're on portal.azure.com, inject MSAL auth safely
            await loadAuthState(page);

            // Step 5: Reload so the portal picks up the injected auth WITH the correct URL
            info('Reloading with auth...');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

            // Check login again after reload
            if (await isOnLoginPage(page)) {
                warn('Session expired — re-run Save Auth.');
                await browser.close();
                win.webContents.send('azure:done', { success: false });
                return { success: false };
            }

            // Wait for charts to appear
            info('Waiting for dashboard charts...');
            await page.waitForSelector('.fxc-monitorchartv2-chart', { timeout: 60000 });

            const charts = await page.$$('.fxc-monitorchartv2-chart');
            info(`Found ${charts.length} charts`);

            // Extract title for each chart by walking up to its parent .fxs-tile
            const tileTitles = await page.evaluate(() => {
                const titles = [];
                document.querySelectorAll('.fxc-monitorchartv2-chart').forEach((chartEl, i) => {
                    // Walk up to the containing .fxs-tile
                    const tile = chartEl.closest('.fxs-tile');
                    const titleEl = tile?.querySelector('.fxc-monitorchartv2-title.msportalfx-tooltip-overflow')
                        || tile?.querySelector('.fxc-monitorchartv2-title');
                    titles.push(titleEl ? titleEl.innerText.trim() : `Chart ${i + 1}`);
                });
                return titles;
            });

            tileTitles.forEach((t, i) => info(`Chart ${i + 1}: ${t}`));

            // Extract legend data aligned to each chart element EXACTLY 1:1 with charts array
            const allLegends = await page.evaluate(() => {
                const results = [];
                document.querySelectorAll('.fxc-monitorchartv2-chart').forEach((chartEl) => {
                    const tile = chartEl.closest('.fxs-tile');
                    const legends = [];
                    if (tile) {
                        tile.querySelectorAll('.fxc-monitorchart-legend').forEach(leg => {
                            const metricEl = leg.querySelector('.fxc-monitorchart-metric');
                            const valueEl = leg.querySelector('.fxc-monitorchart-value');

                            // Use textContent instead of innerText because Azure Portal sometimes 
                            // hides or obscures the exact text rendering from Puppeteer.
                            const metric = metricEl ? (metricEl.textContent || '').trim() : '';
                            const value = valueEl ? (valueEl.textContent || '').trim() : '';

                            if (metric || value) legends.push({ metric, value });
                        });
                    }
                    results.push(legends);
                });
                return results;
            });

            allLegends.forEach((legends, i) => {
                if (legends.length > 0) {
                    legends.forEach(l => info(`Chart ${i + 1}: ${l.metric} = ${l.value}`));
                }
            });

            // Screenshot each .fxc-monitorchartv2-charts element directly —
            // scroll it into view first so Azure renders the chart SVG before capture
            info(`Capturing ${charts.length} charts...`);
            for (let i = 0; i < charts.length; i++) {
                const chartTitle = tileTitles[i] || `Chart ${i + 1}`;
                try {
                    await charts[i].scrollIntoView();

                    // The SVG container has opacity:0.2 while loading and opacity:1 when done.
                    // Wait for it to reach full opacity before screenshotting.
                    await page.waitForFunction(
                        (el) => {
                            const svg = el.querySelector('[id$="svgContainer"]');
                            if (!svg) return false;
                            return svg.style.opacity === '1' || svg.style.opacity === '';
                        },
                        { timeout: 30000 },
                        charts[i],
                    ).catch(() => {
                        // no svgContainer found — proceed anyway
                    });

                    await new Promise(res => setTimeout(res, 300));
                    await charts[i].screenshot({ path: path.join(folder, `tile_${i + 1}.png`) });
                    info(`Capturing ${chartTitle} ${i + 1}/${charts.length}`);
                } catch (err) {
                    error(`${chartTitle} (${i + 1}) failed: ${err.message}`);
                }
            }

            if (allLegends.some(l => l.length > 0)) {
                let txt = '';
                allLegends.forEach((legends, i) => {
                    if (legends.length === 0) return;
                    txt += `${tileTitles[i] || `Chart ${i + 1}`} legends:\n`;
                    legends.forEach((l, idx) => {
                        txt += `  ${idx + 1}. ${l.metric} = ${l.value}\n`;
                    });
                });
                fs.writeFileSync(path.join(folder, 'statistic.txt'), txt, 'utf8');
                info('Legends written to statistic.txt');
            }

            const titleMap = {};
            const legendMap = {};
            tileTitles.forEach((t, i) => {
                const fname = `tile_${i + 1}.png`;
                titleMap[fname] = t;
                legendMap[fname] = allLegends[i] || [];
            });
            fs.writeFileSync(path.join(folder, 'titles.json'), JSON.stringify(titleMap, null, 2), 'utf8');
            fs.writeFileSync(path.join(folder, 'legends.json'), JSON.stringify(legendMap, null, 2), 'utf8');
            info('Titles and Legends saved to json mapping files');

            // Save session config (e.g., the URL used)
            fs.writeFileSync(path.join(folder, 'config.json'), JSON.stringify({ url: dashUrl }, null, 2), 'utf8');

            info(`Captured ${charts.length} charts into: ${folder}`);
            await browser.close();
            win.webContents.send('azure:done', { success: true, session: timestamp });
            return { success: true, session: timestamp };
        } catch (err) {
            error(`${err.message}`);
            if (browser) await browser.close().catch(() => { });
            win.webContents.send('azure:done', { success: false });
            return { success: false, error: err.message };
        }
    });

    // ── azure:get-sessions ─────────────────────────────────────────────────────
    ipcMain.handle('azure:get-sessions', () => {
        if (!fs.existsSync(SHOTS_DIR)) return [];
        return fs.readdirSync(SHOTS_DIR)
            .filter(d => fs.statSync(path.join(SHOTS_DIR, d)).isDirectory())
            .sort()
            .reverse()
            .map(d => {
                let url = null;
                const cp = path.join(SHOTS_DIR, d, 'config.json');
                if (fs.existsSync(cp)) {
                    try { url = JSON.parse(fs.readFileSync(cp, 'utf8')).url; } catch { }
                }
                return { id: d, url };
            });
    });

    // ── azure:clear-sessions ───────────────────────────────────────────────────
    ipcMain.handle('azure:clear-sessions', () => {
        if (fs.existsSync(SHOTS_DIR)) {
            fs.rmSync(SHOTS_DIR, { recursive: true, force: true });
        }
    });

    // ── azure:get-tiles  →  real PNGs as base64 data URLs ─────────────────────
    ipcMain.handle('azure:get-tiles', (_e, session) => {
        const folder = path.join(SHOTS_DIR, session);
        if (!fs.existsSync(folder)) return { images: [], stats: null };

        // Load titles.json if it exists
        let titleMap = {};
        const titlesPath = path.join(folder, 'titles.json');
        if (fs.existsSync(titlesPath)) {
            try { titleMap = JSON.parse(fs.readFileSync(titlesPath, 'utf8')); } catch { }
        }

        // Load legends.json if it exists
        let legendMap = {};
        const legendsPath = path.join(folder, 'legends.json');
        if (fs.existsSync(legendsPath)) {
            try { legendMap = JSON.parse(fs.readFileSync(legendsPath, 'utf8')); } catch { }
        }

        const images = fs.readdirSync(folder)
            .filter(f => f.endsWith('.png'))
            .sort((a, b) => {
                const n = s => parseInt(s.match(/\d+/)?.[0] ?? 0);
                return n(a) - n(b);
            })
            .map(f => ({
                name: f,
                title: titleMap[f] || null,
                legends: legendMap[f] || [],
                src: 'data:image/png;base64,' + fs.readFileSync(path.join(folder, f)).toString('base64'),
            }));

        let stats = null;
        const sp = path.join(folder, 'statistic.txt');
        if (fs.existsSync(sp)) stats = fs.readFileSync(sp, 'utf8');

        let url = null;
        const cp = path.join(folder, 'config.json');
        if (fs.existsSync(cp)) {
            try { url = JSON.parse(fs.readFileSync(cp, 'utf8')).url; } catch { }
        }

        return { images, stats, url };
    });

    // ── azure:get-settings / azure:save-settings ───────────────────────────────
    ipcMain.handle('azure:get-settings', () => readSettings());

    ipcMain.handle('azure:save-settings', (_e, c) => {
        writeSettings(c);
        return true;
    });
};
