const { contextBridge, ipcRenderer } = require('electron'); // ✅ Use require

contextBridge.exposeInMainWorld('electronAPI', {
    runAudit: (url, strategy) => ipcRenderer.invoke('run-lighthouse', { url, strategy })
});