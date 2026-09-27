import { useMemo, type ReactNode } from "react";
import { SearchCode } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { CronFieldName } from "@/lib/toolbox/cron";
import {
    CRON_FIELD_LIMITS,
    buildAdvancedCron,
    buildSimpleCron,
    defaultAdvancedFields,
    defaultSimpleOptions,
    type AdvancedField,
    type AdvancedFields,
    type FieldMode,
    type SimpleCronOptions,
    type SimpleFrequency,
} from "@/lib/toolbox/cron-builder";
import { CronPreview } from "./cron-preview";
import { CopyButton, OutputBox, ToolPanel } from "./toolbox-shared";

/** Lives in the parent so switching tabs (which unmounts this one) keeps the form. */
export type CronCreatorState = {
    mode: "simple" | "advanced";
    withSeconds: boolean;
    simple: SimpleCronOptions;
    advanced: AdvancedFields;
};

export function defaultCronCreatorState(): CronCreatorState {
    return { mode: "simple", withSeconds: false, simple: defaultSimpleOptions(), advanced: defaultAdvancedFields() };
}

const FREQUENCIES: { value: SimpleFrequency; label: string }[] = [
    { value: "seconds", label: "Every N seconds" },
    { value: "minutes", label: "Every N minutes" },
    { value: "hourly", label: "Every hour" },
    { value: "daily", label: "Every day" },
    { value: "weekly", label: "Every week" },
    { value: "monthly", label: "Every month" },
];

/** Monday first, as a work week reads; values stay cron's 0 = Sunday. */
const WEEKDAYS = [
    { value: 1, label: "Mon" }, { value: 2, label: "Tue" }, { value: 3, label: "Wed" }, { value: 4, label: "Thu" },
    { value: 5, label: "Fri" }, { value: 6, label: "Sat" }, { value: 0, label: "Sun" },
];

const FIELD_LABELS: Record<CronFieldName, string> = {
    seconds: "Seconds",
    minutes: "Minutes",
    hours: "Hours",
    dayOfMonth: "Day of month",
    month: "Month",
    dayOfWeek: "Day of week",
};

const FIELD_ORDER: CronFieldName[] = ["seconds", "minutes", "hours", "dayOfMonth", "month", "dayOfWeek"];

const FIELD_MODES: { value: FieldMode; label: string }[] = [
    { value: "every", label: "Every" },
    { value: "specific", label: "Specific" },
    { value: "range", label: "Range" },
    { value: "step", label: "Step" },
];

const pad = (value: number) => String(value).padStart(2, "0");

function NumberInput({ value, onChange, min, max, className }: {
    value: number;
    onChange: (value: number) => void;
    min: number;
    max?: number;
    className?: string;
}) {
    return (
        <Input
            type="number"
            min={min}
            max={max}
            value={Number.isFinite(value) ? value : ""}
            onChange={(event) => onChange(event.target.value === "" ? NaN : Number(event.target.value))}
            className={cn("h-8 w-20 text-xs tabular-nums", className)}
        />
    );
}

function TimeInput({ hour, minute, onChange }: { hour: number; minute: number; onChange: (hour: number, minute: number) => void }) {
    return (
        <Input
            type="time"
            value={`${pad(hour)}:${pad(minute)}`}
            onChange={(event) => {
                const [h, m] = event.target.value.split(":").map(Number);
                if (Number.isInteger(h) && Number.isInteger(m)) onChange(h!, m!);
            }}
            className="h-8 w-28 text-xs tabular-nums"
        />
    );
}

function FormRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function SimpleForm({ options, onChange }: { options: SimpleCronOptions; onChange: (options: SimpleCronOptions) => void }) {
    const set = (patch: Partial<SimpleCronOptions>) => onChange({ ...options, ...patch });
    const { frequency } = options;

    const toggleDay = (day: number) => set({
        weekdays: options.weekdays.includes(day)
            ? options.weekdays.filter((d) => d !== day)
            : [...options.weekdays, day],
    });

    return (
        <div className="flex flex-col gap-2">
            <FormRow label="Frequency">
                <Select value={frequency} onValueChange={(value) => set({ frequency: value as SimpleFrequency })}>
                    <SelectTrigger className="h-8 w-44 text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {FREQUENCIES.map((item) => (
                            <SelectItem key={item.value} value={item.value} className="text-xs">{item.label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </FormRow>

            {(frequency === "seconds" || frequency === "minutes") && (
                <FormRow label="Every">
                    <NumberInput value={options.interval} onChange={(interval) => set({ interval })} min={1} max={59} />
                    <span className="text-xs text-muted-foreground">{frequency}</span>
                </FormRow>
            )}

            {frequency === "hourly" && (
                <FormRow label="At minute">
                    <NumberInput value={options.minute} onChange={(minute) => set({ minute })} min={0} max={59} />
                </FormRow>
            )}

            {frequency === "weekly" && (
                <FormRow label="On">
                    <div className="flex flex-wrap gap-1">
                        {WEEKDAYS.map((day) => (
                            <Button
                                key={day.value}
                                variant={options.weekdays.includes(day.value) ? "default" : "outline"}
                                size="sm"
                                className="h-8 w-11 text-xs"
                                aria-pressed={options.weekdays.includes(day.value)}
                                onClick={() => toggleDay(day.value)}
                            >
                                {day.label}
                            </Button>
                        ))}
                    </div>
                    {options.weekdays.length === 0 && (
                        <span className="text-[11px] text-muted-foreground">No days picked — runs every day.</span>
                    )}
                </FormRow>
            )}

            {frequency === "monthly" && (
                <FormRow label="On day">
                    <NumberInput value={options.dayOfMonth} onChange={(dayOfMonth) => set({ dayOfMonth })} min={1} max={31} />
                    {options.dayOfMonth > 28 && (
                        <span className="text-[11px] text-muted-foreground">Months without this day are skipped.</span>
                    )}
                </FormRow>
            )}

            {(frequency === "daily" || frequency === "weekly" || frequency === "monthly") && (
                <FormRow label="At (UTC)">
                    <TimeInput hour={options.hour} minute={options.minute} onChange={(hour, minute) => set({ hour, minute })} />
                </FormRow>
            )}
        </div>
    );
}

/** Numbers typed as "0, 15, 30"; anything outside the field's bounds is dropped. */
function parseValueList(text: string, name: CronFieldName): number[] {
    const { min, max } = CRON_FIELD_LIMITS[name];
    return text.split(/[\s,]+/).filter(Boolean).map(Number)
        .filter((value) => Number.isInteger(value) && value >= min && value <= max);
}

function FieldRow({ name, field, onChange }: { name: CronFieldName; field: AdvancedField; onChange: (field: AdvancedField) => void }) {
    const { min, max } = CRON_FIELD_LIMITS[name];
    const set = (patch: Partial<AdvancedField>) => onChange({ ...field, ...patch });
    const bounds = name === "dayOfWeek" ? `${min}–${max}, 0 = Sunday` : `${min}–${max}`;

    return (
        <FormRow label={FIELD_LABELS[name]}>
            <Select value={field.mode} onValueChange={(mode) => set({ mode: mode as FieldMode })}>
                <SelectTrigger className="h-8 w-28 text-xs">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {FIELD_MODES.map((item) => (
                        <SelectItem key={item.value} value={item.value} className="text-xs">{item.label}</SelectItem>
                    ))}
                </SelectContent>
            </Select>

            {field.mode === "specific" && (
                // Uncontrolled so a half-typed "0," survives; the parsed list is what the builder reads.
                <Input
                    key={`${name}-specific`}
                    defaultValue={field.values.join(",")}
                    onChange={(event) => set({ values: parseValueList(event.target.value, name) })}
                    placeholder="e.g. 0,15,30"
                    spellCheck={false}
                    className="h-8 w-40 font-mono text-xs"
                />
            )}

            {field.mode === "range" && (
                <>
                    <NumberInput value={field.from} onChange={(from) => set({ from })} min={min} max={max} />
                    <span className="text-xs text-muted-foreground">to</span>
                    <NumberInput value={field.to} onChange={(to) => set({ to })} min={min} max={max} />
                </>
            )}

            {field.mode === "step" && (
                <>
                    <span className="text-xs text-muted-foreground">every</span>
                    <NumberInput value={field.step} onChange={(step) => set({ step })} min={1} max={max} />
                    <span className="text-xs text-muted-foreground">starting at</span>
                    <NumberInput value={field.start} onChange={(start) => set({ start })} min={min} max={max} />
                </>
            )}

            {field.mode !== "every" && (
                <span className="text-[11px] text-muted-foreground">{bounds}</span>
            )}
        </FormRow>
    );
}

function AdvancedForm({ fields, withSeconds, onChange }: {
    fields: AdvancedFields;
    withSeconds: boolean;
    onChange: (fields: AdvancedFields) => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            {FIELD_ORDER.filter((name) => withSeconds || name !== "seconds").map((name) => (
                <FieldRow
                    key={name}
                    name={name}
                    field={fields[name]}
                    onChange={(field) => onChange({ ...fields, [name]: field })}
                />
            ))}
        </div>
    );
}

interface CronCreatorProps {
    state: CronCreatorState;
    onChange: (state: CronCreatorState) => void;
    onOpenInExplain: (expression: string) => void;
}

export function CronCreator({ state, onChange, onOpenInExplain }: CronCreatorProps) {
    const set = (patch: Partial<CronCreatorState>) => onChange({ ...state, ...patch });

    // Every-N-seconds only exists in NCRONTAB, so it pins the seconds field on.
    const secondsForced = state.mode === "simple" && state.simple.frequency === "seconds";
    const withSeconds = state.withSeconds || secondsForced;

    const expression = useMemo(
        () => state.mode === "simple"
            ? buildSimpleCron({ ...state.simple, withSeconds })
            : buildAdvancedCron(state.advanced, withSeconds),
        [state.mode, state.simple, state.advanced, withSeconds],
    );

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <ToolPanel
                title="Expression"
                actions={
                    <div className="flex items-center gap-1">
                        <CopyButton value={expression} label="Copy expression" />
                        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => onOpenInExplain(expression)}>
                            <SearchCode className="mr-1 h-3.5 w-3.5" />
                            Open in Explain
                        </Button>
                    </div>
                }
            >
                <OutputBox value={expression} className="flex-none text-sm" />
            </ToolPanel>

            <div className="flex flex-wrap items-center gap-2">
                {(["simple", "advanced"] as const).map((mode) => (
                    <Button
                        key={mode}
                        variant={state.mode === mode ? "default" : "outline"}
                        size="sm"
                        className="h-8 text-xs capitalize"
                        onClick={() => set({ mode })}
                    >
                        {mode}
                    </Button>
                ))}
                <div className="ml-2 flex items-center gap-2">
                    <Checkbox
                        id="cron-with-seconds"
                        checked={withSeconds}
                        disabled={secondsForced}
                        onCheckedChange={(checked) => set({ withSeconds: checked === true })}
                    />
                    <Label htmlFor="cron-with-seconds" className="text-xs font-normal">
                        Include seconds (NCRONTAB)
                    </Label>
                </div>
            </div>

            <div className="rounded-md border p-3">
                {state.mode === "simple" ? (
                    <SimpleForm options={state.simple} onChange={(simple) => set({ simple })} />
                ) : (
                    <AdvancedForm fields={state.advanced} withSeconds={withSeconds} onChange={(advanced) => set({ advanced })} />
                )}
            </div>

            <CronPreview expression={expression} />
        </div>
    );
}
