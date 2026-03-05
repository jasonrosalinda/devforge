import { app, BrowserWindow, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import updater from 'electron-updater';
const { autoUpdater } = updater;

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
        titleBarStyle: 'default',
        backgroundColor: '#09090b',
        show: false,
    });

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    if (isDev) {
        const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
        mainWindow.loadURL(VITE_DEV_SERVER_URL);
        mainWindow.webContents.openDevTools();
    } else {
        // Use app.getAppPath() for installed apps, falls back to __dirname for portable
        const appPath = app.getAppPath();
        const indexPath = path.join(appPath, 'dist', 'index.html');
        console.log('App path:', appPath);
        console.log('Loading:', indexPath);
        mainWindow.loadFile(indexPath);
        mainWindow.webContents.openDevTools(); // temporary - remove after debugging
    }
}

app.whenReady().then(() => {
    createWindow();

    if (!isDev) {
        autoUpdater.checkForUpdatesAndNotify();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Auto updater events
autoUpdater.on('update-available', () => {
    console.log('Update available');
});

autoUpdater.on('update-downloaded', () => {
    // Install update on next restart
    autoUpdater.quitAndInstall();
});

import lighthouse from 'lighthouse';
import { parseToPageSpeedInsightResult, buildErrorPageSpeedInsightResult } from './utils/pageSpeedAuditParser.js';

ipcMain.handle("run-lighthouse", async (event, { url, strategy }) => {
    let chrome;
    try {
        const { launch } = await import("chrome-launcher");

        chrome = await launch({
            chromeFlags: [
                "--headless",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--disable-extensions",
                "--no-first-run",
                "--no-default-browser-check",
            ]
        });

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
            maxWaitForLoad: 60000,
            maxWaitForFcp: 30000,
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