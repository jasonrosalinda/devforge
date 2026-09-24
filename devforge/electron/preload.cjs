const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    azureMetrics: {
        checkCredential: () => ipcRenderer.invoke('azure-metrics:check-credential'),
        fetch: (opts) => ipcRenderer.invoke('azure-metrics:fetch', opts),
        fetchAppDetails: (opts) => ipcRenderer.invoke('azure-metrics:fetch-app-details', opts),
        fetchDetectors: (opts) => ipcRenderer.invoke('azure-metrics:fetch-detectors', opts),
        fetchSnat: (opts) => ipcRenderer.invoke('azure-metrics:fetch-snat', opts),
        fetchRestarts: (opts) => ipcRenderer.invoke('azure-metrics:fetch-restarts', opts),
        fetchCrashes: (opts) => ipcRenderer.invoke('azure-metrics:fetch-crashes', opts),
        fetchEndpointDetail: (opts) => ipcRenderer.invoke('azure-metrics:fetch-endpoint-detail', opts),
        onPartial: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('azure-metrics:partial', fn);
            return () => ipcRenderer.removeListener('azure-metrics:partial', fn);
        },
    },

    incidentReport: {
        generate: (opts) => ipcRenderer.invoke('incident-report:generate', opts),
        fetchData: (opts) => ipcRenderer.invoke('incident-report:fetchData', opts),
        rca: (opts) => ipcRenderer.invoke('incident-report:rca', opts),
        aiRemarks: (opts) => ipcRenderer.invoke('incident-report:ai-remarks', opts),
        saveRca: (opts) => ipcRenderer.invoke('incident-report:saveRca', opts),
        exportRcaPdf: (opts) => ipcRenderer.invoke('incident-report:exportRcaPdf', opts),
        exportRcaDoc: (opts) => ipcRenderer.invoke('incident-report:exportRcaDoc', opts),
        onRcaChunk: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('incident-report:rca-chunk', fn);
            return () => ipcRenderer.removeListener('incident-report:rca-chunk', fn);
        },
        onRcaProgress: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('incident-report:rca-progress', fn);
            return () => ipcRenderer.removeListener('incident-report:rca-progress', fn);
        },
    },

    pagespeedInsight: {
        generate: (payload) => ipcRenderer.invoke('pagespeed-insight:generate', payload),
        analyze: (payload) => ipcRenderer.invoke('pagespeed-insight:analyze', payload),
        onAnalyzeChunk: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('pagespeed-insight:analyze-chunk', fn);
            return () => ipcRenderer.removeListener('pagespeed-insight:analyze-chunk', fn);
        },
        // Full Assessment: locate a repository, check it, then investigate it read-only.
        pickRepo: () => ipcRenderer.invoke('pagespeed-insight:pick-repo'),
        validateRepo: (payload) => ipcRenderer.invoke('pagespeed-insight:validate-repo', payload),
        analyzeAttribution: (payload) => ipcRenderer.invoke('pagespeed-insight:analyze-attribution', payload),
        cancelAttribution: () => ipcRenderer.invoke('pagespeed-insight:analyze-attribution-cancel'),
        onAttributionChunk: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('pagespeed-insight:attribution-chunk', fn);
            return () => ipcRenderer.removeListener('pagespeed-insight:attribution-chunk', fn);
        },
        onAttributionProgress: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('pagespeed-insight:attribution-progress', fn);
            return () => ipcRenderer.removeListener('pagespeed-insight:attribution-progress', fn);
        },
    },

    commands: {
        sync: (opts) => ipcRenderer.invoke('commands:sync', opts),
    },

    unusedAssets: {
        gitBranch: (opts) => ipcRenderer.invoke('unused-assets:git-branch', opts),
        review: (opts) => ipcRenderer.invoke('unused-assets:review', opts),
        cancelReview: () => ipcRenderer.invoke('unused-assets:review-cancel'),
        onReviewProgress: (cb) => {
            const fn = (_e, data) => cb(data);
            ipcRenderer.on('unused-assets:review-progress', fn);
            return () => ipcRenderer.removeListener('unused-assets:review-progress', fn);
        },
    },

    ipapi: {
        lookup: (opts) => ipcRenderer.invoke('ipapi:lookup', opts),
    },

    backgroundMonitor: {
        setEnabled: (enabled) => ipcRenderer.invoke('monitor:set-enabled', enabled),
        alert: (opts) => ipcRenderer.invoke('monitor:alert', opts),
        onCheckNow: (cb) => {
            const fn = () => cb();
            ipcRenderer.on('monitor:check-now', fn);
            return () => ipcRenderer.removeListener('monitor:check-now', fn);
        },
    },

    confluence: {
        fetchRunbook: (opts) => ipcRenderer.invoke('confluence:fetchRunbook', opts),
        fetchImages: (opts) => ipcRenderer.invoke('confluence:fetchImages', opts),
        login: (opts) => ipcRenderer.invoke('confluence:login', opts),
        authStatus: (opts) => ipcRenderer.invoke('confluence:authStatus', opts),
        tokenStatus: (opts) => ipcRenderer.invoke('confluence:tokenStatus', opts),
        logout: () => ipcRenderer.invoke('confluence:logout'),
        saveSummary: (opts) => ipcRenderer.invoke('confluence:saveSummary', opts),
    },

    update: {
        onAvailable:  (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:available',  fn); return () => ipcRenderer.removeListener('update:available',  fn); },
        onProgress:   (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:progress',   fn); return () => ipcRenderer.removeListener('update:progress',   fn); },
        onDownloaded: (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:downloaded', fn); return () => ipcRenderer.removeListener('update:downloaded', fn); },
        onError:      (cb) => { const fn = (_e, d) => cb(d); ipcRenderer.on('update:error',      fn); return () => ipcRenderer.removeListener('update:error',      fn); },
        install: () => ipcRenderer.invoke('update:install'),
    },

});
