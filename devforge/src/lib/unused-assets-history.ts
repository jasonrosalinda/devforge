import type { ReviewVerdict, ScanResult } from "@/types/unusedAssets.types";

const HISTORY_KEY = "unused-assets:history";
const MAX_ENTRIES = 20;

export interface UnusedAssetsHistorySnapshot {
    id: string;
    savedAt: string; // ISO
    folderName: string | null;
    gitBranch: string | null;
    result: ScanResult;
    verdicts: Record<string, ReviewVerdict>;
}

export function loadHistory(): UnusedAssetsHistorySnapshot[] {
    try {
        const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
        return Array.isArray(v) ? (v as UnusedAssetsHistorySnapshot[]) : [];
    } catch {
        return [];
    }
}

export function saveSnapshot(snapshot: UnusedAssetsHistorySnapshot): UnusedAssetsHistorySnapshot[] {
    const next = [snapshot, ...loadHistory().filter((s) => s.id !== snapshot.id)].slice(0, MAX_ENTRIES);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
    return next;
}

export function deleteSnapshot(id: string): UnusedAssetsHistorySnapshot[] {
    const next = loadHistory().filter((s) => s.id !== id);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
    return next;
}

export function clearHistory(): void {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
