import { describe, expect, it } from "vitest";
import {
    WORLD_OFFSETS,
    fixedOffsetZone,
    formatInZone,
    fromWallClock,
    offsetLabel,
    parseFixedOffset,
    parseDateTimeInput,
    relativeTo,
    toWallClockText,
    zoneOffsetMinutes,
} from "./datetime";

const iso = (r: ReturnType<typeof parseDateTimeInput>) => (r.ok ? r.date.toISOString() : r.error);

describe("parseDateTimeInput", () => {
    it("reads Unix seconds and milliseconds", () => {
        const s = parseDateTimeInput("1758800000", "UTC");
        expect(s.ok && s.kind).toBe("unix-seconds");
        expect(iso(s)).toBe("2025-09-25T11:33:20.000Z");

        const ms = parseDateTimeInput("1758800000123", "UTC");
        expect(ms.ok && ms.kind).toBe("unix-millis");
        expect(iso(ms)).toBe("2025-09-25T11:33:20.123Z");
    });

    it("rejects timestamps of the wrong length", () => {
        expect(parseDateTimeInput("12345", "UTC").ok).toBe(false);
    });

    it("reads a wall-clock time in the source zone", () => {
        expect(iso(parseDateTimeInput("2026-09-25 19:36", "Asia/Singapore"))).toBe("2026-09-25T11:36:00.000Z");
        expect(iso(parseDateTimeInput("2026-09-25T19:36:05", "UTC"))).toBe("2026-09-25T19:36:05.000Z");
        expect(iso(parseDateTimeInput("2026-09-25", "UTC"))).toBe("2026-09-25T00:00:00.000Z");
    });

    it("honours an explicit offset regardless of the source zone", () => {
        const r = parseDateTimeInput("2026-09-25T11:36:00Z", "Asia/Singapore");
        expect(r.ok && r.kind).toBe("absolute");
        expect(iso(r)).toBe("2026-09-25T11:36:00.000Z");
        expect(iso(parseDateTimeInput("2026-09-25T19:36:00+08:00", "UTC"))).toBe("2026-09-25T11:36:00.000Z");
    });

    it("rejects out-of-range fields, unknown zones and garbage", () => {
        expect(parseDateTimeInput("2026-13-01 10:00", "UTC").ok).toBe(false);
        expect(parseDateTimeInput("2026-09-25 25:00", "UTC").ok).toBe(false);
        expect(parseDateTimeInput("2026-09-25 10:00", "Mars/Olympus").ok).toBe(false);
        expect(parseDateTimeInput("next tuesday", "UTC").ok).toBe(false);
        expect(parseDateTimeInput("   ", "UTC").ok).toBe(false);
    });
});

describe("zones", () => {
    it("computes offsets, including half-hour zones", () => {
        const at = new Date("2026-01-15T12:00:00Z");
        expect(zoneOffsetMinutes(at, "Asia/Singapore")).toBe(480);
        expect(zoneOffsetMinutes(at, "Asia/Kolkata")).toBe(330);
        expect(offsetLabel(at, "Asia/Kolkata")).toBe("GMT+5:30");
        expect(offsetLabel(at, "UTC")).toBe("GMT");
        expect(offsetLabel(at, "America/New_York")).toBe("GMT-5");
    });

    it("resolves wall-clock times across a DST change", () => {
        // New York is on EDT (UTC-4) in July and EST (UTC-5) in January.
        const summer = fromWallClock({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0, ms: 0 }, "America/New_York");
        const winter = fromWallClock({ year: 2026, month: 1, day: 1, hour: 9, minute: 0, second: 0, ms: 0 }, "America/New_York");
        expect(summer.toISOString()).toBe("2026-07-01T13:00:00.000Z");
        expect(winter.toISOString()).toBe("2026-01-01T14:00:00.000Z");
    });

    it("round-trips through the wall-clock text form", () => {
        const date = new Date("2026-09-25T11:36:00Z");
        expect(toWallClockText(date, "Asia/Singapore")).toBe("2026-09-25 19:36");
        expect(iso(parseDateTimeInput(toWallClockText(date, "Asia/Singapore"), "Asia/Singapore"))).toBe(date.toISOString());
    });
});

describe("fixed offsets", () => {
    it("parses and prints GMT±h[:mm]", () => {
        expect(parseFixedOffset("GMT+8")).toBe(480);
        expect(parseFixedOffset("GMT-3:30")).toBe(-210);
        expect(parseFixedOffset("GMT+5:45")).toBe(345);
        expect(parseFixedOffset("GMT+15")).toBeNull();
        expect(parseFixedOffset("Europe/London")).toBeNull();
        expect(fixedOffsetZone(330)).toBe("GMT+5:30");
        expect(fixedOffsetZone(-300)).toBe("GMT-5");
        expect(fixedOffsetZone(0)).toBe("UTC");
    });

    it("converts without daylight saving", () => {
        const date = new Date("2026-07-01T12:00:00Z");
        expect(formatInZone(date, "GMT+5:30")).toContain("17:30:00");
        expect(formatInZone(date, "GMT-5")).toContain("07:00:00");
        expect(toWallClockText(date, "GMT+8")).toBe("2026-07-01 20:00");
        expect(iso(parseDateTimeInput("2026-07-01 20:00", "GMT+8"))).toBe("2026-07-01T12:00:00.000Z");
        expect(offsetLabel(date, "GMT-3:30")).toBe("GMT-3:30");
    });

    it("lists each world offset once, sorted", () => {
        const minutes = WORLD_OFFSETS.map((o) => o.minutes);
        expect(new Set(minutes).size).toBe(minutes.length);
        expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
        expect(minutes).not.toContain(0);
    });
});

describe("relativeTo", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    it("picks the largest sensible unit", () => {
        expect(relativeTo(new Date("2026-09-25T15:00:00Z"), now)).toMatch(/3 hours/);
        expect(relativeTo(new Date("2026-09-23T12:00:00Z"), now)).toMatch(/2 days ago/);
        expect(relativeTo(now, now)).toMatch(/now/);
    });
});
