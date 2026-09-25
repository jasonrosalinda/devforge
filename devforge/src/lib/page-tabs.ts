/**
 * Browser-style tab model for the app shell. One tab per page (keyed by page
 * title); the pinned tab is always first and can't be closed or moved, so there
 * is always at least one tab open.
 *
 * Kept free of React so the rules can be unit-tested directly.
 */

export interface TabsState {
    open: string[];
    active: string;
}

export function initialTabs(pinned: string): TabsState {
    return { open: [pinned], active: pinned };
}

/** Activate the page's tab if it is already open, otherwise open it right after the active tab. */
export function openTab(state: TabsState, title: string): TabsState {
    if (state.open.includes(title)) {
        return state.active === title ? state : { ...state, active: title };
    }
    const at = state.open.indexOf(state.active) + 1;
    const open = [...state.open.slice(0, at), title, ...state.open.slice(at)];
    return { open, active: title };
}

/** Close a tab. Closing the active one activates its right neighbour, or the left one at the end. */
export function closeTab(state: TabsState, title: string, pinned: string): TabsState {
    if (title === pinned) return state;
    const index = state.open.indexOf(title);
    if (index === -1) return state;

    const open = state.open.filter((t) => t !== title);
    if (state.active !== title) return { ...state, open };

    const next = open[index] ?? open[index - 1] ?? pinned;
    return { open, active: next };
}

/** Move the active tab `step` places along the strip, wrapping at either end. */
export function cycleTab(state: TabsState, step: number): TabsState {
    const count = state.open.length;
    if (count < 2) return state;
    const index = state.open.indexOf(state.active);
    const next = state.open[(((index + step) % count) + count) % count];
    return next ? { ...state, active: next } : state;
}

/** Activate the tab at a 0-based position; out of range is a no-op. */
export function activateTabAt(state: TabsState, index: number): TabsState {
    const title = state.open[index];
    return title && title !== state.active ? { ...state, active: title } : state;
}

/** Drag-reorder. The pinned tab stays at position 0. */
export function moveTab(state: TabsState, title: string, toIndex: number, pinned: string): TabsState {
    if (title === pinned) return state;
    const from = state.open.indexOf(title);
    if (from === -1) return state;

    const without = state.open.filter((t) => t !== title);
    const to = Math.max(1, Math.min(toIndex, without.length));
    if (to === from) return state;
    return { ...state, open: [...without.slice(0, to), title, ...without.slice(to)] };
}

/**
 * Rebuild state from whatever was persisted. Drops titles that are no longer
 * pages (renamed/removed since the last session), duplicates and junk, and
 * falls back to the pinned tab when nothing usable is left.
 */
export function restoreTabs(raw: unknown, validTitles: readonly string[], pinned: string): TabsState {
    const fallback = initialTabs(pinned);
    if (!raw || typeof raw !== "object") return fallback;

    const { open, active } = raw as { open?: unknown; active?: unknown };
    if (!Array.isArray(open)) return fallback;

    const valid = new Set(validTitles);
    const seen = new Set<string>([pinned]);
    const restored = [pinned];
    for (const t of open) {
        if (typeof t === "string" && valid.has(t) && !seen.has(t)) {
            seen.add(t);
            restored.push(t);
        }
    }

    const restoredActive = typeof active === "string" && seen.has(active) ? active : pinned;
    return { open: restored, active: restoredActive };
}
