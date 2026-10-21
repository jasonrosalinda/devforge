import { describe, it, expect } from "vitest";
import { formatPlan, formatReset, usageErrorText, usageSeverity } from "./claude-usage";

const NOW = Date.parse("2026-10-21T13:00:00Z");

describe("usageSeverity", () => {
    it.each([
        [0, "normal"],
        [69, "normal"],
        [70, "warning"],
        [89, "warning"],
        [90, "critical"],
        [100, "critical"],
    ])("%i%% → %s", (pct, expected) => {
        expect(usageSeverity(pct)).toBe(expected);
    });
});

describe("formatReset", () => {
    it("is empty without a usable time", () => {
        expect(formatReset(null, NOW)).toBe("");
        expect(formatReset("not a date", NOW)).toBe("");
    });

    it("says now once the window has reset", () => {
        expect(formatReset("2026-10-21T12:59:00Z", NOW)).toBe("now");
    });

    it("counts minutes under an hour, rounding up", () => {
        expect(formatReset("2026-10-21T13:34:10Z", NOW)).toBe("35m");
    });

    it("counts hours and minutes under a day", () => {
        expect(formatReset("2026-10-21T15:20:00Z", NOW)).toBe("2h 20m");
        expect(formatReset("2026-10-22T12:59:00Z", NOW)).toBe("23h 59m");
    });

    it("shows weekday and local time a day or more out", () => {
        const at = "2026-10-22T20:00:00Z";
        const expected = new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
        expect(formatReset(at, NOW)).toBe(expected);
    });

    it("rounds a weekday reset to the nearest minute", () => {
        expect(formatReset("2026-10-22T19:59:59Z", NOW)).toBe(formatReset("2026-10-22T20:00:00Z", NOW));
    });
});

describe("formatPlan", () => {
    it("capitalises the plan and blanks a missing one", () => {
        expect(formatPlan("team")).toBe("Team");
        expect(formatPlan(null)).toBe("");
    });
});

describe("usageErrorText", () => {
    it("explains sign-in problems and falls back to a retry hint", () => {
        expect(usageErrorText("NOT_SIGNED_IN")).toBe("Sign in to Claude Code to see usage");
        expect(usageErrorText("EXPIRED")).toBe("Login expired — run claude to refresh");
        expect(usageErrorText("NETWORK")).toBe("Usage unavailable — click to retry");
    });
});
