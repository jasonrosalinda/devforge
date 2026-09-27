import type { CronFieldName } from './cron';

/**
 * Bounds the builder UI offers per field. Day of week stops at 6: the parser
 * accepts 7 as Sunday too, but offering both would show Sunday twice.
 */
export const CRON_FIELD_LIMITS: Record<CronFieldName, { min: number; max: number }> = {
    seconds: { min: 0, max: 59 },
    minutes: { min: 0, max: 59 },
    hours: { min: 0, max: 23 },
    dayOfMonth: { min: 1, max: 31 },
    month: { min: 1, max: 12 },
    dayOfWeek: { min: 0, max: 6 },
};

const clamp = (value: number, name: CronFieldName) => {
    const { min, max } = CRON_FIELD_LIMITS[name];
    return Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));
};

const clampStep = (value: number) => Math.max(1, Math.round(Number.isFinite(value) ? value : 1));

/** Sorted, de-duplicated list with runs of three or more written as ranges: `0,1,3-6`. */
export function compressValues(values: number[]): string {
    const sorted = [...new Set(values)].sort((a, b) => a - b);
    const parts: string[] = [];

    for (let i = 0; i < sorted.length;) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
        if (j - i >= 2) {
            parts.push(`${sorted[i]}-${sorted[j]}`);
        } else {
            for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
        }
        i = j + 1;
    }

    return parts.join(',');
}

// ─── Simple mode: pick a frequency, fill in the time ────────────────────────

export type SimpleFrequency = 'seconds' | 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly';

export type SimpleCronOptions = {
    frequency: SimpleFrequency;
    /** Every N seconds or minutes. */
    interval: number;
    minute: number;
    hour: number;
    /** 0 = Sunday. Empty means every day. */
    weekdays: number[];
    dayOfMonth: number;
    /** Emit the 6-field NCRONTAB form. Every-N-seconds always does. */
    withSeconds: boolean;
};

export function defaultSimpleOptions(): SimpleCronOptions {
    return { frequency: 'daily', interval: 5, minute: 0, hour: 9, weekdays: [1, 2, 3, 4, 5], dayOfMonth: 1, withSeconds: false };
}

const every = (interval: number) => (clampStep(interval) === 1 ? '*' : `*/${clampStep(interval)}`);

export function buildSimpleCron(options: SimpleCronOptions): string {
    const minute = clamp(options.minute, 'minutes');
    const hour = clamp(options.hour, 'hours');

    if (options.frequency === 'seconds') return `${every(options.interval)} * * * * *`;

    let fields: string;
    switch (options.frequency) {
        case 'minutes':
            fields = `${every(options.interval)} * * * *`;
            break;
        case 'hourly':
            fields = `${minute} * * * *`;
            break;
        case 'daily':
            fields = `${minute} ${hour} * * *`;
            break;
        case 'weekly': {
            const days = options.weekdays.map((day) => clamp(day, 'dayOfWeek'));
            fields = `${minute} ${hour} * * ${days.length ? compressValues(days) : '*'}`;
            break;
        }
        case 'monthly':
            fields = `${minute} ${hour} ${clamp(options.dayOfMonth, 'dayOfMonth')} * *`;
            break;
    }

    return options.withSeconds ? `0 ${fields}` : fields;
}

// ─── Advanced mode: one rule per field ──────────────────────────────────────

export type FieldMode = 'every' | 'specific' | 'range' | 'step';

export type AdvancedField = {
    mode: FieldMode;
    /** `specific`: the values to match. Empty falls back to `*`. */
    values: number[];
    /** `range`: inclusive bounds; swapped if given backwards. */
    from: number;
    to: number;
    /** `step`: every `step` values starting at `start`. */
    step: number;
    start: number;
};

export type AdvancedFields = Record<CronFieldName, AdvancedField>;

export function defaultAdvancedFields(): AdvancedFields {
    const make = (name: CronFieldName): AdvancedField => {
        const { min, max } = CRON_FIELD_LIMITS[name];
        return { mode: 'every', values: [], from: min, to: max, step: 1, start: min };
    };
    return {
        seconds: { ...make('seconds'), mode: 'specific', values: [0] },
        minutes: make('minutes'),
        hours: make('hours'),
        dayOfMonth: make('dayOfMonth'),
        month: make('month'),
        dayOfWeek: make('dayOfWeek'),
    };
}

export function buildFieldExpression(name: CronFieldName, field: AdvancedField): string {
    switch (field.mode) {
        case 'every':
            return '*';
        case 'specific':
            return field.values.length ? compressValues(field.values.map((value) => clamp(value, name))) : '*';
        case 'range': {
            const [from, to] = [clamp(field.from, name), clamp(field.to, name)].sort((a, b) => a - b);
            return from === to ? String(from) : `${from}-${to}`;
        }
        case 'step': {
            const start = clamp(field.start, name);
            const step = clampStep(field.step);
            return start === CRON_FIELD_LIMITS[name].min ? `*/${step}` : `${start}/${step}`;
        }
    }
}

const FIVE_FIELDS: CronFieldName[] = ['minutes', 'hours', 'dayOfMonth', 'month', 'dayOfWeek'];

export function buildAdvancedCron(fields: AdvancedFields, withSeconds: boolean): string {
    const names: CronFieldName[] = withSeconds ? ['seconds', ...FIVE_FIELDS] : FIVE_FIELDS;
    return names.map((name) => buildFieldExpression(name, fields[name])).join(' ');
}
