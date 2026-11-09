import { useId, useMemo, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { maskValue, parseConnectionString } from "@/lib/toolbox/connstring";
import { CopyButton } from "./toolbox-shared";

/** Splits an Azure connection string into fields, secrets masked. Offline. */
export default function ConnStringParser() {
    const [text, setText] = useState("");
    const [reveal, setReveal] = useState(false);
    const revealId = useId();
    const parsed = useMemo(() => parseConnectionString(text), [text]);

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Paste a connection string — SQL Server, Storage, Service Bus, Event Hubs, Cosmos DB, Redis, App Insights…"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs h-24 resize-none"
            />
            <div className="flex flex-wrap items-center gap-2 text-xs">
                {parsed.kind && <Badge variant="secondary" className="font-normal">{parsed.kind}</Badge>}
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                    Parsed on this machine; nothing is sent anywhere.
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <Switch id={revealId} checked={reveal} onCheckedChange={setReveal} />
                    <Label htmlFor={revealId} className="text-xs font-normal">Show secrets</Label>
                </div>
            </div>
            {parsed.fields.length > 0 && (
                <div className="rounded-md border divide-y overflow-auto min-h-0">
                    {parsed.fields.map((f, i) => (
                        <div key={`${f.key}-${i}`} className="flex items-center gap-3 px-3 py-1.5 text-xs">
                            <span className="w-44 shrink-0 font-medium break-all">
                                {f.key}
                                {f.secret && <Badge variant="outline" className="ml-2 font-normal">secret</Badge>}
                            </span>
                            <span className="flex-1 font-mono break-all">{f.secret && !reveal ? maskValue(f.value) : f.value}</span>
                            <CopyButton value={f.value} label={`Copy ${f.key}`} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
