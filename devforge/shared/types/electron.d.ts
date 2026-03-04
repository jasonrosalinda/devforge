export interface IElectronAPI {
    // Define the function signature to match your main.js/preload.js
    runAudit: (url: string, strategy: string) => Promise<PageSpeedInsightResult>;
}

declare global {
    interface Window {
        // This adds the property to the existing Window interface
        electronAPI: IElectronAPI;
    }
}