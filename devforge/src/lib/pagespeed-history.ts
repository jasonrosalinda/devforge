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

// Entries saved before runs/aggregation replaced runMode carry the old shape.
// Map the retired `runMode` onto the current fields so a restore never yields
// an undefined run count.
export type LegacyConfig = PageSpeedConfiguration & { runMode?: 'single' | 'average'; concurrency?: number };

export function migrateConfig(config: LegacyConfig): PageSpeedConfiguration {
    const { runMode, concurrency, ...rest } = config;
    void concurrency; // destructured only to strip the retired field
    return {
        ...rest,
        runs: rest.runs ?? (runMode === 'average' ? 3 : 1),
        aggregation: rest.aggregation ?? 'average',
    };
}

export function loadHistory(): PageSpeedHistorySnapshot[] {
    try {
        const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        if (!Array.isArray(v)) return [];
        return (v as PageSpeedHistorySnapshot[]).map(s => ({ ...s, config: migrateConfig(s.config) }));
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
