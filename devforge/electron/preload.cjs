const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    runAudit: (url, strategy, visitMode = 'cold', runMode = 'single' || 'average') =>
        ipcRenderer.invoke('run-lighthouse', { url, strategy, visitMode, runMode }),

    clearLighthouseCache: () =>
        ipcRenderer.invoke('clear-lighthouse-cache'),

    azure: {
        saveAuth: (cfg) => ipcRenderer.invoke('azure:save-auth', cfg),
        authExists: () => ipcRenderer.invoke('azure:auth-exists'),
        capture: (cfg) => ipcRenderer.invoke('azure:capture', cfg),
        getSessions: () => ipcRenderer.invoke('azure:get-sessions'),
        getTiles: (session) => ipcRenderer.invoke('azure:get-tiles', session),
        clearSessions: () => ipcRenderer.invoke('azure:clear-sessions'),
        getSettings: () => ipcRenderer.invoke('azure:get-settings'),
        saveSettings: (cfg) => ipcRenderer.invoke('azure:save-settings', cfg),

        onLog: (cb) => {
            const fn = (_e, msg) => cb(msg);
            ipcRenderer.on('azure:log', fn);
            return () => ipcRenderer.removeListener('azure:log', fn);
        },

        onDone: (cb) => {
            const fn = (_e, result) => cb(result);
            ipcRenderer.once('azure:done', fn);
            return () => ipcRenderer.removeListener('azure:done', fn);
        },
    },

    azureMetrics: {
        checkCredential: () => ipcRenderer.invoke('azure-metrics:check-credential'),
        fetch: (opts) => ipcRenderer.invoke('azure-metrics:fetch', opts),
    },

    downtimeReport: {
        generate: (opts) => ipcRenderer.invoke('downtime-report:generate', opts),
    },

});
