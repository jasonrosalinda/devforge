import { useCallback, useEffect, useRef, useState } from 'react';
import type {
    TelemetryChartSpec, TelemetryMeta, TelemetryRequest, TelemetryResult, TelemetryStage,
} from '@shared/types/telemetry.types';

export type TelemetryStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

export interface TelemetryState {
    status: TelemetryStatus;
    stage: TelemetryStage | null;
    kql: string;
    explanation: string;
    chart: TelemetryChartSpec | undefined;
    result: TelemetryResult | null;
    repaired: boolean;
    error: string | null;
    meta: TelemetryMeta | null;
}

const INITIAL: TelemetryState = {
    status: 'idle',
    stage: null,
    kql: '',
    explanation: '',
    chart: undefined,
    result: null,
    repaired: false,
    error: null,
    meta: null,
};

/**
 * Ask a question (Claude writes and runs the KQL) or run KQL directly.
 *
 * A query error is not a failed request: the KQL is still shown, with the API's
 * error under it, so the user can fix it by hand. `error` is for failures before a
 * query exists — sign-in, Claude missing, no App Insights.
 */
export default function useTelemetryAsk() {
    const [state, setState] = useState<TelemetryState>(INITIAL);
    const cancelRequestedRef = useRef(false);

    useEffect(() => window.electronAPI?.telemetry?.onProgress(({ stage }) => {
        setState(s => (s.status === 'running' ? { ...s, stage } : s));
    }), []);

    const ask = useCallback(async (request: TelemetryRequest & { question: string }) => {
        cancelRequestedRef.current = false;
        setState({ ...INITIAL, status: 'running', stage: 'schema' });
        try {
            const res = await window.electronAPI.telemetry.ask(request);
            if (res.cancelled || cancelRequestedRef.current) {
                setState(s => ({ ...s, status: 'cancelled', stage: null }));
                return;
            }
            if (!res.success) {
                setState({ ...INITIAL, status: 'error', error: res.error ?? 'Something went wrong.' });
                return;
            }
            setState({
                status: 'done',
                stage: null,
                kql: res.kql ?? '',
                explanation: res.explanation ?? '',
                chart: res.chart,
                result: res.result ?? null,
                repaired: !!res.repaired,
                error: null,
                meta: res.meta ?? null,
            });
        } catch (e) {
            setState({ ...INITIAL, status: 'error', error: e instanceof Error ? e.message : String(e) });
        }
    }, []);

    /**
     * Run KQL as written. Keeps the explanation and chart hint while the query is the
     * one they describe; a hand edit can change the columns, so the chart then falls
     * back to what the new columns support.
     */
    const run = useCallback(async (request: TelemetryRequest & { kql: string }, chart?: TelemetryChartSpec) => {
        cancelRequestedRef.current = false;
        setState(s => ({ ...s, status: 'running', stage: 'running', error: null }));
        try {
            const res = await window.electronAPI.telemetry.run(request);
            if (res.cancelled || cancelRequestedRef.current) {
                setState(s => ({ ...s, status: 'cancelled', stage: null }));
                return;
            }
            if (!res.success) {
                setState(s => ({ ...s, status: 'error', stage: null, error: res.error ?? 'Something went wrong.' }));
                return;
            }
            setState(s => ({
                ...s,
                status: 'done',
                stage: null,
                kql: res.kql ?? request.kql,
                // Claude's explanation describes Claude's query, not a hand edit of it.
                explanation: s.kql.trim() === request.kql.trim() ? s.explanation : '',
                chart: chart ?? s.chart,
                result: res.result ?? null,
                repaired: false,
                meta: null,
            }));
        } catch (e) {
            setState(s => ({ ...s, status: 'error', stage: null, error: e instanceof Error ? e.message : String(e) }));
        }
    }, []);

    const cancel = useCallback(async () => {
        cancelRequestedRef.current = true;
        setState(s => ({ ...s, status: 'cancelled', stage: null }));
        await window.electronAPI.telemetry.cancel().catch(() => undefined);
    }, []);

    /** Start from a saved query: shows its KQL before it runs. */
    const load = useCallback((kql: string, chart?: TelemetryChartSpec) => {
        setState({ ...INITIAL, kql, chart });
    }, []);

    return { state, ask, run, cancel, load };
}
