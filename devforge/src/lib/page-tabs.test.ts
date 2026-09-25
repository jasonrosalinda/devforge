import { describe, expect, it } from "vitest";
import {
    activateTabAt,
    closeTab,
    cycleTab,
    initialTabs,
    moveTab,
    openTab,
    restoreTabs,
    type TabsState,
} from "./page-tabs";

const HOME = "Home";
const state = (open: string[], active: string): TabsState => ({ open, active });

describe("openTab", () => {
    it("opens a new page right after the active tab and activates it", () => {
        expect(openTab(state([HOME, "A", "B"], "A"), "C")).toEqual(state([HOME, "A", "C", "B"], "C"));
    });

    it("activates an already-open page instead of opening a duplicate", () => {
        expect(openTab(state([HOME, "A", "B"], HOME), "B")).toEqual(state([HOME, "A", "B"], "B"));
    });

    it("returns the same object when the page is already active", () => {
        const s = state([HOME, "A"], "A");
        expect(openTab(s, "A")).toBe(s);
    });
});

describe("closeTab", () => {
    it("activates the right neighbour when closing the active tab", () => {
        expect(closeTab(state([HOME, "A", "B", "C"], "B"), "B", HOME)).toEqual(state([HOME, "A", "C"], "C"));
    });

    it("activates the left neighbour when closing the last tab", () => {
        expect(closeTab(state([HOME, "A", "B"], "B"), "B", HOME)).toEqual(state([HOME, "A"], "A"));
    });

    it("keeps the active tab when closing a background tab", () => {
        expect(closeTab(state([HOME, "A", "B"], "B"), "A", HOME)).toEqual(state([HOME, "B"], "B"));
    });

    it("never closes the pinned tab", () => {
        const s = state([HOME, "A"], HOME);
        expect(closeTab(s, HOME, HOME)).toBe(s);
    });

    it("falls back to the pinned tab when only it remains", () => {
        expect(closeTab(state([HOME, "A"], "A"), "A", HOME)).toEqual(initialTabs(HOME));
    });
});

describe("cycleTab / activateTabAt", () => {
    it("wraps forwards and backwards", () => {
        expect(cycleTab(state([HOME, "A", "B"], "B"), 1).active).toBe(HOME);
        expect(cycleTab(state([HOME, "A", "B"], HOME), -1).active).toBe("B");
    });

    it("ignores out-of-range positions", () => {
        const s = state([HOME, "A"], HOME);
        expect(activateTabAt(s, 5)).toBe(s);
        expect(activateTabAt(s, 1).active).toBe("A");
    });
});

describe("moveTab", () => {
    it("reorders a tab", () => {
        expect(moveTab(state([HOME, "A", "B", "C"], "A"), "C", 1, HOME).open).toEqual([HOME, "C", "A", "B"]);
    });

    it("keeps the pinned tab first", () => {
        expect(moveTab(state([HOME, "A", "B"], "A"), "B", 0, HOME).open).toEqual([HOME, "B", "A"]);
        const s = state([HOME, "A"], HOME);
        expect(moveTab(s, HOME, 1, HOME)).toBe(s);
    });
});

describe("restoreTabs", () => {
    const valid = [HOME, "A", "B"];

    it("restores a saved session", () => {
        expect(restoreTabs({ open: [HOME, "B", "A"], active: "A" }, valid, HOME)).toEqual(state([HOME, "B", "A"], "A"));
    });

    it("drops unknown titles and duplicates, and re-pins Home first", () => {
        expect(restoreTabs({ open: ["B", "Gone", "B", HOME, 42], active: "Gone" }, valid, HOME))
            .toEqual(state([HOME, "B"], HOME));
    });

    it("falls back to Home for junk input", () => {
        expect(restoreTabs(null, valid, HOME)).toEqual(initialTabs(HOME));
        expect(restoreTabs("nope", valid, HOME)).toEqual(initialTabs(HOME));
        expect(restoreTabs({ open: "A" }, valid, HOME)).toEqual(initialTabs(HOME));
    });
});
