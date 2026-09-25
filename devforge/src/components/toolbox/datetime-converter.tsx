import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    LOCAL_ZONE,
    WORLD_OFFSETS,
    fixedOffsetZone,
    formatInZone,
    isValidTimeZone,
    offsetLabel,
    parseDateTimeInput,
    parseFixedOffset,
    relativeTo,
    toWallClockText,
    type ParseKind,
} from "@/lib/toolbox/datetime";
import { CopyButton, ErrorNote, ToolPanel } from "./toolbox-shared";
import { TimezoneCombobox, type ZoneOption } from "./timezone-combobox";

const ZONES_KEY = "devforge_datetime_zones";

/** One pickable entry per GMT offset in use, rather than every IANA city. */
const OFFSET_OPTIONS: ZoneOption[] = WORLD_OFFSETS.map(({ minutes, places }) => ({
    value: fixedOffsetZone(minutes),
    label: fixedOffsetZone(minutes),
    hint: places,
}));
const PLACES_BY_ZONE = new Map(OFFSET_OPTIONS.map((o) => [o.value, o.hint]));

/** Row heading + second line for an added zone (fixed offset or, from older saves, IANA). */
function describeZone(zone: string, date: Date | null): { label: string; detail: string } {
    if (parseFixedOffset(zone) !== null) {
        return { label: zone, detail: PLACES_BY_ZONE.get(zone) ?? "Fixed offset" };
    }
    return {
        label: zone.split("/").pop()!.replace(/_/g, " "),
        detail: `${zone} · ${date ? offsetLabel(date, zone) : ""}`,
    };
}

const KIND_LABEL: Record<ParseKind, string> = {
    "unix-seconds": "Read as a Unix timestamp in seconds.",
    "unix-millis": "Read as a Unix timestamp in milliseconds.",
    "absolute": "Read as a timestamp with its own offset — the zone setting doesn't apply.",
    "wall-clock": "Read as a wall-clock time in the zone on the right.",
};

function readZones(): string[] {
    try {
        const raw = JSON.parse(localStorage.getItem(ZONES_KEY) ?? "[]");
        return Array.isArray(raw) ? raw.filter((z): z is string => typeof z === "string" && isValidTimeZone(z)) : [];
    } catch {
        return [];
    }
}

function ResultRow({ label, detail, value, onRemove }: { label: string; detail?: string; value: string; onRemove?: () => void }) {
    return (
        <div className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0">
            <div className="w-44 shrink-0">
                <div className="text-sm font-medium">{label}</div>
                {detail && <div className="text-[11px] text-muted-foreground">{detail}</div>}
            </div>
            <div className="min-w-0 flex-1 truncate font-mono text-sm tabular-nums">{value}</div>
            <CopyButton value={value} label={`Copy ${label}`} />
            {onRemove && (
                <Hint label={`Remove ${label}`}>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-foreground" onClick={onRemove}>
                        <X className="h-3.5 w-3.5" />
                    </Button>
                </Hint>
            )}
        </div>
    );
}

export default function DateTimeConverter() {
    const [text, setText] = useState(() => toWallClockText(new Date(), LOCAL_ZONE));
    const [sourceZone, setSourceZone] = useState(LOCAL_ZONE);
    const [zones, setZones] = useState<string[]>([]);
    const [now, setNow] = useState(() => new Date());
    const pickerRef = useRef<HTMLInputElement>(null);

    // Read after mount so the web build's first paint doesn't depend on storage.
    useEffect(() => setZones(readZones()), []);

    // Keeps the "relative" row honest without re-rendering every second.
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 30_000);
        return () => clearInterval(id);
    }, []);

    const saveZones = (next: string[]) => {
        setZones(next);
        try {
            localStorage.setItem(ZONES_KEY, JSON.stringify(next));
        } catch {
            // Remembering zones is a convenience.
        }
    };

    const addZone = (zone: string) => {
        if (!isValidTimeZone(zone) || zone === LOCAL_ZONE || zone === "UTC" || zones.includes(zone)) return;
        saveZones([...zones, zone]);
    };

    const removeZone = (zone: string) => {
        saveZones(zones.filter((z) => z !== zone));
        if (sourceZone === zone) setSourceZone(LOCAL_ZONE);
    };

    const parsed = useMemo(() => parseDateTimeInput(text, sourceZone), [text, sourceZone]);
    const date = parsed.ok ? parsed.date : null;

    const setNowValue = () => {
        const current = new Date();
        setNow(current);
        setText(toWallClockText(current, sourceZone));
    };

    return (
        <div className="flex flex-col gap-4 h-full min-h-0">
            <ToolPanel title="Input">
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[16rem] flex-1">
                        <Input
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder="2026-09-25 19:36, 1758800000 or 2026-09-25T11:36:00Z"
                            spellCheck={false}
                            aria-label="Date, time or timestamp"
                            className="pr-10 font-mono text-sm"
                        />
                        <Hint label="Pick a date and time" className="absolute right-1 top-1/2 -translate-y-1/2">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                onClick={() => pickerRef.current?.showPicker?.()}
                                aria-label="Pick a date and time"
                            >
                                <CalendarDays className="h-4 w-4" />
                            </Button>
                        </Hint>
                        {/* Native picker, driven by the calendar button; writes back into the text field. */}
                        <input
                            ref={pickerRef}
                            type="datetime-local"
                            tabIndex={-1}
                            aria-hidden
                            className="pointer-events-none absolute bottom-0 right-0 h-0 w-0 opacity-0"
                            onChange={(e) => e.target.value && setText(e.target.value.replace("T", " "))}
                        />
                    </div>

                    <Select value={sourceZone} onValueChange={setSourceZone}>
                        <SelectTrigger className="h-9 w-56" aria-label="Zone for times without an offset">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value={LOCAL_ZONE}>Local — {LOCAL_ZONE}</SelectItem>
                            {LOCAL_ZONE !== "UTC" && <SelectItem value="UTC">UTC</SelectItem>}
                            {zones.map((zone) => (
                                <SelectItem key={zone} value={zone}>{describeZone(zone, null).label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Button variant="outline" className="h-9" onClick={setNowValue}>Now</Button>
                </div>
                {parsed.ok
                    ? <p className="text-xs text-muted-foreground">{KIND_LABEL[parsed.kind]}</p>
                    : <ErrorNote>{parsed.error}</ErrorNote>}
            </ToolPanel>

            <ToolPanel title="Converted">
                <div className="rounded-lg border bg-card">
                    <ResultRow
                        label="Local"
                        detail={`${LOCAL_ZONE} · ${date ? offsetLabel(date, LOCAL_ZONE) : ""}`}
                        value={date ? formatInZone(date, LOCAL_ZONE) : "—"}
                    />
                    {LOCAL_ZONE !== "UTC" && (
                        <ResultRow label="UTC" detail="GMT" value={date ? formatInZone(date, "UTC") : "—"} />
                    )}
                    {zones.map((zone) => (
                        <ResultRow
                            key={zone}
                            {...describeZone(zone, date)}
                            value={date ? formatInZone(date, zone) : "—"}
                            onRemove={() => removeZone(zone)}
                        />
                    ))}
                    <ResultRow label="ISO 8601" detail="UTC" value={date ? date.toISOString() : "—"} />
                    <ResultRow label="Unix seconds" value={date ? String(Math.floor(date.getTime() / 1000)) : "—"} />
                    <ResultRow label="Unix milliseconds" value={date ? String(date.getTime()) : "—"} />
                    <ResultRow label="Relative" detail="From now" value={date ? relativeTo(date, now) : "—"} />
                </div>
            </ToolPanel>

            <ToolPanel title="Add a time zone">
                <div className="max-w-md">
                    <TimezoneCombobox
                        options={OFFSET_OPTIONS}
                        // Local's current offset would just repeat the Local row.
                        exclude={[offsetLabel(now, LOCAL_ZONE), ...zones]}
                        onSelect={addZone}
                        placeholder="Search an offset or place, e.g. +9, Tokyo"
                    />
                </div>
                <p className="text-xs text-muted-foreground">
                    Fixed GMT offsets — they don't shift for daylight saving. Added offsets show above, can be picked as the input zone, and are remembered on this device.
                </p>
            </ToolPanel>
        </div>
    );
}
