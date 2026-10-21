/** Ask Telemetry — plain-English question → KQL → App Insights result. */

export type TelemetryTarget = 'fe' | 'api';

export type TelemetryChartType = 'timeseries' | 'bar' | 'table';

/** Claude's suggestion for drawing the result. Checked against the real columns before use. */
export interface TelemetryChartSpec {
    type: TelemetryChartType;
    x?: string;
    y?: string[];
    series?: string;
}

/** An App Insights column type: datetime, string, long, int, real, decimal, bool, timespan, dynamic, guid. */
export interface TelemetryColumn {
    name: string;
    type: string;
}

export type TelemetryCell = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface TelemetryResult {
    columns?: TelemetryColumn[];
    rows?: TelemetryCell[][];
    /** More rows matched than the page keeps (5,000). */
    truncated?: boolean;
    durationMs?: number;
    error?: string;
}

export interface TelemetryMeta {
    costUsd: number;
    tokens: { input: number; output: number; total: number };
    /** Claude calls made — 2 when the first query needed a repair. */
    calls: number;
}

export interface TelemetryRequest {
    /** Azure settings (`settings.azure`); main looks the app up by `appKey`. */
    config: unknown;
    appKey: string;
    target: TelemetryTarget;
    startIso: string;
    endIso: string;
}

export interface TelemetryAskResponse {
    success: boolean;
    cancelled?: boolean;
    error?: string;
    kql?: string;
    explanation?: string;
    chart?: TelemetryChartSpec;
    result?: TelemetryResult;
    /** The first query failed and Claude's fix ran instead. */
    repaired?: boolean;
    meta?: TelemetryMeta;
}

export interface TelemetryRunResponse {
    success: boolean;
    cancelled?: boolean;
    error?: string;
    kql?: string;
    result?: TelemetryResult;
}

export type TelemetryStage = 'schema' | 'generating' | 'running' | 'repairing';

export interface ITelemetryAPI {
    ask: (opts: TelemetryRequest & { question: string }) => Promise<TelemetryAskResponse>;
    run: (opts: TelemetryRequest & { kql: string }) => Promise<TelemetryRunResponse>;
    cancel: () => Promise<{ success: boolean; running: boolean }>;
    onProgress: (cb: (data: { stage: TelemetryStage }) => void) => () => void;
}
