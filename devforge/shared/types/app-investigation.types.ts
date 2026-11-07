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
    phase: 'repo' | 'azure' | 'git' | 'agent' | 'init' | 'tool' | 'denied';
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
    deniedTools: string[];
    warnings: { code: string; message: string }[];
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
    }) => Promise<InvestigationResult>;
    cancel: () => Promise<{ success: boolean; running: boolean }>;
    openCitation: (payload: { root: string; file: string; line: number }) => Promise<{ success: boolean; error?: string }>;
    onChunk: (cb: (data: { runId?: string | null; chunk: string }) => void) => () => void;
    onProgress: (cb: (data: InvestigationProgress) => void) => () => void;
}
