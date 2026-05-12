import type { IAzureAPI } from './azureCapture.types';
import type { IAzureMetricsAPI } from './azureMetrics.types';

export interface IElectronAPI {
    // PageSpeed / Lighthouse  (existing)
    runAudit: (url: string, strategy: string, visitMode: string, runMode: 'single' | 'average') => Promise<PageSpeedInsightResult>;
    clearLighthouseCache: () => Promise<{ success: boolean }>;

    // Azure Chart Capture  (existing — Puppeteer)
    azure: IAzureAPI;

    // Azure Monitor Metrics  (new)
    azureMetrics: IAzureMetricsAPI;

    // Downtime Report
    downtimeReport: {
        generate: (opts: {
            startMs: number;
            endMs: number;
            subscriptionId: string;
            resourceGroup: string;
            appName: string;
            anthropicApiKey?: string;
        }) => Promise<{ success: boolean; path?: string; aiUsed?: boolean; error?: string }>;
    };
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
    }
}