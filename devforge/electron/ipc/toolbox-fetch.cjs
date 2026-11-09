// Toolbox: load a text document (JSON / YAML / XML…) from a URL for the converter.
// Runs in the main process so a site without CORS headers still loads. Only http(s);
// no cookies or credentials are sent; size and time are capped.

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

/** The URL to fetch, or an error to show. Pure; exported for tests. */
function checkUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    return { error: 'Not a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http:// and https:// URLs can be loaded.' };
  return { url: url.toString() };
}

async function fetchText(raw, fetchImpl = fetch) {
  const checked = checkUrl(raw);
  if (checked.error) return { ok: false, error: checked.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(checked.url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `The server responded ${res.status}.` };
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) return { ok: false, error: 'The file is larger than 5 MB.' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { ok: false, error: 'The file is larger than 5 MB.' };
    return { ok: true, text: buf.toString('utf8'), contentType: res.headers.get('content-type') || '', finalUrl: res.url || checked.url };
  } catch (err) {
    return { ok: false, error: err && err.name === 'AbortError' ? 'Timed out after 15 s.' : (err && err.message) || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = function registerToolboxFetch() {
  const { ipcMain } = require('electron');
  ipcMain.handle('toolbox:fetch-text', (_event, { url }) => fetchText(url));
};
module.exports._checkUrl = checkUrl;
module.exports._fetchText = fetchText;
module.exports.MAX_BYTES = MAX_BYTES;
