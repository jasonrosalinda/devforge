/** App Investigation — plain-English incident → Azure evidence + source code → findings report. */

export type InvestigationCategory =
    | 'downtime' | 'errors' | 'exceptions' | 'latency' | 'resource'
    | 'restart' | 'deployment' | 'dependency' | 'other';

export type InvestigationTarget = 'app' | 'api';

/** What Claude understood the query to be, after main validated every field. */
export interface InvestigationInterpretation {
    appKey: string;
    /** Which repository to investigate: the app's or its API's. */
    target: InvestigationTarget;
    startMs: number;
    endMs: number;
    /** 'query' when the window came from the text, 'page' when it fell back to the picker. */
    windowSource: 'query' | 'page';
    category: InvestigationCategory;
    symptoms: string[];
    question: string;
    reason?: string;
}

export interface InvestigationRefusal {
    /** TOO_SHORT | TOO_LONG | INVALID_TEXT | ACTION_REQUEST | SECRET_REQUEST | OUT_OF_SCOPE | UNKNOWN_APP */
    code: string;
    reason: string;
}

export type InterpretResult =
    | { success: true; inScope: true; interpretation: InvestigationInterpretation }
    | { success: true; inScope: false; refusal: InvestigationRefusal }
    | { success: false; code?: string; error: string };

export interface InvestigationProgress {
    runId?: string | null;
    /** repo | azure | git | agent (host stages) · init | tool | denied (agent stream) */
    phase: 'repo' | 'azure' | 'git' | 'agent' | 'init' | 'tool' | 'denied' | 'verify' | 'query';
    detail?: string;
    tool?: string;
}

export interface InvestigationMeta {
    costUsd?: number | undefined;
    tokens?: { input: number; output: number; total: number } | undefined;
    numTurns?: number | undefined;
    durationMs?: number | undefined;
    repoRoot: string;
    branch: string;
    head: string;
    /** The other site's repository, read alongside when it has its own; cited as `@<otherTarget>/path:line`. */
    otherRepoRoot?: string | undefined;
    otherTarget?: 'app' | 'api' | undefined;
    deniedTools: string[];
    warnings: { code: string; message: string }[];
}

/** A Warning/Critical anomaly episode from App Health Check's detector, as the page charts it. */
export interface InvestigationEpisode {
    startT: string;
    endT: string;
    peakSeverity: 'Critical' | 'Warning';
    bucketCount: number;
    metricsInvolved: string[];
    peakValues: Record<string, number>;
    incidentType: string;
}

export type InvestigationResult =
    | {
        success: true;
        report: string;
        /** The full telemetry report, reused by the RCA so it does not pull Azure again. */
        azureReport: string;
        interpretation: InvestigationInterpretation;
        meta: InvestigationMeta;
    }
    | { success: false; code?: string; error: string };

/** One UptimeRobot down period (epoch ms) — the external downtime reference App Health Check uses. */
export interface UptimeIncident {
    monitor: string;
    start: number;
    end: number;
    reason?: string | undefined;
}

/** A past investigation of the same app, sent so the agent can recognise a recurring cause. */
export interface EarlierInvestigation {
    startMs: number;
    endMs: number;
    question: string;
    report: string;
}

export interface IAppInvestigationAPI {
    pickRepo: () => Promise<{ success: boolean; path?: string; canceled?: boolean; code?: string; error?: string }>;
    interpret: (payload: {
        query: string;
        /** settings.azure — main re-validates everything it uses. */
        config: unknown;
        selectedAppKey?: string | null;
        fallbackWindow?: { startMs: number; endMs: number };
    }) => Promise<InterpretResult>;
    run: (payload: {
        runId: string;
        query: string;
        interpretation: InvestigationInterpretation;
        config: unknown;
        repoPath: string;
        /** Screenshots attached as evidence: PNG/JPEG/GIF/WEBP data URIs, at most 5, each under 4 MB. */
        images?: Array<{ name: string; dataUrl: string }> | undefined;
        /** The other site's repository (app ↔ API) when it has its own; read alongside the main one. */
        otherRepoPath?: string | undefined;
        /** Let the agent ask for up to 3 App Insights queries and revise the report with their results. */
        followUp?: boolean | undefined;
        /** App Health Check's anomaly episodes for the window, from the data the page charts; omitted if it could not load. */
        episodes?: InvestigationEpisode[] | undefined;
        /** The app's most recent earlier investigations (not overlapping this window), newest first. */
        earlier?: EarlierInvestigation[] | undefined;
        /** UptimeRobot downtime in the window; omitted when not configured or not loaded yet. */
        uptimeRobotIncidents?: UptimeIncident[] | undefined;
    }) => Promise<InvestigationResult>;
    /** The release branch (and commit) live at `endMs`, resolved in the repo from the Azure release's commit or branch. */
    deployedRef: (payload: { repoPath: string; endMs: number; release: { commit?: string | undefined; branch?: string | undefined } | null }) => Promise<{
        success: boolean; branch?: string; sha?: string | null; basis?: 'commit' | 'branch-at-end' | 'checked-out'; note?: string; code?: string; error?: string;
    }>;
    cancel: () => Promise<{ success: boolean; running: boolean }>;
    openCitation: (payload: { root: string; file: string; line: number }) => Promise<{ success: boolean; error?: string }>;
    /** `reset`: the follow-up pass is starting, so the live text begins again. */
    onChunk: (cb: (data: { runId?: string | null; chunk: string; reset?: boolean }) => void) => () => void;
    onProgress: (cb: (data: InvestigationProgress) => void) => () => void;
}
