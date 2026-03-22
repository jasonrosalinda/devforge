import type { IAzureAPI } from './azureCapture.types';

export interface IElectronAPI {
    // PageSpeed / Lighthouse  (existing)
    runAudit: (url: string, strategy: string, visitMode: string, runMode: 'single' | 'average') => Promise<PageSpeedInsightResult>;
    clearLighthouseCache: () => Promise<{ success: boolean }>;

    // Azure Chart Capture  (new)
    azure: IAzureAPI;
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
    }
}