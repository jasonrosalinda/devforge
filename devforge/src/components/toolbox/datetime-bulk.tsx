import { useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LOCAL_ZONE } from "@/lib/toolbox/datetime";
import { SGT_ZONE, shiftTimestamps } from "@/lib/toolbox/timestamps";
import { CopyButton, OutputBox, ToolPanel } from "./toolbox-shared";

/**
 * Paste logs, JSON, a table: every timestamp with a zone (and, optionally, every one
 * without) is restated in one zone, SGT by default. Everything else is left as it is.
 */
export function DateTimeBulk({ zones }: { zones: string[] }) {
    const [text, setText] = useState("");
    const [zone, setZone] = useState(SGT_ZONE);
    const [naiveAsUtc, setNaiveAsUtc] = useState(false);
    const result = useMemo(() => shiftTimestamps(text, { zone, naiveAsUtc }), [text, zone, naiveAsUtc]);
    const choices = [...new Set([SGT_ZONE, "UTC", LOCAL_ZONE, ...zones])];

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">Restate every timestamp in</span>
                <Select value={zone} onValueChange={setZone}>
                    <SelectTrigger className="h-8 w-52 text-xs" aria-label="Target time zone"><SelectValue /></SelectTrigger>
                    <SelectContent>
                        {choices.map((z) => (
                            <SelectItem key={z} value={z}>
                                {z === SGT_ZONE ? "SGT — Asia/Singapore" : z === LOCAL_ZONE ? `Local — ${z}` : z}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Button
                    variant={naiveAsUtc ? "secondary" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    aria-pressed={naiveAsUtc}
                    onClick={() => setNaiveAsUtc((v) => !v)}
                    title="Also treat date-times with no zone (2026-11-09 02:23:00) as UTC, as App Insights and SQL exports often are"
                >
                    No zone = UTC
                </Button>
                {text.trim() && <span className="text-muted-foreground">{result.count} timestamp{result.count === 1 ? "" : "s"} converted</span>}
            </div>
            <p className="text-[11px] text-muted-foreground">
                Reads ISO 8601 with a zone (<code>2026-11-09T02:23:00Z</code>, <code>+00:00</code>, <code>-05:00</code>), <code>… UTC</code> / <code>… GMT</code> and HTTP dates (<code>Mon, 09 Nov 2026 02:23:00 GMT</code>). Unix numbers are left alone.
            </p>
            <div className="grid gap-3 md:grid-cols-2 flex-1 min-h-0">
                <ToolPanel title="Input">
                    <Textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder={'Paste logs, JSON, CSV…\n2026-11-09T02:23:00Z ERROR request failed'}
                        spellCheck={false}
                        className="font-mono text-xs flex-1 min-h-[12rem] resize-none"
                    />
                </ToolPanel>
                <ToolPanel title="Output" actions={<CopyButton value={text.trim() ? result.text : ""} label="Copy output" />}>
                    <OutputBox value={text.trim() ? result.text : ""} placeholder="The same text, with every timestamp restated" />
                </ToolPanel>
            </div>
        </div>
    );
}
