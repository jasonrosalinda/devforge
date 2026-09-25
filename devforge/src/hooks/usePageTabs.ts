import { useCallback, useEffect, useState } from "react";
import {
    activateTabAt,
    closeTab,
    cycleTab,
    moveTab,
    openTab,
    restoreTabs,
    type TabsState,
} from "@/lib/page-tabs";

const STORAGE_KEY = "devforge:tabs";

function load(validTitles: readonly string[], pinned: string): TabsState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return restoreTabs(raw ? JSON.parse(raw) : null, validTitles, pinned);
    } catch {
        return restoreTabs(null, validTitles, pinned);
    }
}

/**
 * Open-page tabs for the shell. The session (open tabs + active tab) survives an
 * app restart via localStorage; storage failures just mean starting from Home.
 */
export function usePageTabs(validTitles: readonly string[], pinned: string) {
    const [tabs, setTabs] = useState<TabsState>(() => load(validTitles, pinned));

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
        } catch {
            // Private window / blocked storage: the session just won't be restored.
        }
    }, [tabs]);

    const open = useCallback((title: string) => setTabs((s) => openTab(s, title)), []);
    const close = useCallback((title: string) => setTabs((s) => closeTab(s, title, pinned)), [pinned]);
    const cycle = useCallback((step: number) => setTabs((s) => cycleTab(s, step)), []);
    const activateAt = useCallback((index: number) => setTabs((s) => activateTabAt(s, index)), []);
    const move = useCallback((title: string, toIndex: number) => setTabs((s) => moveTab(s, title, toIndex, pinned)), [pinned]);

    return { openTabs: tabs.open, activeTab: tabs.active, open, close, cycle, activateAt, move };
}
