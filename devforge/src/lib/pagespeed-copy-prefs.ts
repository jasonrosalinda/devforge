import { useSyncExternalStore } from 'react';

// "Include individual runs" for Copy for Teams — one choice shared by the page-level
// and the per-strategy buttons, remembered on this machine. A per-viewer convenience,
// so localStorage; every access is guarded because storage can be unavailable.

const KEY = 'devforge.pagespeed.copyIncludeRuns';
const listeners = new Set<() => void>();

/** Defaults to true — the copy has always included the runs. */
export function getCopyIncludeRuns(): boolean {
    try {
        return localStorage.getItem(KEY) !== 'false';
    } catch {
        return true;
    }
}

export function setCopyIncludeRuns(value: boolean): void {
    try {
        localStorage.setItem(KEY, String(value));
    } catch {
        // Storage blocked — the choice still applies for this session via listeners.
    }
    listeners.forEach(l => l());
}

export function subscribeCopyIncludeRuns(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useCopyIncludeRuns(): [boolean, (value: boolean) => void] {
    const value = useSyncExternalStore(subscribeCopyIncludeRuns, getCopyIncludeRuns, () => true);
    return [value, setCopyIncludeRuns];
}
