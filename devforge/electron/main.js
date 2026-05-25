import { app, BrowserWindow, shell, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import updater from 'electron-updater';
const { autoUpdater } = updater;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

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

    mainWindow.once('ready-to-show', () => mainWindow.show());

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    if (isDev) {
        const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
        mainWindow.loadURL(VITE_DEV_SERVER_URL);
        mainWindow.webContents.openDevTools();
    } else {
        const appPath = app.getAppPath();
        const indexPath = path.join(appPath, 'dist', 'index.html');
        console.log('Loading:', indexPath);
        mainWindow.loadFile(indexPath);
    }

    return mainWindow;
}

app.whenReady().then(() => {
    const mainWindow = createWindow();

    try {
        require('./ipc/pagespeed.cjs')(mainWindow);
        console.log('✅ pagespeed handlers registered');
    } catch (err) {
        console.error('❌ Failed to load pagespeed.cjs:', err);
    }

    try {
        require('./ipc/azure-metrics.cjs')(mainWindow);
        console.log('✅ azure-metrics handlers registered');
    } catch (err) {
        console.error('❌ Failed to load azure-metrics.cjs:', err);
    }

    try {
        require('./ipc/incident-report.cjs')(mainWindow);
        console.log('✅ incident-report handlers registered');
    } catch (err) {
        console.error('❌ Failed to load incident-report.cjs:', err);
    }

    try {
        require('./ipc/pagespeed-insight.cjs')(mainWindow);
        console.log('✅ pagespeed-insight handlers registered');
    } catch (err) {
        console.error('❌ Failed to load pagespeed-insight.cjs:', err);
    }

    // ── Auto-updater ──────────────────────────────────────────────────────────
    if (!isDev) {
        const send = (channel, data) => {
            if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
        };

        autoUpdater.on('checking-for-update', () => {
            console.log('[updater] Checking for update...');
        });

        autoUpdater.on('update-available', (info) => {
            console.log(`[updater] Update available: v${info.version}`);
            send('update:available', { version: info.version });
        });

        autoUpdater.on('update-not-available', () => {
            console.log('[updater] Up to date.');
        });

        autoUpdater.on('download-progress', (progress) => {
            send('update:progress', {
                percent: Math.round(progress.percent),
                transferred: progress.transferred,
                total: progress.total,
            });
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log(`[updater] Update downloaded: v${info.version}`);
            send('update:downloaded', { version: info.version });
        });

        autoUpdater.on('error', (err) => {
            console.error('[updater] Error:', err.message);
            send('update:error', err.message);
        });

        ipcMain.handle('update:install', () => {
            autoUpdater.quitAndInstall(true, true);
        });

        autoUpdater.checkForUpdatesAndNotify();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
