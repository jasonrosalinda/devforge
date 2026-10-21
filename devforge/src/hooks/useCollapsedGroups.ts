import { useCallback, useEffect, useState } from "react";
import { restoreCollapsedGroups, toggleCollapsedGroup } from "@/lib/sidebar-groups";

const STORAGE_KEY = "devforge:sidebar-collapsed-groups";

function load(validGroups: readonly string[]): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return restoreCollapsedGroups(raw ? JSON.parse(raw) : null, validGroups);
    } catch {
        return [];
    }
}

/** Which sidebar groups are collapsed; survives restarts via localStorage. */
export function useCollapsedGroups(validGroups: readonly string[]) {
    const [collapsed, setCollapsed] = useState<string[]>(() => load(validGroups));

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
        } catch {
            // Blocked storage: groups just start expanded next time.
        }
    }, [collapsed]);

    const toggle = useCallback((group: string) => setCollapsed((c) => toggleCollapsedGroup(c, group)), []);
    const isCollapsed = useCallback((group: string) => collapsed.includes(group), [collapsed]);

    return { isCollapsed, toggle };
}
