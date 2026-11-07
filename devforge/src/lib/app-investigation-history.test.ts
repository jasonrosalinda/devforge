// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
    MAX_ENTRIES, deleteInvestigation, loadInvestigationHistory, saveInvestigation, type InvestigationHistoryEntry,
} from './app-investigation-history';

const entry = (id: string): InvestigationHistoryEntry => ({
    id,
    at: Number(id.replace(/\D/g, '')) || 0,
    query: `query ${id}`,
    interpretation: {
        appKey: 'prdmeduapp', target: 'app', startMs: 1, endMs: 2, windowSource: 'page', category: 'errors', symptoms: [], question: 'q',
    },
    report: '## Summary\nx',
    meta: { repoRoot: 'C:/r', branch: 'main', head: 'abc', warnings: [] },
});

describe('app-investigation-history', () => {
    beforeEach(() => localStorage.clear());

    it('starts empty and survives corrupt storage', () => {
        expect(loadInvestigationHistory()).toEqual([]);
        localStorage.setItem('app-investigation:history', '{not json');
        expect(loadInvestigationHistory()).toEqual([]);
        localStorage.setItem('app-investigation:history', JSON.stringify([{ id: 1 }, entry('e1')]));
        expect(loadInvestigationHistory().map(e => e.id)).toEqual(['e1']);
    });

    it('keeps newest first, replaces the same id and caps the list', () => {
        for (let i = 0; i < MAX_ENTRIES + 5; i++) saveInvestigation(entry(`e${i}`));
        let all = loadInvestigationHistory();
        expect(all).toHaveLength(MAX_ENTRIES);
        expect(all[0]!.id).toBe(`e${MAX_ENTRIES + 4}`);

        saveInvestigation({ ...entry('e10'), query: 'updated' });
        all = loadInvestigationHistory();
        expect(all[0]).toMatchObject({ id: 'e10', query: 'updated' });
        expect(all.filter(e => e.id === 'e10')).toHaveLength(1);
    });

    it('deletes by id', () => {
        saveInvestigation(entry('a'));
        saveInvestigation(entry('b'));
        expect(deleteInvestigation('a').map(e => e.id)).toEqual(['b']);
        expect(loadInvestigationHistory().map(e => e.id)).toEqual(['b']);
    });
});
