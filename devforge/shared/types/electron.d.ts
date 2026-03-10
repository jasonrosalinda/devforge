import type { IAzureAPI } from './azureCapture.types';

export interface IElectronAPI {
    // PageSpeed / Lighthouse  (existing)
    runAudit: (url: string, strategy: string) => Promise<PageSpeedInsightResult>;

    // Azure Chart Capture  (new)
    azure: IAzureAPI;
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
    }
}