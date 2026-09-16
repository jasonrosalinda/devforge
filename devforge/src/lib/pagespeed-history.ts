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
    // Full Assessment — the repository investigation. Expensive to regenerate, so the
    // report is kept; the repo path deliberately is NOT, so an exported snapshot never
    // carries someone's local directory layout.
    pageDeepDive?: { markdown: string; beforeRef: string; afterRef: string } | null;
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
        comparisonColumns: rest.comparisonColumns ?? 'both',
    };
}

// `runHistory` is most of a snapshot's bytes, and most of that is `details.items`.
// Only one run contributes `opportunities` to the aggregate and to the evidence diff
// (the one whose fetchTime the aggregate kept), so every other run can shed its
// detail tables. Titles, scores and savings survive — only the per-resource rows of
// the non-representative runs are dropped.
export function slimForStorage(slot: SerializedAuditSlot): SerializedAuditSlot {
    if (!slot || typeof slot !== 'object' || !slot.runHistory?.length) return slot;
    const keepIdx = slot.runHistory.findIndex(r => r.fetchTime === slot.fetchTime);
    return {
        ...slot,
        runHistory: slot.runHistory.map((run, i) => i === keepIdx ? run : {
            ...run,
            ...(run.opportunities
                ? { opportunities: run.opportunities.map(({ details, ...rest }) => rest) }
                : {}),
        }),
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

// Returns the new list plus whatever went wrong. A silently dropped save looks
// identical to a successful one, which is how a full history quietly ate runs.
export function saveSnapshot(snapshot: PageSpeedHistorySnapshot): { entries: PageSpeedHistorySnapshot[]; error?: string } {
    const next = [snapshot, ...loadHistory().filter(s => s.id !== snapshot.id)].slice(0, MAX_ENTRIES);
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch (err) {
        const quota = err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
        return {
            entries: loadHistory(),
            error: quota
                ? 'History storage is full — this run was not saved. Delete some saved runs and try again.'
                : `History could not be saved: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    return { entries: next };
}

export function deleteSnapshot(id: string): PageSpeedHistorySnapshot[] {
    const next = loadHistory().filter(s => s.id !== id);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore quota */ }
    return next;
}

export function clearHistory(): void {
    try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
}
