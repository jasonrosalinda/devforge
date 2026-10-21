import type { TelemetryChartSpec, TelemetryTarget } from '@shared/types/telemetry.types';

/**
 * Saved Ask Telemetry queries and recent questions, in localStorage.
 *
 * A saved query keeps its KQL, so running it again needs no Claude call — only the
 * time range changes. Nothing here is secret (no tokens, no telemetry rows), which
 * is why it sits in plain localStorage like the PageSpeed history.
 */

const LIBRARY_KEY = 'telemetry:library';
const RECENT_KEY = 'telemetry:recent';
export const MAX_SAVED = 100;
export const MAX_RECENT = 20;

export interface SavedTelemetryQuery {
    id: string;
    name: string;
    question: string;
    kql: string;
    appKey: string;
    target: TelemetryTarget;
    chart?: TelemetryChartSpec | undefined;
    savedAt: string; // ISO
}

function read<T>(key: string): T[] {
    try {
        const raw = localStorage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function write(key: string, value: unknown): string | undefined {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return undefined;
    } catch (e) {
        const quota = e instanceof DOMException && (e.name === 'QuotaExceededError' || e.code === 22);
        return quota ? 'Storage is full — delete some saved queries and try again.' : 'Could not save.';
    }
}

export const loadLibrary = (): SavedTelemetryQuery[] => read<SavedTelemetryQuery>(LIBRARY_KEY);

const sameQuery = (a: SavedTelemetryQuery, b: Omit<SavedTelemetryQuery, 'id' | 'savedAt'>) =>
    a.kql.trim() === b.kql.trim() && a.appKey === b.appKey && a.target === b.target;

/**
 * Save a query, newest first. Saving the same KQL for the same app again renames
 * the existing entry instead of adding a duplicate.
 */
export function saveQuery(
    entry: Omit<SavedTelemetryQuery, 'id' | 'savedAt'>,
    now: Date = new Date(),
): { entries: SavedTelemetryQuery[]; error?: string } {
    const existing = loadLibrary();
    const prior = existing.find(e => sameQuery(e, entry));
    const saved: SavedTelemetryQuery = {
        ...entry,
        id: prior?.id ?? `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        savedAt: now.toISOString(),
    };
    const entries = [saved, ...existing.filter(e => e !== prior)].slice(0, MAX_SAVED);
    const error = write(LIBRARY_KEY, entries);
    return error ? { entries: existing, error } : { entries };
}

export function renameQuery(id: string, name: string): SavedTelemetryQuery[] {
    const entries = loadLibrary().map(e => (e.id === id ? { ...e, name: name.trim() || e.name } : e));
    write(LIBRARY_KEY, entries);
    return entries;
}

export function deleteQuery(id: string): SavedTelemetryQuery[] {
    const entries = loadLibrary().filter(e => e.id !== id);
    write(LIBRARY_KEY, entries);
    return entries;
}

export const loadRecent = (): string[] => read<string>(RECENT_KEY).filter(q => typeof q === 'string');

/** Remember a question, most recent first, without duplicates (case-insensitive). */
export function pushRecent(question: string): string[] {
    const q = question.trim();
    if (!q) return loadRecent();
    const entries = [q, ...loadRecent().filter(r => r.toLowerCase() !== q.toLowerCase())].slice(0, MAX_RECENT);
    write(RECENT_KEY, entries);
    return entries;
}
