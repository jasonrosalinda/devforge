import { useId, useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    flattenAppSettings, parseSettingRows, toAzureAdvancedEdit, toEnvLines, unflattenAppSettings,
} from "@/lib/toolbox/appsettings";
import { CopyButton, ErrorNote, OutputBox, ToolPanel, WarningNote } from "./toolbox-shared";

type Direction = "to-azure" | "to-json";

function ToAzure() {
    const [text, setText] = useState("");
    const [slotSetting, setSlotSetting] = useState(false);
    const slotId = useId();
    const result = useMemo(() => (text.trim() ? flattenAppSettings(text) : null), [text]);
    const advanced = result && !result.error ? toAzureAdvancedEdit(result.rows, slotSetting) : "";
    const env = result && !result.error ? toEnvLines(result.rows) : "";

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'Paste appsettings.json — comments and trailing commas are fine\n{ "Logging": { "LogLevel": { "Default": "Information" } } }'}
                spellCheck={false}
                className="font-mono text-xs h-40 resize-y"
            />
            {result?.error && <ErrorNote>{result.error}</ErrorNote>}
            {result && result.collisions.length > 0 && (
                <WarningNote>
                    These names differ only by case, and Windows environment variables ignore case, so one overwrites the other: {result.collisions.join(", ")}
                </WarningNote>
            )}
            <div className="flex items-center gap-2 text-xs">
                <Switch id={slotId} checked={slotSetting} onCheckedChange={setSlotSetting} />
                <Label htmlFor={slotId} className="text-xs font-normal">Mark every setting as a deployment slot setting (sticky)</Label>
                {result && !result.error && <span className="ml-auto text-muted-foreground">{result.rows.length} settings</span>}
            </div>
            <div className="grid gap-3 md:grid-cols-2 flex-1 min-h-0">
                <ToolPanel title="Azure Advanced edit (JSON)" actions={<CopyButton value={advanced} label="Copy Advanced-edit JSON" />}>
                    <OutputBox value={advanced} placeholder="Paste into App Service → Configuration → Advanced edit" />
                </ToolPanel>
                <ToolPanel title="NAME=value (.env, pipelines)" actions={<CopyButton value={env} label="Copy NAME=value lines" />}>
                    <OutputBox value={env} placeholder="One setting per line" />
                </ToolPanel>
            </div>
        </div>
    );
}

function ToJson() {
    const [text, setText] = useState("");
    const result = useMemo(() => {
        if (!text.trim()) return null;
        const parsed = parseSettingRows(text);
        return parsed.error
            ? { error: parsed.error, json: "", conflicts: [] }
            : { error: undefined, ...unflattenAppSettings(parsed.rows) };
    }, [text]);
    const json = result?.json ?? "";

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={'Paste Azure Advanced-edit JSON or NAME=value lines\nLogging__LogLevel__Default=Information'}
                spellCheck={false}
                className="font-mono text-xs h-40 resize-y"
            />
            {result?.error && <ErrorNote>{result.error}</ErrorNote>}
            {result && !result.error && result.conflicts.length > 0 && (
                <WarningNote>Left out because another setting already uses the same key as a value: {result.conflicts.join(", ")}</WarningNote>
            )}
            <p className="text-[11px] text-muted-foreground">
                Both <code>__</code> and <code>:</code> split a key. Values come back as strings: a setting can&apos;t say whether &quot;5&quot; was a number.
            </p>
            <ToolPanel title="appsettings.json" className="flex-1" actions={<CopyButton value={json} label="Copy JSON" />}>
                <OutputBox value={json} placeholder="Nested JSON appears here" />
            </ToolPanel>
        </div>
    );
}

/** appsettings.json ⇄ Azure App Service settings (`Section__Key`). Offline. */
export default function AppSettingsConverter() {
    const [direction, setDirection] = useState<Direction>("to-azure");
    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="flex flex-wrap items-center gap-2">
                <Button variant={direction === "to-azure" ? "default" : "outline"} size="sm" className="h-8 text-xs" onClick={() => setDirection("to-azure")}>
                    appsettings.json → Azure
                </Button>
                <Button variant={direction === "to-json" ? "default" : "outline"} size="sm" className="h-8 text-xs" onClick={() => setDirection("to-json")}>
                    Azure → appsettings.json
                </Button>
            </div>
            {direction === "to-azure" ? <ToAzure /> : <ToJson />}
        </div>
    );
}
