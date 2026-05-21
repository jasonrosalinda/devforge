const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    runAudit: (url, strategy, visitMode = 'cold', runMode = 'single' || 'average') =>
        ipcRenderer.invoke('run-lighthouse', { url, strategy, visitMode, runMode }),

    clearLighthouseCache: () =>
        ipcRenderer.invoke('clear-lighthouse-cache'),

    azureMetrics: {
        checkCredential: () => ipcRenderer.invoke('azure-metrics:check-credential'),
        fetch: (opts) => ipcRenderer.invoke('azure-metrics:fetch', opts),
        fetchAppDetails: (opts) => ipcRenderer.invoke('azure-metrics:fetch-app-details', opts),
        fetchDetectors: (opts) => ipcRenderer.invoke('azure-metrics:fetch-detectors', opts),
        onPartial: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('azure-metrics:partial', fn);
            return () => ipcRenderer.removeListener('azure-metrics:partial', fn);
        },
    },

    incidentReport: {
        generate: (opts) => ipcRenderer.invoke('incident-report:generate', opts),
        fetchData: (opts) => ipcRenderer.invoke('incident-report:fetchData', opts),
    },

    pagespeedInsight: {
        generate: (payload) => ipcRenderer.invoke('pagespeed-insight:generate', payload),
    },

    update: {
        onAvailable:  (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:available',  fn); return () => ipcRenderer.removeListener('update:available',  fn); },
        onProgress:   (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:progress',   fn); return () => ipcRenderer.removeListener('update:progress',   fn); },
        onDownloaded: (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:downloaded', fn); return () => ipcRenderer.removeListener('update:downloaded', fn); },
        onError:      (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:error',      fn); return () => ipcRenderer.removeListener('update:error',      fn); },
        install: () => ipcRenderer.invoke('update:install'),
    },

});
