// Opt-in timing trace for the main process: `DEVFORGE_TRACE=1 npm run electron:dev:live`.
// Logs each outbound fetch (method, host + path without the query string, status, ms),
// each IPC handler's total time and each Azure token request (cache hit / miss, ms).
// Never logs headers, bodies or query strings, so no token or secret reaches the console.

const enabled = !!process.env.DEVFORGE_TRACE;

/** host + path only: query strings can carry SAS tokens or signed download params. */
function redactUrl(url) {
  try {
    const u = new URL(String(url));
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
}

function log(line) {
  if (enabled) console.log(`[trace] ${line}`);
}

function install() {
  if (!enabled) return;
  const { ipcMain } = require('electron');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const started = Date.now();
    const method = (init && init.method) || (input && input.method) || 'GET';
    const url = redactUrl(typeof input === 'string' || input instanceof URL ? input : input && input.url);
    try {
      const res = await realFetch(input, init);
      log(`fetch ${method} ${url} ${res.status} ${Date.now() - started}ms`);
      return res;
    } catch (err) {
      log(`fetch ${method} ${url} failed ${Date.now() - started}ms`);
      throw err;
    }
  };

  const realHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => realHandle(channel, async (...args) => {
    const started = Date.now();
    try {
      return await fn(...args);
    } finally {
      log(`ipc ${channel} ${Date.now() - started}ms`);
    }
  });

  log('enabled');
}

module.exports = { enabled, install, log, redactUrl };
