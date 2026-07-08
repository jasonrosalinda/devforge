'use strict';

const { ipcMain } = require('electron');

// Proxied through main process — renderer fetch would work too (ipapi.is sends CORS
// headers) but keeping this consistent with the rest of the app's external-API handling.
// Free tier only, no API key.
module.exports = function registerIpapiHandlers() {
  ipcMain.handle('ipapi:lookup', async (_event, { ip }) => {
    const url = `https://api.ipapi.is/?q=${encodeURIComponent(ip)}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok || data.error) {
        return { success: false, error: (data.error && (data.error.message || data.error)) || `HTTP ${res.status}` };
      }
      return {
        success: true,
        isBogon: Boolean(data.is_bogon),
        isMobile: Boolean(data.is_mobile),
        isSatellite: Boolean(data.is_satellite),
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
