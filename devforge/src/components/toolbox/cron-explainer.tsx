import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CronCreator, defaultCronCreatorState, type CronCreatorState } from "./cron-creator";
import { CronPreview } from "./cron-preview";

const PRESETS = [
    { label: "Every 5 min", expression: "*/5 * * * *" },
    { label: "Weekdays 09:00", expression: "0 9 * * 1-5" },
    { label: "Nightly 02:30", expression: "30 2 * * *" },
    { label: "Every 30s (NCRONTAB)", expression: "*/30 * * * * *" },
];

type CronTab = "explain" | "create";

function ExplainPanel({ expression, onChange }: { expression: string; onChange: (expression: string) => void }) {
    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <Input
                value={expression}
                onChange={(event) => onChange(event.target.value)}
                placeholder="*/5 * * * *"
                spellCheck={false}
                className="font-mono text-sm"
            />

            <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => (
                    <Button
                        key={preset.expression}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => onChange(preset.expression)}
                    >
                        {preset.label}
                    </Button>
                ))}
            </div>

            <CronPreview expression={expression} />
        </div>
    );
}

export default function CronExplainer() {
    // Both tabs' state lives here: Radix unmounts the inactive tab, which would reset its form.
    const [tab, setTab] = useState<CronTab>("explain");
    const [expression, setExpression] = useState("*/5 * * * *");
    const [creator, setCreator] = useState<CronCreatorState>(defaultCronCreatorState);

    const openInExplain = (built: string) => {
        setExpression(built);
        setTab("explain");
    };

    return (
        <Tabs value={tab} onValueChange={(value) => setTab(value as CronTab)} className="flex flex-col h-full min-h-0">
            <TabsList className="self-start">
                <TabsTrigger value="explain">Explain</TabsTrigger>
                <TabsTrigger value="create">Create</TabsTrigger>
            </TabsList>
            <TabsContent value="explain" className="flex-1 min-h-0">
                <ExplainPanel expression={expression} onChange={setExpression} />
            </TabsContent>
            <TabsContent value="create" className="flex-1 min-h-0">
                <CronCreator state={creator} onChange={setCreator} onOpenInExplain={openInExplain} />
            </TabsContent>
        </Tabs>
    );
}
