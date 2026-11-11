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
    meta: Pick<InvestigationMeta, 'repoRoot' | 'branch' | 'head' | 'durationMs' | 'warnings' | 'otherRepoRoot' | 'otherTarget'>;
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

export const MAX_EARLIER = 3;
const EARLIER_REPORT_CHARS = 20000;

/**
 * Past investigations of the same app for the agent, newest first, so a recurring cause is
 * called recurring. An entry whose window overlaps this one is left out: a re-run of the
 * same incident would otherwise anchor on its own earlier conclusion. Pure.
 */
export function earlierInvestigations(
    entries: InvestigationHistoryEntry[], appKey: string, window: { startMs: number; endMs: number },
): Array<{ startMs: number; endMs: number; question: string; report: string }> {
    return entries
        .filter(e => e.interpretation?.appKey === appKey
            && (e.interpretation.endMs <= window.startMs || e.interpretation.startMs >= window.endMs)
            // Reports from before 11 Nov 2026 were written without Restarts, SNAT and the fixed
            // detector, and some concluded "not captured": they are not fed back as context.
            && /^## Evidences\b/m.test(e.report))
        .slice(0, MAX_EARLIER)
        .map(e => ({
            startMs: e.interpretation.startMs, endMs: e.interpretation.endMs,
            question: e.interpretation.question, report: e.report.slice(0, EARLIER_REPORT_CHARS),
        }));
}

export function deleteInvestigation(id: string): InvestigationHistoryEntry[] {
    const entries = loadInvestigationHistory().filter(e => e.id !== id);
    write(entries);
    return entries;
}
