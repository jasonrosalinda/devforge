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
            desktop?: { results1: unknown[]; results2: unknown[]; config: unknown; auditStart: Date | null; auditEnd: Date | null } | undefined;
            mobile?:  { results1: unknown[]; results2: unknown[]; config: unknown; auditStart: Date | null; auditEnd: Date | null } | undefined;
        }) => Promise<{ success: boolean; path?: string; error?: string }>;
        analyze: (payload: { url: string; summary: string }) => Promise<{ success: boolean; analysis?: string; error?: string }>;
        saveBrief: (payload: { markdown: string }) => Promise<{ success: boolean; path?: string; canceled?: boolean; error?: string }>;
        onAnalyzeChunk: (cb: (data: { url?: string; chunk: string }) => void) => () => void;
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

    // ipapi.is — bot/crawler/datacenter reputation lookup (proxied through main)
    ipapi: {
        lookup(opts: { ip: string; apiKey: string }): Promise<{
            success: boolean;
            error?: string;
            isCrawler?: boolean;
            isDatacenter?: boolean;
            isProxy?: boolean;
            isVpn?: boolean;
            isTor?: boolean;
            isAbuser?: boolean;
            crawlerName?: string | null;
            companyName?: string | null;
        }>;
    };

    // Confluence runbook fetch (Release Pilot)
    confluence: {
        fetchRunbook(opts: { baseUrl: string; email: string; apiToken: string; pageUrl: string }): Promise<{
            ok: boolean;
            error?: string;
            pageId?: string;
            url?: string;
            title?: string;
            version?: number;
            author?: string;
            when?: string;
            spaceKey?: string;
            connected?: boolean;
            html?: string;
            attachments?: { filename: string; mediaType: string; isImage: boolean; dataUri: string; id?: string; fileId?: string; srcUrl?: string }[];
            attDebug?: { connected: boolean; listStatus: number; listed: number; downloaded: number; firstErr?: string };
        }>;
        fetchImages(opts: { urls: string[] }): Promise<{
            results: { url: string; ok: boolean; status: number; mediaType?: string; isImage?: boolean; dataUri?: string; error?: string; textHead?: string }[];
        }>;
        login(opts: { baseUrl: string }): Promise<{ ok: boolean; error?: string }>;
        authStatus(opts: { baseUrl: string }): Promise<{ connected: boolean }>;
        logout(): Promise<{ ok: boolean; error?: string }>;
        saveSummary(opts: { html: string; title?: string | undefined }): Promise<{ ok: boolean; path?: string; error?: string }>;
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
        rca: (opts: {
            subscriptionId: string;
            resourceGroup?: string | undefined;
            appName: string;
            appType?: string | undefined;
            appInsightsAppId?: string | undefined;
            apiName?: string | undefined;
            apiInsightsAppId?: string | undefined;
            apiType?: string | undefined;
            startMs: number;
            endMs: number;
            uptimeRobotIncidents?: unknown[] | undefined;
        }) => Promise<{ success: boolean; rca?: string; error?: string }>;
        saveRca: (opts: {
            appName: string;
            startMs: number;
            endMs: number;
            markdown: string;
        }) => Promise<{ success: boolean; path?: string; error?: string }>;
        onRcaChunk: (cb: (data: { appKey: string; chunk: string }) => void) => () => void;
        onRcaProgress: (cb: (data: { appKey: string; stage: string }) => void) => () => void;
    };

    // Unused Assets — Claude review pass
    unusedAssets: {
        gitBranch: (opts: { folderPath: string }) => Promise<{ success: boolean; branch?: string | null; error?: string }>;
        review: (opts: {
            candidates: { id: string; kind: string; name: string; file: string; line: number }[];
            evidence: Record<string, { file: string; line: number; text: string }[]>;
        }) => Promise<{
            success: boolean;
            cancelled?: boolean;
            verdicts?: { id: string; verdict: 'confirmed-unused' | 'false-positive' | 'needs-review'; reason: string }[];
            error?: string;
        }>;
        cancelReview: () => Promise<{ success: boolean; error?: string }>;
        onReviewProgress: (cb: (data: { stage: string }) => void) => () => void;
    };
}

declare global {
    interface Window {
        electronAPI: IElectronAPI;
    }
}