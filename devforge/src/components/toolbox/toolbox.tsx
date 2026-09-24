import { useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TOOLBOX_TOOLS } from "./toolbox-registry";

const STORAGE_KEY = "devforge_toolbox_tab";

const DEFAULT_TAB = TOOLBOX_TOOLS[0]!.id;

/** Reads the remembered tab, ignoring anything a previous version wrote that no longer exists. */
function readStoredTab(): string {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return TOOLBOX_TOOLS.some((tool) => tool.id === stored) ? stored! : DEFAULT_TAB;
    } catch {
        return DEFAULT_TAB;
    }
}

export default function Toolbox() {
    const [active, setActive] = useState<string>(DEFAULT_TAB);

    // Read after mount so the web build's first paint does not depend on
    // storage being readable (it is not, in a private window).
    useEffect(() => {
        setActive(readStoredTab());
    }, []);

    const selectTab = (id: string) => {
        setActive(id);
        try {
            localStorage.setItem(STORAGE_KEY, id);
        } catch {
            // Remembering the tab is a convenience; losing it is not worth an error.
        }
    };

    const activeTool = TOOLBOX_TOOLS.find((tool) => tool.id === active) ?? TOOLBOX_TOOLS[0]!;

    return (
        <Tabs value={active} onValueChange={selectTab} className="flex flex-col gap-3 flex-1 min-h-0">
            <div className="flex flex-col gap-1">
                <TabsList className="self-start h-auto flex-wrap justify-start">
                    {TOOLBOX_TOOLS.map((tool) => {
                        const Icon = tool.icon;
                        return (
                            <TabsTrigger key={tool.id} value={tool.id} className="gap-1.5">
                                <Icon className="h-3.5 w-3.5" />
                                {tool.label}
                            </TabsTrigger>
                        );
                    })}
                </TabsList>
                <p className="text-xs text-muted-foreground">{activeTool.description}</p>
            </div>

            {TOOLBOX_TOOLS.map((tool) => {
                const Component = tool.component;
                return (
                    <TabsContent key={tool.id} value={tool.id} className="flex-1 min-h-0 mt-0">
                        <Component />
                    </TabsContent>
                );
            })}
        </Tabs>
    );
}
