export interface PageSpeedErrorResponse {
    code: number;
    message: string;
}

export interface PageSpeedInsightConfig {
    apiKey: string;
    strategy: string;
}

export interface PageSpeedMetrics {
    speedIndex: number;
    largestContentfulPaint: number;
    cumulativeLayoutShift: number;
    totalBlockingTime: number;
    firstContentfulPaint: number;
    runWarnings?: string;
    errorResponse?: PageSpeedErrorResponse;
}

export interface PageSpeedInsightResult {
    url: string;
    before: PageSpeedMetrics | null;
    after: PageSpeedMetrics | null;
    generatingBefore: boolean;
    generatingAfter: boolean;
}

export interface UsePageSpeedInsightHooks {
    config: PageSpeedInsightConfig;
    result: PageSpeedInsightResult[];
    generate: (urls: string[]) => Promise<void>;
    generateBefore: (url: string) => Promise<void>;
    generateAfter: (url: string) => Promise<void>;
    setApiKey: (apiKey: string) => void;
    setStrategy: (strategy: string) => void;
    reset: () => void;
    removeResult: (url: string) => void;
}