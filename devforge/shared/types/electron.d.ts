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

    // PageSpeed AI Insights
    pagespeedInsight: {
        generate: (payload: {
            desktop?: { results1: unknown[]; results2: unknown[]; config: unknown; auditStart: string | null; auditEnd: string | null };
            mobile?:  { results1: unknown[]; results2: unknown[]; config: unknown; auditStart: string | null; auditEnd: string | null };
        }) => Promise<{ success: boolean; path?: string; error?: string }>;
    };

    // Auto-updater
    update: {
        onAvailable:  (cb: (data: { version: string }) => void) => () => void;
        onProgress:   (cb: (data: { percent: number; transferred: number; total: number }) => void) => () => void;
        onDownloaded: (cb: (data: { version: string }) => void) => () => void;
        onError:      (cb: (message: string) => void) => () => void;
        install: () => Promise<void>;
    };

    // Claude Code commands sync
    commands: {
        sync(opts: { subscriptionId: string; apps: { name: string; resourceGroup: string; type: string; appInsightsAppId?: string; apiName?: string; apiType?: string; apiInsightsAppId?: string }[] }): Promise<{ success: boolean; error?: string }>;
    };

    // Incident Report
    incidentReport: {
        generate: (opts: {
            startMs: number;
            endMs: number;
            subscriptionId: string;
            resourceGroup: string;
            appName: string;
            perIncident?: boolean;
        }) => Promise<{ success: boolean; path?: string; error?: string }>;
        fetchData: (opts: {
            startMs: number;
            endMs: number;
            subscriptionId: string;
            resourceGroup: string;
            appName: string;
        }) => Promise<unknown>;
    };
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
    }
}