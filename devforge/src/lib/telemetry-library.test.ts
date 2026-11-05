// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_ALERT_RULE, MAX_RECENT, MAX_SAVED, deleteQuery, loadLibrary, loadRecent, pushRecent, renameQuery, saveQuery, setQueryAlert,
} from './telemetry-library';

const entry = (over: Partial<Parameters<typeof saveQuery>[0]> = {}) => ({
    name: 'Slow endpoints',
    question: 'which endpoints are slow?',
    kql: 'requests | summarize p95=percentile(duration, 95) by name',
    appKey: 'prdmeduapp',
    target: 'fe' as const,
    ...over,
});

/** A storage that reads what the real one holds but refuses every write. */
function stubFailingStorage(error: Error) {
    const real = localStorage;
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => real.getItem(key),
        setItem: () => { throw error; },
    });
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('saved queries', () => {
    it('saves newest first with an id and timestamp', () => {
        saveQuery(entry({ kql: 'requests | count' }), new Date('2026-10-20T00:00:00Z'));
        const { entries, error } = saveQuery(entry(), new Date('2026-10-21T00:00:00Z'));
        expect(error).toBeUndefined();
        expect(entries.map(e => e.kql)).toEqual([entry().kql, 'requests | count']);
        expect(entries[0]!.savedAt).toBe('2026-10-21T00:00:00.000Z');
        expect(entries[0]!.id).toBeTruthy();
        expect(loadLibrary()).toEqual(entries);
    });

    it('replaces the same query for the same app instead of duplicating it', () => {
        const first = saveQuery(entry()).entries[0]!;
        const { entries } = saveQuery(entry({ name: 'Renamed', kql: `  ${entry().kql}  ` }));
        expect(entries).toHaveLength(1);
        expect(entries[0]!.id).toBe(first.id);
        expect(entries[0]!.name).toBe('Renamed');
        // A different target is a different query.
        expect(saveQuery(entry({ target: 'api' })).entries).toHaveLength(2);
    });

    it(`keeps at most ${MAX_SAVED}`, () => {
        for (let i = 0; i < MAX_SAVED + 3; i++) saveQuery(entry({ kql: `requests | take ${i}` }));
        expect(loadLibrary()).toHaveLength(MAX_SAVED);
    });

    it('renames and deletes', () => {
        const { id } = saveQuery(entry()).entries[0]!;
        expect(renameQuery(id, '  Better name ')[0]!.name).toBe('Better name');
        expect(renameQuery(id, '   ')[0]!.name).toBe('Better name');
        expect(deleteQuery(id)).toEqual([]);
        expect(loadLibrary()).toEqual([]);
    });

    it('reports a full store and keeps the old entries', () => {
        saveQuery(entry({ kql: 'requests | count' }));
        stubFailingStorage(new DOMException('full', 'QuotaExceededError'));
        const { entries, error } = saveQuery(entry());
        expect(error).toMatch(/Storage is full/);
        expect(entries.map(e => e.kql)).toEqual(['requests | count']);
    });

    it('reports any other write failure', () => {
        stubFailingStorage(new Error('nope'));
        expect(saveQuery(entry()).error).toBe('Could not save.');
    });

    it('reads corrupt or non-array storage as empty', () => {
        localStorage.setItem('telemetry:library', '{not json');
        expect(loadLibrary()).toEqual([]);
        localStorage.setItem('telemetry:library', '{"a":1}');
        expect(loadLibrary()).toEqual([]);
    });
});

describe('alert rules', () => {
    it('sets, replaces and removes a rule on one query only', () => {
        saveQuery(entry({ kql: 'a' }));
        const { entries } = saveQuery(entry({ kql: 'b' }));
        const id = entries[0]!.id;
        expect(setQueryAlert(id, DEFAULT_ALERT_RULE).entries.find(e => e.id === id)!.alert).toEqual(DEFAULT_ALERT_RULE);
        expect(loadLibrary().find(e => e.id !== id)!.alert).toBeUndefined();
        const column = { ...DEFAULT_ALERT_RULE, kind: 'column' as const, column: 'p95', threshold: 2000 };
        expect(setQueryAlert(id, column).entries[0]!.alert).toEqual(column);
        const removed = setQueryAlert(id, undefined).entries[0]!;
        expect(removed).not.toHaveProperty('alert');
    });

    it('keeps the rule when the same query is saved again', () => {
        const { entries } = saveQuery(entry());
        setQueryAlert(entries[0]!.id, DEFAULT_ALERT_RULE);
        const resaved = saveQuery(entry({ name: 'Renamed' })).entries;
        expect(resaved).toHaveLength(1);
        expect(resaved[0]).toMatchObject({ name: 'Renamed', alert: DEFAULT_ALERT_RULE });
    });

    it('reports a failed write and keeps the old entries', () => {
        const { entries } = saveQuery(entry());
        stubFailingStorage(new Error('nope'));
        const out = setQueryAlert(entries[0]!.id, DEFAULT_ALERT_RULE);
        expect(out.error).toBe('Could not save.');
        expect(out.entries[0]!.alert).toBeUndefined();
    });
});

describe('recent questions', () => {
    it('keeps the latest first without case-insensitive duplicates', () => {
        pushRecent('slow endpoints');
        pushRecent('errors');
        expect(pushRecent('  Slow Endpoints ')).toEqual(['Slow Endpoints', 'errors']);
        expect(loadRecent()).toEqual(['Slow Endpoints', 'errors']);
    });

    it('ignores blank questions', () => {
        pushRecent('a');
        expect(pushRecent('   ')).toEqual(['a']);
    });

    it(`keeps at most ${MAX_RECENT}`, () => {
        for (let i = 0; i < MAX_RECENT + 5; i++) pushRecent(`q${i}`);
        expect(loadRecent()).toHaveLength(MAX_RECENT);
        expect(loadRecent()[0]).toBe(`q${MAX_RECENT + 4}`);
    });
});
