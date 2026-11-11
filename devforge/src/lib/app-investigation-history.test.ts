// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
    MAX_ENTRIES, deleteInvestigation, earlierInvestigations, loadInvestigationHistory, saveInvestigation, type InvestigationHistoryEntry,
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

describe('earlierInvestigations', () => {
    const H = 3600_000;
    const entry = (id: string, appKey: string, startMs: number, endMs: number): InvestigationHistoryEntry => ({
        id, at: endMs, query: id, report: `## Summary\n${id}\n\n## Evidences\n- x`,
        interpretation: { appKey, target: 'app', startMs, endMs, windowSource: 'page', category: 'errors', symptoms: [], question: `why ${id}` },
        meta: { repoRoot: 'r', branch: 'b', head: 'h', warnings: [] },
    });

    it('takes the newest three of the same app and leaves out any overlapping this window', () => {
        const now = { startMs: 100 * H, endMs: 102 * H };
        const list = [
            entry('rerun', 'medu', 101 * H, 103 * H),   // overlaps: a re-run of this incident
            entry('a', 'medu', 90 * H, 91 * H),
            entry('msp', 'msp', 80 * H, 81 * H),
            entry('b', 'medu', 70 * H, 71 * H),
            entry('c', 'medu', 60 * H, 61 * H),
            entry('d', 'medu', 50 * H, 51 * H),
        ];
        const out = earlierInvestigations(list, 'medu', now);
        expect(out.map(e => e.question)).toEqual(['why a', 'why b', 'why c']);
        expect(out[0]).toEqual({ startMs: 90 * H, endMs: 91 * H, question: 'why a', report: '## Summary\na\n\n## Evidences\n- x' });
    });

    it('leaves out reports from before the Evidences format, whose conclusions predate the fixes', () => {
        const old = { ...entry('old', 'medu', 10 * H, 11 * H), report: '## Summary\nRestarts not captured.\n\n## Azure Evidence\n- x' };
        expect(earlierInvestigations([old], 'medu', { startMs: 100 * H, endMs: 101 * H })).toEqual([]);
    });
});
