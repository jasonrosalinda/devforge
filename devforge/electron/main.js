import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine if we're in development
const isDev = !app.isPackaged;

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'devForge',
        icon: path.join(__dirname, '../public/icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        // Frameless with custom title bar look
        titleBarStyle: 'default',
        backgroundColor: '#09090b', // matches dark theme background
        show: false, // prevent white flash
    });

    // Show window when ready to prevent white flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Open external links in the default browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    if (isDev) {
        // In development, load from Vite dev server
        const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
        mainWindow.loadURL(VITE_DEV_SERVER_URL);
        // Open DevTools in development
        mainWindow.webContents.openDevTools();
    } else {
        // In production, load the built files
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

// App lifecycle
app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        // On macOS, re-create a window when dock icon is clicked
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // On macOS, apps stay active until Cmd+Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

import lighthouse from 'lighthouse';
import { parseToPageSpeedInsightResult, buildErrorPageSpeedInsightResult } from './utils/pageSpeedAuditParser.js';

ipcMain.handle("run-lighthouse", async (event, { url, strategy }) => {
    let chrome;
    try {
        // ✅ Standardizing the dynamic import for ESM compatibility
        const { launch } = await import("chrome-launcher");

        chrome = await launch({
            chromeFlags: [
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",  // ✅ prevents memory issues
                "--disable-extensions",      // ✅ faster startup
                "--no-first-run",            // ✅ skip chrome setup
                "--no-default-browser-check",
            ]
        });

        // Lighthouse often prefers being called as a function in ESM
        const result = await lighthouse(url, {
            port: chrome.port,
            output: "json",
            formFactor: strategy,
            screenEmulation: {
                mobile: strategy === 'mobile',
                width: strategy === 'mobile' ? 360 : 1350,
                height: strategy === 'mobile' ? 640 : 940,
            },
            onlyCategories: ["performance"],

            // ✅ increase timeout
            maxWaitForLoad: 60000,        // 60s (default is 45s)
            maxWaitForFcp: 30000,         // wait longer for First Contentful Paint

            // ✅ skip slow extras
            skipAudits: [
                'screenshot-thumbnails',
                'final-screenshot',
                'full-page-screenshot',
            ],
        });

        if (!result) throw new Error("Lighthouse failed to produce a result.");

        if (result.lhr.runtimeError) throw new Error(result.lhr.runtimeError.message);

        return parseToPageSpeedInsightResult(url, result.lhr.audits, result.lhr.runWarnings?.[0]);
    } catch (err) {
        console.error("Lighthouse Error:", err.message);
        return buildErrorPageSpeedInsightResult(url, err.message);
    } finally {
        if (chrome) {
            try {
                chrome.kill();
            } catch {
                // ignore cleanup errors
            }
        }
    }
});