import { describe, it, expect } from "vitest";
import { restoreCollapsedGroups, toggleCollapsedGroup } from "./sidebar-groups";

const GROUPS = ["Monitoring", "Web quality", "Release", "Utilities"];

describe("restoreCollapsedGroups", () => {
    it("starts with every group expanded", () => {
        expect(restoreCollapsedGroups(null, GROUPS)).toEqual([]);
        expect(restoreCollapsedGroups({ Utilities: true }, GROUPS)).toEqual([]);
    });

    it("keeps only groups that still exist, in sidebar order", () => {
        expect(restoreCollapsedGroups(["Utilities", "Gone", 3, "Monitoring"], GROUPS)).toEqual(["Monitoring", "Utilities"]);
    });
});

describe("toggleCollapsedGroup", () => {
    it("collapses an expanded group and expands a collapsed one", () => {
        const collapsed = toggleCollapsedGroup([], "Utilities");
        expect(collapsed).toEqual(["Utilities"]);
        expect(toggleCollapsedGroup(collapsed, "Utilities")).toEqual([]);
    });

    it("leaves other groups alone", () => {
        expect(toggleCollapsedGroup(["Release"], "Utilities")).toEqual(["Release", "Utilities"]);
    });
});
