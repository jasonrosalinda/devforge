/**
 * Find every timestamp in free text (logs, JSON, YAML, XML) and restate it in one zone,
 * by default SGT. Used by the DateTime Converter's bulk mode and the JSON / YAML / XML tool.
 *
 * Recognised:
 *   - ISO 8601 with a zone: 2026-11-09T02:23:00Z, 2026-11-09 02:23:00.123+00:00, …T02:23-05:00
 *   - ISO date-times ending in " UTC" / " GMT": 2026-11-09 02:23:00 UTC
 *   - RFC 1123 (HTTP headers): Mon, 09 Nov 2026 02:23:00 GMT
 *   - ISO date-times with no zone, only when `naiveAsUtc` is on (App Insights / SQL exports
 *     often drop the "Z").
 * Unix epochs are left alone: any 10-digit number would match.
 */
import { zoneOffsetMinutes } from './datetime';

export const SGT_ZONE = 'Asia/Singapore';

export interface ShiftOptions {
    /** IANA zone or fixed offset ("GMT+8") to restate times in. */
    zone: string;
    /** Treat ISO date-times that carry no zone as UTC (otherwise they are left as they are). */
    naiveAsUtc?: boolean;
}

export interface FoundTimestamp {
    start: number;
    end: number;
    text: string;
    date: Date;
}

const ISO = /(?<![\w.:-])(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2}| ?(?:UTC|GMT)\b)?(?![\w:.]|[+-]\d)/g;
const RFC1123 = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT\b/g;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function offsetText(minutes: number): string {
    const sign = minutes < 0 ? '-' : '+';
    const abs = Math.abs(minutes);
    return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Short name for the zone in labels: "SGT" for Singapore, else "GMT+8" style. */
export function zoneLabel(zone: string, date = new Date()): string {
    if (zone === SGT_ZONE) return 'SGT';
    const m = zoneOffsetMinutes(date, zone);
    if (m === 0) return 'UTC';
    const abs = Math.abs(m);
    return `GMT${m < 0 ? '-' : '+'}${Math.floor(abs / 60)}${abs % 60 ? `:${pad(abs % 60)}` : ''}`;
}

/** Wall-clock fields of `date` in `zone`. */
function wallClock(date: Date, zone: string) {
    const shifted = new Date(date.getTime() + zoneOffsetMinutes(date, zone) * 60_000);
    return {
        y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate(),
        h: shifted.getUTCHours(), mi: shifted.getUTCMinutes(), s: shifted.getUTCSeconds(),
    };
}

/**
 * `date` as ISO 8601 in `zone`, keeping the original's separator, whether it had seconds,
 * and its fraction digits verbatim (a whole-minute shift never changes them).
 */
export function toZoneIso(date: Date, zone: string, opts: { sep?: string; seconds?: boolean; fraction?: string } = {}): string {
    const { sep = 'T', seconds = true, fraction = '' } = opts;
    const w = wallClock(date, zone);
    const time = `${pad(w.h)}:${pad(w.mi)}${seconds ? `:${pad(w.s)}${fraction}` : ''}`;
    return `${w.y}-${pad(w.mo)}-${pad(w.d)}${sep}${time}${offsetText(zoneOffsetMinutes(date, zone))}`;
}

/** "2026-11-09 10:23:00 SGT" — for showing beside a value. */
export function friendlyInZone(date: Date, zone: string): string {
    const w = wallClock(date, zone);
    return `${w.y}-${pad(w.mo)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)} ${zoneLabel(zone, date)}`;
}

interface IsoMatch { date: Date; sep: string; seconds: boolean; fraction: string }

function readIso(m: RegExpExecArray, naiveAsUtc: boolean): IsoMatch | null {
    const [, y, mo, d, sep, h, mi, s, frac = '', zone] = m;
    if (!zone && !naiveAsUtc) return null;
    const z = (zone ?? 'Z').trim().toUpperCase();
    const offsetMin = z === 'Z' || z === 'UTC' || z === 'GMT' ? 0
        : (z[0] === '-' ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(-2)));
    const ms = Number((frac.slice(1) + '000').slice(0, 3));
    const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), ms) - offsetMin * 60_000;
    const date = new Date(utc);
    // Reject 2026-02-31 and friends instead of rolling them over.
    const check = new Date(utc + offsetMin * 60_000);
    if (check.getUTCMonth() + 1 !== Number(mo) || check.getUTCDate() !== Number(d) || Number(h) > 23 || Number(mi) > 59) return null;
    return { date, sep: sep!, seconds: s !== undefined, fraction: frac };
}

/** Every timestamp in `text`, in order. */
export function findTimestamps(text: string, opts: Pick<ShiftOptions, 'naiveAsUtc'> = {}): FoundTimestamp[] {
    const found: FoundTimestamp[] = [];
    for (const m of text.matchAll(ISO)) {
        const iso = readIso(m, !!opts.naiveAsUtc);
        if (iso) found.push({ start: m.index!, end: m.index! + m[0].length, text: m[0], date: iso.date });
    }
    for (const m of text.matchAll(RFC1123)) {
        const ms = Date.parse(m[0]);
        if (Number.isFinite(ms)) found.push({ start: m.index!, end: m.index! + m[0].length, text: m[0], date: new Date(ms) });
    }
    return found.sort((a, b) => a.start - b.start);
}

/** `text` with every timestamp restated in `opts.zone`; everything else is untouched. */
export function shiftTimestamps(text: string, opts: ShiftOptions): { text: string; count: number } {
    let out = '';
    let last = 0;
    let count = 0;
    const isoAt = new Map<number, IsoMatch>();
    for (const m of text.matchAll(ISO)) {
        const iso = readIso(m, !!opts.naiveAsUtc);
        if (iso) isoAt.set(m.index!, iso);
    }
    for (const f of findTimestamps(text, opts)) {
        if (f.start < last) continue; // overlapping match
        const iso = isoAt.get(f.start);
        const next = iso
            ? toZoneIso(f.date, opts.zone, { sep: iso.sep, seconds: iso.seconds, fraction: iso.fraction })
            : toZoneIso(f.date, opts.zone, { sep: ' ' });
        out += text.slice(last, f.start) + next;
        last = f.end;
        count += 1;
    }
    return { text: out + text.slice(last), count };
}

/** The timestamp a whole string holds (a JSON / YAML value), or null. */
export function timestampValue(value: string, opts: Pick<ShiftOptions, 'naiveAsUtc'> = {}): Date | null {
    const trimmed = value.trim();
    if (trimmed.length > 40) return null;
    const [only] = findTimestamps(trimmed, opts);
    return only && only.start === 0 && only.end === trimmed.length ? only.date : null;
}
