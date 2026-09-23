export type CronFieldName = 'seconds' | 'minutes' | 'hours' | 'dayOfMonth' | 'month' | 'dayOfWeek';

export type CronField = {
    /** Every value the field matches, ascending. */
    values: number[];
    /** False only for a bare `*`. Drives the OR rule between the two day fields. */
    restricted: boolean;
    /** Set only for a whole-range step like `*\/5`, which describeCron reads. */
    step: number | null;
    raw: string;
};

export type ParsedCron = {
    fieldCount: 5 | 6;
    seconds: CronField;
    minutes: CronField;
    hours: CronField;
    dayOfMonth: CronField;
    month: CronField;
    dayOfWeek: CronField;
};

export type CronError = { field: CronFieldName | null; message: string };

export type CronParseResult = { cron: ParsedCron | null; error: CronError | null };

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MONTH_ALIASES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_ALIASES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

type FieldSpec = { name: CronFieldName; min: number; max: number; aliases?: string[]; aliasOffset?: number };

const SPECS: Record<CronFieldName, FieldSpec> = {
    seconds: { name: 'seconds', min: 0, max: 59 },
    minutes: { name: 'minutes', min: 0, max: 59 },
    hours: { name: 'hours', min: 0, max: 23 },
    dayOfMonth: { name: 'dayOfMonth', min: 1, max: 31 },
    month: { name: 'month', min: 1, max: 12, aliases: MONTH_ALIASES, aliasOffset: 1 },
    dayOfWeek: { name: 'dayOfWeek', min: 0, max: 7, aliases: DAY_ALIASES, aliasOffset: 0 },
};

class CronFieldError extends Error {
    constructor(readonly field: CronFieldName, message: string) {
        super(message);
    }
}

function parseValue(token: string, spec: FieldSpec): number {
    const lower = token.trim().toLowerCase();
    const aliasIndex = spec.aliases?.indexOf(lower) ?? -1;
    if (aliasIndex >= 0) return aliasIndex + (spec.aliasOffset ?? 0);

    if (!/^\d+$/.test(lower)) {
        throw new CronFieldError(spec.name, `"${token}" is not a valid ${spec.name} value.`);
    }

    const value = Number(lower);
    if (value < spec.min || value > spec.max) {
        throw new CronFieldError(spec.name, `${spec.name} must be between ${spec.min}-${spec.max}; got ${value}.`);
    }
    return value;
}

function parseField(raw: string, spec: FieldSpec): CronField {
    const trimmed = raw.trim();
    if (!trimmed) throw new CronFieldError(spec.name, `${spec.name} is empty.`);

    const values = new Set<number>();

    for (const token of trimmed.split(',')) {
        const [rangePart, stepPart] = token.split('/');
        if (token.split('/').length > 2) {
            throw new CronFieldError(spec.name, `"${token}" has more than one step.`);
        }

        let step = 1;
        if (stepPart !== undefined) {
            if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
                throw new CronFieldError(spec.name, `"${token}" needs a step of 1 or more.`);
            }
            step = Number(stepPart);
        }

        let start: number;
        let end: number;
        if (rangePart === '*' || rangePart === '?') {
            start = spec.min;
            end = spec.max;
        } else if (rangePart!.includes('-')) {
            const [from, to] = rangePart!.split('-');
            start = parseValue(from!, spec);
            end = parseValue(to!, spec);
            if (end < start) {
                throw new CronFieldError(spec.name, `range "${rangePart}" ends before it starts.`);
            }
        } else {
            start = parseValue(rangePart!, spec);
            end = stepPart === undefined ? start : spec.max;
        }

        for (let value = start; value <= end; value += step) values.add(value);
    }

    // Both 0 and 7 mean Sunday; collapse so matching only ever checks 0-6.
    if (spec.name === 'dayOfWeek' && values.delete(7)) values.add(0);

    const stepMatch = /^\*\/(\d+)$/.exec(trimmed);

    return {
        values: [...values].sort((a, b) => a - b),
        restricted: trimmed !== '*' && trimmed !== '?',
        step: stepMatch ? Number(stepMatch[1]) : null,
        raw: trimmed,
    };
}

/**
 * Parses a 5-field cron or a 6-field NCRONTAB expression (the seconds-first
 * form Azure Functions and WebJobs use). The field count is inferred unless
 * given explicitly.
 */
export function parseCron(expression: string, fieldCount?: 5 | 6): CronParseResult {
    const parts = expression.trim().split(/\s+/).filter(Boolean);
    const count = fieldCount ?? parts.length;

    if (count !== 5 && count !== 6) {
        return { cron: null, error: { field: null, message: `A cron expression needs 5 or 6 fields; found ${parts.length}.` } };
    }
    if (parts.length !== count) {
        return { cron: null, error: { field: null, message: `Expected ${count} fields; found ${parts.length}.` } };
    }

    try {
        const [secondsRaw, rest] = count === 6 ? [parts[0]!, parts.slice(1)] : ['0', parts];
        const [minutes, hours, dayOfMonth, month, dayOfWeek] = rest;

        return {
            cron: {
                fieldCount: count,
                seconds: parseField(secondsRaw, SPECS.seconds),
                minutes: parseField(minutes!, SPECS.minutes),
                hours: parseField(hours!, SPECS.hours),
                dayOfMonth: parseField(dayOfMonth!, SPECS.dayOfMonth),
                month: parseField(month!, SPECS.month),
                dayOfWeek: parseField(dayOfWeek!, SPECS.dayOfWeek),
            },
            error: null,
        };
    } catch (error) {
        if (error instanceof CronFieldError) {
            return { cron: null, error: { field: error.field, message: error.message } };
        }
        throw error;
    }
}

function matchesDay(cron: ParsedCron, day: number, weekday: number): boolean {
    const domRestricted = cron.dayOfMonth.restricted;
    const dowRestricted = cron.dayOfWeek.restricted;
    const domMatch = cron.dayOfMonth.values.includes(day);
    const dowMatch = cron.dayOfWeek.values.includes(weekday);

    if (domRestricted && dowRestricted) return domMatch || dowMatch;
    if (domRestricted) return domMatch;
    if (dowRestricted) return dowMatch;
    return true;
}

const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
const nextDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
const nextHour = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1));
const nextMinute = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes() + 1));

/** Expressions such as `0 0 30 2 *` can never fire; stop looking after this many years. */
const SEARCH_YEARS = 5;

/**
 * Next `count` fire times strictly after `from`, computed in UTC — the timezone
 * Azure schedules are evaluated in. Returns fewer (or none) if the expression
 * cannot be satisfied within the search window.
 */
export function nextRuns(cron: ParsedCron, from: Date, count: number): Date[] {
    const runs: Date[] = [];
    const deadlineYear = from.getUTCFullYear() + SEARCH_YEARS;

    // Start on the whole second after `from` so a time that matches exactly now
    // is never returned twice.
    let cursor = new Date(Math.floor(from.getTime() / 1000) * 1000 + 1000);

    while (runs.length < count && cursor.getUTCFullYear() <= deadlineYear) {
        if (!cron.month.values.includes(cursor.getUTCMonth() + 1)) {
            cursor = nextMonth(cursor);
            continue;
        }
        if (!matchesDay(cron, cursor.getUTCDate(), cursor.getUTCDay())) {
            cursor = nextDay(cursor);
            continue;
        }
        if (!cron.hours.values.includes(cursor.getUTCHours())) {
            cursor = nextHour(cursor);
            continue;
        }
        if (!cron.minutes.values.includes(cursor.getUTCMinutes())) {
            cursor = nextMinute(cursor);
            continue;
        }
        if (!cron.seconds.values.includes(cursor.getUTCSeconds())) {
            cursor = new Date(cursor.getTime() + 1000);
            continue;
        }

        runs.push(new Date(cursor));
        cursor = new Date(cursor.getTime() + 1000);
    }

    return runs;
}

function joinNames(names: string[]): string {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function isContiguous(values: number[]): boolean {
    return values.length >= 3 && values.every((value, index) => index === 0 || value === values[index - 1]! + 1);
}

function describeDayOfWeek(field: CronField): string {
    const names = field.values.map((value) => DAY_NAMES[value]!);
    return isContiguous(field.values) ? `${names[0]} to ${names[names.length - 1]}` : joinNames(names);
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function describeClockTimes(cron: ParsedCron): string {
    const times = cron.hours.values.flatMap((hour) =>
        cron.minutes.values.map((minute) => `${pad(hour)}:${pad(minute)}`));
    return `At ${joinNames(times)}`;
}

/** Plain-English rendering of a parsed expression, for the tab's summary line. */
export function describeCron(cron: ParsedCron): string {
    let head: string;

    if (cron.fieldCount === 6 && cron.seconds.step && !cron.minutes.restricted && !cron.hours.restricted) {
        head = `Every ${cron.seconds.step} seconds`;
    } else if (!cron.minutes.restricted && !cron.hours.restricted) {
        head = 'Every minute';
    } else if (cron.minutes.step && !cron.hours.restricted) {
        head = `Every ${cron.minutes.step} minutes`;
    } else if (cron.hours.step) {
        head = `Every ${cron.hours.step} hours, at minute ${joinNames(cron.minutes.values.map(String))}`;
    } else {
        head = describeClockTimes(cron);
    }

    const dayParts: string[] = [];
    if (cron.dayOfMonth.restricted) {
        dayParts.push(`on day ${joinNames(cron.dayOfMonth.values.map(String))} of the month`);
    }
    if (cron.dayOfWeek.restricted) {
        dayParts.push(describeDayOfWeek(cron.dayOfWeek));
    }

    const segments = [head];
    if (dayParts.length) segments.push(dayParts.join(' or '));
    if (cron.month.restricted) {
        segments.push(`in ${joinNames(cron.month.values.map((value) => MONTH_NAMES[value - 1]!))}`);
    }

    return segments.join(', ');
}
