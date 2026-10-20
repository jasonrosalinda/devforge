import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCopyIncludeRuns, setCopyIncludeRuns, subscribeCopyIncludeRuns } from './pagespeed-copy-prefs';

// The test environment is node, so localStorage is stubbed per test.
const memoryStorage = () => {
    const store = new Map<string, string>();
    return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
};

afterEach(() => vi.unstubAllGlobals());

describe('Copy for Teams "Include individual runs" preference', () => {
    it('defaults to including the runs', () => {
        vi.stubGlobal('localStorage', memoryStorage());
        expect(getCopyIncludeRuns()).toBe(true);
    });

    it('remembers a choice', () => {
        vi.stubGlobal('localStorage', memoryStorage());
        setCopyIncludeRuns(false);
        expect(getCopyIncludeRuns()).toBe(false);
        setCopyIncludeRuns(true);
        expect(getCopyIncludeRuns()).toBe(true);
    });

    it('notifies subscribers so both copy buttons stay in sync', () => {
        vi.stubGlobal('localStorage', memoryStorage());
        const listener = vi.fn();
        const unsubscribe = subscribeCopyIncludeRuns(listener);
        setCopyIncludeRuns(false);
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        setCopyIncludeRuns(true);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('falls back to including the runs when storage is unavailable', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => { throw new Error('blocked'); },
            setItem: () => { throw new Error('blocked'); },
        });
        expect(() => setCopyIncludeRuns(false)).not.toThrow();
        expect(getCopyIncludeRuns()).toBe(true);
    });
});
