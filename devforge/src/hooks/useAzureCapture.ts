// hooks/useAzureCapture.ts
// Encapsulates all window.electronAPI.azure IPC calls + their state.
// Import this hook in any screen — no direct api.* calls needed in components.

import { useState, useEffect, useCallback, useRef } from 'react';
import type { AzureSettings, AzureTileImage, AzureDoneResult } from '@shared/types/azureCapture.types';

// Grab the azure namespace once — safe because preload.cjs sets it before React mounts
const api = window.electronAPI?.azure;

// ── Types re-exported for convenience ────────────────────────────────────────
export type { AzureSettings, AzureTileImage };

export type CaptureStatus = 'idle' | 'running' | 'done' | 'error';

// ════════════════════════════════════════════════════════════════════════════
// useAzureAuth  — save-auth flow
// ════════════════════════════════════════════════════════════════════════════
export function useAzureAuth(settings: AzureSettings) {
    const [status, setStatus] = useState<CaptureStatus>('idle');
    const [logs, setLogs] = useState<string[]>([]);
    const [authOk, setAuthOk] = useState<boolean>(false);

    // Check on mount whether azure-auth.json already exists
    useEffect(() => {
        api?.authExists().then(setAuthOk);
    }, []);

    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    const saveAuth = useCallback(async () => {
        setLogs([]);
        setStatus('running');

        let offLog: (() => void) | undefined;
        let offDone: (() => void) | undefined;

        offLog = api?.onLog((msg: string) => setLogs(p => [...p, msg]));
        offDone = api?.onDone(({ success }: AzureDoneResult) => {
            setStatus(success ? 'done' : 'error');
            setAuthOk(success);
            offLog?.();
            offDone?.();
        });

        await api?.saveAuth({
            waitSeconds: settingsRef.current.waitSeconds,
        });
    }, []);

    return { status, logs, authOk, saveAuth };
}

// ════════════════════════════════════════════════════════════════════════════
// useAzureCapture  — chart capture flow
// ════════════════════════════════════════════════════════════════════════════
export function useAzureCapture(
    settings: AzureSettings,
    onCaptured: (session: string) => void,
) {
    const [status, setStatus] = useState<CaptureStatus>('idle');
    const [logs, setLogs] = useState<string[]>([]);
    const [tileCount, setTileCount] = useState<number | null>(null);
    const [progress, setProgress] = useState<number>(0);

    // Use a ref so `capture` always reads the latest settings at call time
    const settingsRef = useRef(settings);
    settingsRef.current = settings;

    const onCapturedRef = useRef(onCaptured);
    onCapturedRef.current = onCaptured;

    const capture = useCallback(async () => {
        const currentSettings = settingsRef.current;
        console.log('[useAzureCapture] capturing with URL:', currentSettings.dashboardUrl);

        setLogs([]);
        setTileCount(null);
        setProgress(0);
        setStatus('running');

        let offLog: (() => void) | undefined;
        let offDone: (() => void) | undefined;

        offLog = api?.onLog((msg: string) => {
            setLogs(p => [...p, msg]);

            const mFound = msg.match(/Found (\d+) charts/);
            if (mFound?.[1]) setTileCount(parseInt(mFound[1]));

            // Matches "Capturing <title> 5/13"
            const mCap = msg.match(/Capturing .+ (\d+)\/(\d+)/);
            if (mCap?.[1] && mCap?.[2]) {
                setProgress(Math.round((parseInt(mCap[1]) / parseInt(mCap[2])) * 100));
            }
        });

        offDone = api?.onDone(({ success, session }: AzureDoneResult) => {
            setStatus(success ? 'done' : 'error');
            if (success) {
                setProgress(100);
                if (session) onCapturedRef.current(session);
            }
            offLog?.();
            offDone?.();
        });

        await api?.capture({
            dashboardUrl: currentSettings.dashboardUrl,
        });
    }, []);

    return { status, logs, tileCount, progress, capture };
}

// ════════════════════════════════════════════════════════════════════════════
// useAzureGallery  — sessions list + tile loading
// ════════════════════════════════════════════════════════════════════════════
export function useAzureGallery(jumpTo?: string | null) {
    const [sessions, setSessions] = useState<{ id: string; url: string | null }[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [images, setImages] = useState<AzureTileImage[]>([]);
    const [stats, setStats] = useState<string | null>(null);
    const [sessionUrl, setSessionUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(false);

    // Load session list on mount / when jumpTo changes
    useEffect(() => {
        api?.getSessions().then((list) => {
            setSessions(list);
            const pick = jumpTo ?? list[0]?.id ?? null;
            if (pick) loadSession(pick);
        });
    }, [jumpTo]);

    const loadSession = useCallback(async (session: string) => {
        setSelected(session);
        setImages([]);
        setStats(null);
        setSessionUrl(null);
        setLoading(true);
        const { images: imgs, stats: st, url } = await api?.getTiles(session) ?? { images: [], stats: null, url: null };
        setImages(imgs);
        setStats(st);
        setSessionUrl(url || null);
        setSessionUrl(url || null);
        setLoading(false);
    }, []);

    const clearSessions = useCallback(async () => {
        if (!api?.clearSessions) return;
        setLoading(true);
        await api.clearSessions();
        setSessions([]);
        setSelected(null);
        setImages([]);
        setStats(null);
        setSessionUrl(null);
        setLoading(false);
    }, []);

    return { sessions, selected, images, stats, sessionUrl, loading, loadSession, clearSessions };
}

// ════════════════════════════════════════════════════════════════════════════
// useAzureSettings  — load + persist settings via electron-store
// ════════════════════════════════════════════════════════════════════════════

const DEFAULTS: AzureSettings = {
    dashboardUrl: '',
    timezone: 'Asia/Singapore',
    waitSeconds: 60,
    hiDpi: true,
    headless: false,
};

export function useAzureSettings() {
    const [settings, setSettings] = useState<AzureSettings>(DEFAULTS);
    const [saved, setSaved] = useState<boolean>(false);

    // Load persisted settings on mount
    useEffect(() => {
        api?.getSettings().then((s: Partial<AzureSettings>) => {
            if (s && Object.keys(s).length > 0) {
                setSettings(p => ({ ...p, ...s }));
            }
        });
    }, []);

    const saveSettings = useCallback(async () => {
        await api?.saveSettings(settings);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    }, [settings]);

    return { settings, setSettings, saved, saveSettings };
}