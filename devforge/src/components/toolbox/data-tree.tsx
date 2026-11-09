import { useState } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { childEntries, childPath, nodeKind, nodeSummary, type NodeKind } from "@/lib/toolbox/dataTree";
import { friendlyInZone, timestampValue } from "@/lib/toolbox/timestamps";
import { cn } from "@/lib/utils";

/** Show each timestamp value restated in this zone beside it; null = off. */
export interface TreeDates { zone: string; naiveAsUtc: boolean }

const VALUE_CLASS: Record<NodeKind, string> = {
    object: "text-muted-foreground",
    array: "text-muted-foreground",
    string: "text-emerald-600 dark:text-emerald-400",
    number: "text-sky-600 dark:text-sky-400",
    boolean: "text-violet-600 dark:text-violet-400",
    null: "text-muted-foreground italic",
};

function TreeNode({ name, value, path, depth, openDepth, dates }: { name: string; value: unknown; path: string; depth: number; openDepth: number; dates: TreeDates | null }) {
    const kind = nodeKind(value);
    const label = <span className="font-medium text-foreground">{name}</span>;
    if (kind !== "object" && kind !== "array") {
        const date = dates && kind === "string" ? timestampValue(value as string, dates) : null;
        return (
            <div className="flex flex-wrap gap-x-2 py-0.5 pl-4" title={path}>
                {label}
                <span className={cn("break-all", VALUE_CLASS[kind])}>{nodeSummary(value)}</span>
                {date && dates && <span className="rounded bg-primary/10 px-1 text-primary">{friendlyInZone(date, dates.zone)}</span>}
            </div>
        );
    }
    const { entries, more } = childEntries(value);
    return (
        <details open={depth < openDepth} className="group">
            <summary className="cursor-pointer select-none py-0.5 marker:text-muted-foreground" title={path}>
                {label} <span className={VALUE_CLASS[kind]}>{kind === "array" ? "[ ]" : "{ }"} {nodeSummary(value)}</span>
            </summary>
            <div className="ml-2 border-l pl-2">
                {entries.map(([key, child]) => (
                    <TreeNode
                        key={key}
                        name={kind === "array" ? `[${key}]` : key}
                        value={child}
                        path={childPath(path, key, kind === "array")}
                        depth={depth + 1}
                        openDepth={openDepth}
                        dates={dates}
                    />
                ))}
                {more > 0 && <div className="py-0.5 pl-4 text-muted-foreground">… {more} more not shown</div>}
            </div>
        </details>
    );
}

/** Read-only, collapsible view of parsed data. Hover a row for its path. */
export function DataTree({ value, dates = null }: { value: unknown; dates?: TreeDates | null }) {
    // Remount with a new default depth to expand or collapse everything.
    const [openDepth, setOpenDepth] = useState(2);
    const [version, setVersion] = useState(0);
    const setAll = (depth: number) => { setOpenDepth(depth); setVersion((v) => v + 1); };
    const kind = nodeKind(value);

    return (
        <div className="flex flex-1 min-h-0 flex-col rounded-md border bg-muted/40">
            <div className="flex items-center gap-1 border-b px-2 py-1">
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setAll(Number.POSITIVE_INFINITY)}>
                    <ChevronsUpDown className="mr-1 h-3 w-3" /> Expand all
                </Button>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setAll(1)}>
                    <ChevronsDownUp className="mr-1 h-3 w-3" /> Collapse all
                </Button>
                <span className="ml-auto text-[11px] text-muted-foreground" title="Hover a row to see its path, e.g. owner.login">Read-only</span>
            </div>
            <div key={version} className="flex-1 min-h-0 overflow-auto p-2 font-mono text-xs">
                {kind === "object" || kind === "array"
                    ? <TreeNode name="(root)" value={value} path="" depth={0} openDepth={openDepth} dates={dates} />
                    : <span className={VALUE_CLASS[kind]}>{nodeSummary(value)}</span>}
            </div>
        </div>
    );
}
