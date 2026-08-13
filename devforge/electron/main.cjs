const path = require('path');
const { app, BrowserWindow, shell, ipcMain, Menu } = require('electron');

const isDev = !app.isPackaged;

Menu.setApplicationMenu(null);

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
        autoHideMenuBar: true,
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

    try {
        require('./ipc/commands.cjs')();
        console.log('✅ commands handlers registered');
    } catch (err) {
        console.error('❌ Failed to load commands.cjs:', err);
    }

    try {
        require('./ipc/confluence.cjs')();
        console.log('✅ confluence handlers registered');
    } catch (err) {
        console.error('❌ Failed to load confluence.cjs:', err);
    }

    try {
        require('./ipc/unused-assets.cjs')(mainWindow);
        console.log('✅ unused-assets handlers registered');
    } catch (err) {
        console.error('❌ Failed to load unused-assets.cjs:', err);
    }

    try {
        require('./ipc/ipapi.cjs')();
        console.log('✅ ipapi handlers registered');
    } catch (err) {
        console.error('❌ Failed to load ipapi.cjs:', err);
    }

    // ── Auto-updater ──────────────────────────────────────────────────────────
    if (!isDev) {
        const { autoUpdater } = require('electron-updater');
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
