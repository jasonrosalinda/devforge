const path = require('path');
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain } = require('electron');

// Background health monitor: a tray icon plus a hidden worker window.
//
// The health rules (status, anomaly detection, remarks) are TypeScript in the
// renderer, so the checking runs in a hidden BrowserWindow that bundles that same
// code (monitor.html → src/monitor/monitorMain.ts) rather than a .cjs port that
// could drift from what the page shows. Main only owns the tray, the worker's
// lifetime and the close-to-tray behaviour.
//
// The worker calls azure-metrics:fetch like the page does, but that handler
// replies to `_event.sender`, so its partial results never reach the main window
// and the App Health Check page is left alone.

const ICON = path.join(__dirname, '../../public/icon.ico');

let enabled = false;
let quitting = false;
let tray = null;
let worker = null;

// A garbage-collected Notification loses its click handler, and one sitting in
// Action Center can be clicked long after it left the screen, so recent ones are
// held. Capped so a monitor left running for days doesn't keep every alert alive.
const MAX_HELD_NOTIFICATIONS = 20;
const heldNotifications = [];

function showMain(mainWindow) {
  if (mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** A clicked alert: bring the window up on App Health Check, reloaded to now. */
function openHealthCheck(mainWindow) {
  showMain(mainWindow);
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send('monitor:open-health-check');
}

function notify(mainWindow, title, body) {
  // A tray balloon is the legacy notify-icon path, which Windows 10+ turns into a
  // toast whose click is easily lost; a Notification is a toast with its own click
  // event. The balloon stays as the fallback.
  if (!Notification.isSupported()) {
    tray.displayBalloon({ title, content: body, iconType: 'warning', respectQuietTime: true });
    return;
  }
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => openHealthCheck(mainWindow));
  heldNotifications.push(n);
  if (heldNotifications.length > MAX_HELD_NOTIFICATIONS) heldNotifications.shift();
  n.show();
}

/** monitor.html sits next to index.html in both the dev server and dist/, so it is
 *  resolved against wherever the main window was loaded from. That also keeps it on
 *  the same origin, which is what lets the worker read the same localStorage settings. */
function workerUrl(mainWindow) {
  const base = mainWindow.webContents.getURL().split('#')[0];
  return new URL('monitor.html', base).toString();
}

function createWorker(mainWindow) {
  worker = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // A hidden window is throttled like a background tab; the one-minute timer
      // must keep firing.
      backgroundThrottling: false,
    },
  });
  worker.on('closed', () => { worker = null; });
  worker.loadURL(workerUrl(mainWindow));
}

function createTray(mainWindow) {
  tray = new Tray(ICON);
  tray.setToolTip('devForge — monitoring');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open devForge', click: () => showMain(mainWindow) },
    { label: 'Check now', click: () => { if (worker && !worker.isDestroyed()) worker.webContents.send('monitor:check-now'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => showMain(mainWindow));
  tray.on('balloon-click', () => openHealthCheck(mainWindow));
}

function start(mainWindow) {
  if (!tray) createTray(mainWindow);
  if (!worker) createWorker(mainWindow);
}

function stop() {
  if (worker && !worker.isDestroyed()) worker.destroy();
  worker = null;
  if (tray) tray.destroy();
  tray = null;
}

module.exports = function registerBackgroundMonitor(mainWindow) {
  ipcMain.handle('monitor:set-enabled', (_event, value) => {
    enabled = !!value;
    if (enabled) start(mainWindow);
    else stop();
  });

  ipcMain.handle('monitor:alert', (_event, { title, body }) => {
    if (!tray) return;
    notify(mainWindow, title, body);
    // Tooltips are capped at 127 characters on Windows.
    tray.setToolTip(`devForge — ${title}`.slice(0, 127));
    if (!mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  });

  // With the monitor on, closing the window hides it to the tray instead of quitting.
  // `quitting` is set by the tray's Quit and by any other quit path (the updater's
  // quitAndInstall included), so those still get through.
  mainWindow.on('close', (e) => {
    if (enabled && !quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  app.on('before-quit', () => {
    quitting = true;
    stop();
  });
};

/** main.cjs asks this before quitting on window-all-closed. */
module.exports.isEnabled = () => enabled;
