import type { PageSpeedConfiguration, PageSpeedInsightResult } from '@shared/types/pageSpeedInsight.types';

const HISTORY_KEY = 'pagespeed:history';
const MAX_ENTRIES = 25;

// Serialized audit slot. A saved run never holds `null` (loading) — `undefined`
// slots become `null` through JSON, and restore maps them back to `undefined`.
export type SerializedAuditSlot = PageSpeedInsightResult | false | null;

export interface SerializedTimes {
    start: string | null;
    end: string | null;
}

export interface StrategySnapshot {
    results1: SerializedAuditSlot[];
    results2: SerializedAuditSlot[];
    times1: SerializedTimes;
    times2: SerializedTimes;
    auditStart: string | null;
    auditEnd: string | null;
    analyses: Record<number, { status: 'running' | 'done' | 'error'; markdown: string; error: string | null }>;
}

export interface PageSpeedHistorySnapshot {
    id: string;
    savedAt: string; // ISO
    config: PageSpeedConfiguration; // stored without apiKey
    desktop: StrategySnapshot;
    mobile: StrategySnapshot;
    // Page-level Claude analysis (Desktop + Mobile combined); absent on older entries.
    pageAnalysis?: { markdown: string } | null;
}

export function loadHistory(): PageSpeedHistorySnapshot[] {
    try {
        const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        return Array.isArray(v) ? (v as PageSpeedHistorySnapshot[]) : [];
    } catch {
        return [];
    }
}

export function saveSnapshot(snapshot: PageSpeedHistorySnapshot): PageSpeedHistorySnapshot[] {
    const next = [snapshot, ...loadHistory().filter(s => s.id !== snapshot.id)].slice(0, MAX_ENTRIES);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
    return next;
}

export function deleteSnapshot(id: string): PageSpeedHistorySnapshot[] {
    const next = loadHistory().filter(s => s.id !== id);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
    return next;
}

export function clearHistory(): void {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
