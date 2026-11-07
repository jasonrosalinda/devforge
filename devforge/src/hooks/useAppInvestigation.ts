import { useCallback, useRef, useState } from 'react';
import type {
    InvestigationInterpretation, InvestigationMeta, InvestigationProgress, InvestigationRefusal,
} from '@shared/types/app-investigation.types';
import type { AzureSettings } from '@/types/settings.types';
import { newRunId } from '@/lib/rca-report';

export type InvestigationStatus =
    | 'idle' | 'interpreting' | 'confirm' | 'refused' | 'running' | 'done' | 'error';

export interface InvestigationState {
    status: InvestigationStatus;
    /** The query the current interpretation / report belongs to. */
    query: string;
    interpretation: InvestigationInterpretation | null;
    refusal: InvestigationRefusal | null;
    /** Host stages and agent tool calls, oldest first. */
    trail: InvestigationProgress[];
    /** Live report text while the agent writes. */
    stream: string;
    report: string;
    /** Full telemetry report — handed to the RCA so it does not pull Azure again. */
    azureReport: string;
    meta: InvestigationMeta | null;
    error: string | null;
}

const INITIAL: InvestigationState = {
    status: 'idle', query: '', interpretation: null, refusal: null, trail: [], stream: '', report: '', azureReport: '', meta: null, error: null,
};

const MAX_TRAIL = 200;

/** Query → interpret (guarded) → user confirms → read-only investigation. */
export default function useAppInvestigation() {
    const [state, setState] = useState<InvestigationState>(INITIAL);
    const runIdRef = useRef<string | null>(null);

    const interpret = useCallback(async (args: {
        query: string; config: AzureSettings; selectedAppKey: string | null; fallbackWindow: { startMs: number; endMs: number };
    }) => {
        setState({ ...INITIAL, status: 'interpreting', query: args.query });
        try {
            const res = await window.electronAPI.appInvestigation.interpret(args);
            if (!res.success) {
                setState(s => ({ ...s, status: 'error', error: res.error }));
            } else if (!res.inScope) {
                setState(s => ({ ...s, status: 'refused', refusal: res.refusal }));
            } else {
                setState(s => ({ ...s, status: 'confirm', interpretation: res.interpretation }));
            }
        } catch (e: any) {
            setState(s => ({ ...s, status: 'error', error: e?.message ?? 'Could not reach Claude.' }));
        }
    }, []);

    /** Edits on the "Understood as" card. Main re-validates everything on run. */
    const editInterpretation = useCallback((patch: Partial<InvestigationInterpretation>) => {
        setState(s => (s.interpretation ? { ...s, interpretation: { ...s.interpretation, ...patch } } : s));
    }, []);

    const run = useCallback(async (args: { config: AzureSettings; repoPath: string }) => {
        const { query, interpretation } = state;
        if (!interpretation) return;
        const runId = newRunId();
        runIdRef.current = runId;
        setState(s => ({ ...s, status: 'running', trail: [], stream: '', report: '', azureReport: '', meta: null, error: null }));

        const mine = (d: { runId?: string | null }) => d.runId === runId;
        const offChunk = window.electronAPI.appInvestigation.onChunk((d) => {
            if (mine(d)) setState(s => ({ ...s, stream: s.stream + d.chunk }));
        });
        const offProgress = window.electronAPI.appInvestigation.onProgress((d) => {
            if (mine(d)) setState(s => ({ ...s, trail: [...s.trail, d].slice(-MAX_TRAIL) }));
        });
        try {
            const res = await window.electronAPI.appInvestigation.run({ runId, query, interpretation, config: args.config, repoPath: args.repoPath });
            if (runIdRef.current !== runId) return;
            if (res.success) {
                setState(s => ({
                    ...s, status: 'done', report: res.report, azureReport: res.azureReport, meta: res.meta, interpretation: res.interpretation,
                }));
            } else {
                setState(s => ({ ...s, status: 'error', error: res.code === 'CANCELLED' ? 'Investigation cancelled.' : res.error }));
            }
        } catch (e: any) {
            setState(s => ({ ...s, status: 'error', error: e?.message ?? 'Investigation failed.' }));
        } finally {
            offChunk();
            offProgress();
        }
    }, [state]);

    const cancel = useCallback(async () => {
        await window.electronAPI.appInvestigation.cancel();
    }, []);

    /** Back to the confirm card, keeping the interpretation (Retry / edit after an error). */
    const backToConfirm = useCallback(() => {
        setState(s => (s.interpretation ? { ...s, status: 'confirm', error: null } : { ...INITIAL }));
    }, []);

    const restore = useCallback((entry: { query: string; interpretation: InvestigationInterpretation; report: string; meta: InvestigationMeta }) => {
        runIdRef.current = null;
        setState({ ...INITIAL, status: 'done', query: entry.query, interpretation: entry.interpretation, report: entry.report, meta: entry.meta });
    }, []);

    const reset = useCallback(() => {
        runIdRef.current = null;
        setState(INITIAL);
    }, []);

    return { state, interpret, editInterpretation, run, cancel, backToConfirm, restore, reset };
}
