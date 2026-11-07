import type { InvestigationInterpretation, InvestigationMeta } from '@shared/types/app-investigation.types';

/**
 * Finished App Investigation reports, newest first, in localStorage.
 *
 * Only the report and what is needed to read it back are kept — not the Azure
 * telemetry report, which is large and is re-collected if an RCA is generated from a
 * restored entry. Nothing here is secret: the agent is told never to print one.
 */

const KEY = 'app-investigation:history';
export const MAX_ENTRIES = 20;

export interface InvestigationHistoryEntry {
    id: string;
    at: number;
    query: string;
    interpretation: InvestigationInterpretation;
    report: string;
    meta: Pick<InvestigationMeta, 'repoRoot' | 'branch' | 'head' | 'durationMs' | 'warnings'>;
}

/** A stored entry's meta in the shape the page renders (no per-run token or tool detail). */
export const metaOf = (entry: InvestigationHistoryEntry): InvestigationMeta => ({ ...entry.meta, deniedTools: [] });

export function loadInvestigationHistory(): InvestigationHistoryEntry[] {
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter(e => e && typeof e.id === 'string' && typeof e.report === 'string') : [];
    } catch {
        return [];
    }
}

function write(entries: InvestigationHistoryEntry[]): string | undefined {
    try {
        localStorage.setItem(KEY, JSON.stringify(entries));
        return undefined;
    } catch {
        return 'Could not save to history — storage may be full. Delete some entries.';
    }
}

/** Adds an entry at the top and trims to MAX_ENTRIES. */
export function saveInvestigation(entry: InvestigationHistoryEntry): { entries: InvestigationHistoryEntry[]; error?: string | undefined } {
    const entries = [entry, ...loadInvestigationHistory().filter(e => e.id !== entry.id)].slice(0, MAX_ENTRIES);
    return { entries, error: write(entries) };
}

export function deleteInvestigation(id: string): InvestigationHistoryEntry[] {
    const entries = loadInvestigationHistory().filter(e => e.id !== id);
    write(entries);
    return entries;
}
