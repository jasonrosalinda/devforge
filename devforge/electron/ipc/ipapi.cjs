'use strict';

const { ipcMain } = require('electron');

// Proxied through main process to keep the API key out of renderer devtools network
// tab and stay consistent with the rest of the app's external-API handling.
module.exports = function registerIpapiHandlers() {
  ipcMain.handle('ipapi:lookup', async (_event, { ip, apiKey }) => {
    const url = `https://api.ipapi.is/?q=${encodeURIComponent(ip)}${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.error) {
        return { success: false, error: (data.error && (data.error.message || data.error)) || `HTTP ${res.status}` };
      }
      return {
        success: true,
        isCrawler: Boolean(data.is_crawler),
        isDatacenter: Boolean(data.is_datacenter),
        isProxy: Boolean(data.is_proxy),
        isVpn: Boolean(data.is_vpn),
        isTor: Boolean(data.is_tor),
        isAbuser: Boolean(data.is_abuser),
        crawlerName: data.crawler?.name ?? null,
        companyName: data.company?.name ?? null,
      };
    } catch (err) {
      return { success: false, error: err.message || String(err) };
    }
  });
};
