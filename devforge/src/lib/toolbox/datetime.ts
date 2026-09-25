/**
 * Date/time conversion for the DateTime Converter tool. Pure functions, no React.
 *
 * Input is one free-text field that accepts:
 *   - Unix seconds (9–11 digits) or milliseconds (12–14 digits)
 *   - ISO 8601 / RFC 2822 strings that carry their own offset ("…Z", "+08:00", "GMT")
 *   - a wall-clock date/time with no offset ("2026-09-25 19:36"), read in `sourceZone`
 */

export const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export type ParseKind = "unix-seconds" | "unix-millis" | "absolute" | "wall-clock";

export type ParseResult =
    | { ok: true; date: Date; kind: ParseKind }
    | { ok: false; error: string };

const WALL_CLOCK = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2}|\bGMT\b|\bUTC\b)\s*$/i;

/*
 * Besides IANA zones ("Europe/London"), a zone can be a fixed offset written the
 * way offsetLabel prints it: "GMT+8", "GMT-3:30", "GMT+5:45". Fixed offsets never
 * shift for daylight saving.
 */
const FIXED_OFFSET = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/;

/** Minutes east of UTC for a fixed-offset zone, or null for anything else. */
export function parseFixedOffset(zone: string): number | null {
    const m = FIXED_OFFSET.exec(zone);
    if (!m) return null;
    const hours = Number(m[2]);
    const minutes = Number(m[3] ?? 0);
    if (minutes >= 60) return null;
    const total = (m[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
    return total >= -12 * 60 && total <= 14 * 60 ? total : null;
}

export function fixedOffsetZone(minutes: number): string {
    if (minutes === 0) return "UTC";
    const abs = Math.abs(minutes);
    const m = abs % 60;
    return `GMT${minutes > 0 ? "+" : "-"}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** Offsets in use somewhere in the world, with a few places that use them (standard time). */
export const WORLD_OFFSETS: { minutes: number; places: string }[] = [
    { minutes: -720, places: "Baker Island" },
    { minutes: -660, places: "American Samoa, Niue" },
    { minutes: -600, places: "Hawaii, Tahiti" },
    { minutes: -570, places: "Marquesas Islands" },
    { minutes: -540, places: "Alaska" },
    { minutes: -480, places: "Los Angeles, Vancouver, Tijuana" },
    { minutes: -420, places: "Denver, Phoenix, Calgary" },
    { minutes: -360, places: "Chicago, Mexico City, Guatemala" },
    { minutes: -300, places: "New York, Toronto, Bogotá, Lima" },
    { minutes: -240, places: "Halifax, Caracas, La Paz, Santiago" },
    { minutes: -210, places: "Newfoundland" },
    { minutes: -180, places: "São Paulo, Buenos Aires, Montevideo" },
    { minutes: -120, places: "South Georgia, Fernando de Noronha" },
    { minutes: -60, places: "Azores, Cape Verde" },
    { minutes: 60, places: "Paris, Berlin, Lagos" },
    { minutes: 120, places: "Athens, Cairo, Johannesburg, Kyiv" },
    { minutes: 180, places: "Moscow, Istanbul, Riyadh, Nairobi" },
    { minutes: 210, places: "Tehran" },
    { minutes: 240, places: "Dubai, Baku, Mauritius" },
    { minutes: 270, places: "Kabul" },
    { minutes: 300, places: "Karachi, Tashkent, Maldives" },
    { minutes: 330, places: "India, Sri Lanka" },
    { minutes: 345, places: "Nepal" },
    { minutes: 360, places: "Dhaka, Almaty, Bhutan" },
    { minutes: 390, places: "Yangon, Cocos Islands" },
    { minutes: 420, places: "Bangkok, Jakarta, Ho Chi Minh City" },
    { minutes: 480, places: "Singapore, Manila, Beijing, Perth, Taipei" },
    { minutes: 525, places: "Eucla" },
    { minutes: 540, places: "Tokyo, Seoul" },
    { minutes: 570, places: "Adelaide, Darwin" },
    { minutes: 600, places: "Sydney, Brisbane, Guam" },
    { minutes: 630, places: "Lord Howe Island" },
    { minutes: 660, places: "Solomon Islands, New Caledonia" },
    { minutes: 720, places: "Auckland, Fiji" },
    { minutes: 765, places: "Chatham Islands" },
    { minutes: 780, places: "Tonga, Samoa" },
    { minutes: 840, places: "Kiribati (Line Islands)" },
];

/** True when the string names a zone this module can format in. */
export function isValidTimeZone(zone: string): boolean {
    if (parseFixedOffset(zone) !== null) return true;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** Offset of `zone` from UTC at `date`, in minutes (e.g. +480 for Asia/Singapore). */
export function zoneOffsetMinutes(date: Date, zone: string): number {
    const fixed = parseFixedOffset(zone);
    if (fixed !== null) return fixed;
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** The instant at which the wall clock in `zone` reads the given fields. */
export function fromWallClock(
    fields: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number },
    zone: string,
): Date {
    const guess = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second, fields.ms);
    const fixed = parseFixedOffset(zone);
    if (fixed !== null) return new Date(guess - fixed * 60000);
    // One correction pass handles DST: the offset at the guessed instant may differ
    // from the offset at the real one by the size of the transition.
    let offset = zoneOffsetMinutes(new Date(guess), zone);
    const first = guess - offset * 60000;
    offset = zoneOffsetMinutes(new Date(first), zone);
    return new Date(guess - offset * 60000);
}

export function parseDateTimeInput(input: string, sourceZone: string): ParseResult {
    const text = input.trim();
    if (!text) return { ok: false, error: "Enter a date/time, a Unix timestamp or an ISO string." };

    if (/^-?\d+$/.test(text)) {
        const digits = text.replace("-", "").length;
        const n = Number(text);
        if (digits >= 9 && digits <= 11) return { ok: true, date: new Date(n * 1000), kind: "unix-seconds" };
        if (digits >= 12 && digits <= 14) return { ok: true, date: new Date(n), kind: "unix-millis" };
        return { ok: false, error: "Unix timestamps are 10 digits (seconds) or 13 digits (milliseconds)." };
    }

    const wall = WALL_CLOCK.exec(text);
    if (wall) {
        const [, y, mo, d, h = "0", mi = "0", s = "0", ms = "0"] = wall;
        const fields = {
            year: Number(y), month: Number(mo), day: Number(d),
            hour: Number(h), minute: Number(mi), second: Number(s), ms: Number(ms.padEnd(3, "0")),
        };
        if (fields.month < 1 || fields.month > 12 || fields.day < 1 || fields.day > 31 || fields.hour > 23 || fields.minute > 59 || fields.second > 59) {
            return { ok: false, error: "That date or time is out of range." };
        }
        if (!isValidTimeZone(sourceZone)) return { ok: false, error: `Unknown time zone "${sourceZone}".` };
        return { ok: true, date: fromWallClock(fields, sourceZone), kind: "wall-clock" };
    }

    if (HAS_OFFSET.test(text) || /^\d{4}-\d{2}-\d{2}T/.test(text)) {
        const ms = Date.parse(text);
        if (Number.isFinite(ms)) return { ok: true, date: new Date(ms), kind: "absolute" };
    }

    return { ok: false, error: "Couldn't read that. Try 2026-09-25 19:36, 1758800000 or 2026-09-25T11:36:00Z." };
}

/** "GMT+8", "GMT-3:30", "GMT" — the offset of `zone` at `date`. */
export function offsetLabel(date: Date, zone: string): string {
    const minutes = zoneOffsetMinutes(date, zone);
    return minutes === 0 ? "GMT" : fixedOffsetZone(minutes);
}

/**
 * Intl only formats IANA zones, so a fixed offset is formatted as UTC after
 * shifting the instant by the offset.
 */
function toIntlZone(date: Date, zone: string): { date: Date; timeZone: string } {
    const fixed = parseFixedOffset(zone);
    return fixed === null ? { date, timeZone: zone } : { date: new Date(date.getTime() + fixed * 60000), timeZone: "UTC" };
}

export function formatInZone(input: Date, zone: string): string {
    const { date, timeZone } = toIntlZone(input, zone);
    return date.toLocaleString([], {
        timeZone,
        weekday: "short", year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
}

/** Wall-clock value for the text field / a datetime-local input: "2026-09-25 19:36". */
export function toWallClockText(input: Date, zone: string): string {
    const { date, timeZone } = toIntlZone(input, zone);
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 24 * 3600],
    ["month", 30 * 24 * 3600],
    ["week", 7 * 24 * 3600],
    ["day", 24 * 3600],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
];

/** "in 3 hours", "2 days ago", "now". */
export function relativeTo(date: Date, now: Date): string {
    const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
    const rtf = new Intl.RelativeTimeFormat([], { numeric: "auto" });
    for (const [unit, size] of RELATIVE_UNITS) {
        if (Math.abs(seconds) >= size || unit === "second") {
            return rtf.format(Math.round(seconds / size), unit);
        }
    }
    return rtf.format(0, "second");
}
