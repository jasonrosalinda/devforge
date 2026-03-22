'use strict';

const { execSync } = require('child_process');
const { app }      = require('electron');
const path         = require('path');
const fs           = require('fs');
const net          = require('net');

// ─── Browser path detection ───────────────────────────────────────────────────

function getDefaultBrowserPath() {
    try {
        if (process.platform === 'win32') {
            const progId = execSync(
                'reg query HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice /v ProgId',
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
            ).match(/ProgId\s+REG_SZ\s+(\S+)/)?.[1] ?? '';

            console.log(`[Lighthouse] Default browser ProgID: ${progId}`);

            if (progId.includes('Chrome')) {
                return [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
                ].find(p => fs.existsSync(p)) ?? null;
            }
            if (progId.includes('MSEdgeHTM') || progId.includes('Edge')) {
                return [
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                    path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
                ].find(p => fs.existsSync(p)) ?? null;
            }
            if (progId.includes('Brave')) {
                return [
                    path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
                    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                ].find(p => fs.existsSync(p)) ?? null;
            }
            if (progId.includes('Vivaldi')) {
                const p = path.join(process.env.LOCALAPPDATA || '', 'Vivaldi\\Application\\vivaldi.exe');
                return fs.existsSync(p) ? p : null;
            }
            if (progId.includes('Opera')) {
                return [
                    path.join(process.env.LOCALAPPDATA || '', 'Programs\\Opera\\opera.exe'),
                    path.join(process.env.LOCALAPPDATA || '', 'Programs\\Opera GX\\opera.exe'),
                ].find(p => fs.existsSync(p)) ?? null;
            }

        } else if (process.platform === 'darwin') {
            const bundleId = execSync(
                `defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure \
                | grep -A1 '"https"' | grep bundleID | head -1 | awk -F'"' '{print $2}'`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
            ).trim().toLowerCase();

            console.log(`[Lighthouse] Default browser bundle: ${bundleId}`);

            const macMap = {
                'com.google.chrome':       '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                'com.microsoft.edgemac':   '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
                'com.brave.browser':       '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
                'com.operasoftware.opera': '/Applications/Opera.app/Contents/MacOS/Opera',
                'com.vivaldi.vivaldi':     '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
            };
            for (const [id, exePath] of Object.entries(macMap)) {
                if (bundleId.includes(id) && fs.existsSync(exePath)) return exePath;
            }

        } else {
            const browserCmd = execSync(
                'xdg-settings get default-web-browser 2>/dev/null || true',
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
            ).trim().toLowerCase();

            console.log(`[Lighthouse] Default browser desktop file: ${browserCmd}`);

            if (browserCmd.includes('chrome'))  return '/usr/bin/google-chrome-stable';
            if (browserCmd.includes('edge'))    return '/usr/bin/microsoft-edge-stable';
            if (browserCmd.includes('brave'))   return '/usr/bin/brave-browser';
            if (browserCmd.includes('opera'))   return '/usr/bin/opera';
            if (browserCmd.includes('vivaldi')) return '/usr/bin/vivaldi-stable';
        }
    } catch (err) {
        console.warn('[Lighthouse] Could not detect default browser:', err.message);
    }
    return null;
}

function findChromePath() {
    const defaultBrowser = getDefaultBrowserPath();
    if (defaultBrowser) {
        console.log(`[Lighthouse] Using default browser: ${defaultBrowser}`);
        return defaultBrowser;
    }
    console.log('[Lighthouse] Default browser not Chromium-based — falling back to Chrome search');
    const candidates = process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ]
        : process.platform === 'darwin'
            ? [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium',
            ]
            : [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
            ];
    return candidates.find(p => fs.existsSync(p)) ?? null;
}

function getLighthouseProfileDir() {
    const dir = path.join(app.getPath('userData'), 'lighthouse-profile');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ─── Port utilities ───────────────────────────────────────────────────────────

function waitForPort(port, { retries = 20, intervalMs = 500 } = {}) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const tryConnect = () => {
            const socket = new net.Socket();
            socket.once('connect', () => { socket.destroy(); resolve(); });
            socket.once('error', () => {
                socket.destroy();
                attempts++;
                if (attempts >= retries) {
                    reject(new Error(`Chrome debugger port ${port} did not open after ${retries} attempts.`));
                } else {
                    setTimeout(tryConnect, intervalMs);
                }
            });
            socket.connect(port, '127.0.0.1');
        };
        tryConnect();
    });
}

// ─── Chrome instance management ──────────────────────────────────────────────

const BASE_FLAGS = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--window-size=1350,940',
    '--window-position=-32000,-32000'
];

const REPEAT_VISITOR_FLAGS = [
    '--enable-features=WasmCodeCache,WasmLazyCompilation,WasmTieringUpToTopTier',
    '--v8-cache-options=code',
];

let coldChrome     = null;
let coldChromePort = null;
let warmChrome     = null;
let warmChromePort = null;

async function getOrLaunchChrome(visitMode) {
    const isCold  = visitMode === 'cold';
    const current = isCold ? coldChrome     : warmChrome;
    const port    = isCold ? coldChromePort : warmChromePort;

    if (current) {
        try {
            await waitForPort(port, { retries: 3, intervalMs: 200 });
            console.log(`[Lighthouse][${visitMode}] Reusing browser on port ${port}`);
            return current;
        } catch {
            console.log(`[Lighthouse][${visitMode}] Browser unresponsive — relaunching...`);
            if (isCold) { coldChrome = null; coldChromePort = null; }
            else        { warmChrome = null; warmChromePort = null; }
        }
    }

    const { launch } = await import('chrome-launcher');
    const chromePath = findChromePath();

    if (!chromePath) throw new Error(
        'Could not find a Chromium-based browser. Please install Google Chrome, Edge, or Brave.'
    );

    const profileDir = isCold ? undefined : getLighthouseProfileDir();

    const chrome = await launch({
        chromePath,
        chromeFlags: isCold ? BASE_FLAGS : [...BASE_FLAGS, ...REPEAT_VISITOR_FLAGS],
        ...(profileDir && { userDataDir: profileDir }),
    });

    if (isCold) { coldChrome = chrome; coldChromePort = chrome.port; }
    else        { warmChrome = chrome; warmChromePort = chrome.port; }

    await waitForPort(chrome.port, { retries: 20, intervalMs: 500 });
    console.log(`[Lighthouse][${visitMode}] Browser ready on port ${chrome.port}`);

    return chrome;
}

function killChrome(visitMode) {
    const isCold = visitMode === 'cold';
    const chrome = isCold ? coldChrome : warmChrome;
    if (!chrome) return;
    try { chrome.kill(); } catch { /* ignore */ }
    if (isCold) { coldChrome = null; coldChromePort = null; }
    else        { warmChrome = null; warmChromePort = null; }
    console.log(`[Lighthouse][${visitMode}] Browser killed.`);
}

async function killChromeAndWait(visitMode) {
    const isCold = visitMode === 'cold';
    const chrome = isCold ? coldChrome : warmChrome;
    if (!chrome) return;
    try { chrome.kill(); } catch { /* ignore */ }
    if (isCold) { coldChrome = null; coldChromePort = null; }
    else        { warmChrome = null; warmChromePort = null; }
    console.log(`[Lighthouse][${visitMode}] Browser killed — waiting for file handles to release...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
}

async function killAllChromeAndWait() {
    await killChromeAndWait('cold');
    await killChromeAndWait('warm');
}

function getWarmChromePort() { return warmChromePort; }

async function clearLighthouseProfile() {
    const profileDir = getLighthouseProfileDir();
    let retries = 5;
    while (retries > 0) {
        try {
            fs.rmSync(profileDir, { recursive: true, force: true });
            fs.mkdirSync(profileDir, { recursive: true });
            console.log('[Lighthouse] Profile cache cleared.');
            return { success: true };
        } catch (err) {
            retries--;
            if (retries === 0) {
                console.error('[Lighthouse] Failed to clear profile after all retries:', err.message);
                return { success: false, error: err.message };
            }
            console.warn(`[Lighthouse] Profile still locked — retrying in 2s... (${retries} left)`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

module.exports = {
    findChromePath,
    getLighthouseProfileDir,
    waitForPort,
    getOrLaunchChrome,
    killChrome,
    killChromeAndWait,
    killAllChromeAndWait,
    getWarmChromePort,
    clearLighthouseProfile,
};
