import { History, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { UnusedAssetsHistorySnapshot } from "@/lib/unused-assets-history";

interface UnusedAssetsHistoryDropdownProps {
    entries: UnusedAssetsHistorySnapshot[];
    onSelect: (snapshot: UnusedAssetsHistorySnapshot) => void;
    onDelete: (id: string) => void;
    onClear: () => void;
    disabled?: boolean;
}

function summarize(snapshot: UnusedAssetsHistorySnapshot): string {
    const { result } = snapshot;
    const cssCount = result.cssUnused.length + result.cssDynamic.length;
    return `${cssCount} CSS · ${result.jsUnused.length} JS`;
}

export default function UnusedAssetsHistoryDropdown({ entries, onSelect, onDelete, onClear, disabled }: UnusedAssetsHistoryDropdownProps) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={disabled || entries.length === 0}>
                    <History className="w-4 h-4" />
                    History{entries.length > 0 ? ` (${entries.length})` : ""}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel>Saved scans</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {entries.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved scans yet.</div>
                ) : (
                    <div className="max-h-80 overflow-y-auto scrollable-content">
                        {entries.map((entry) => (
                            <DropdownMenuItem
                                key={entry.id}
                                onClick={() => onSelect(entry)}
                                className="flex items-start justify-between gap-2"
                            >
                                <div className="flex flex-col">
                                    <span className="text-sm font-mono">
                                        {entry.folderName ?? "unknown"}
                                        {entry.gitBranch && <span className="text-muted-foreground"> ({entry.gitBranch})</span>}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                        {new Date(entry.savedAt).toLocaleString()} · {summarize(entry)}
                                    </span>
                                </div>
                                <button
                                    type="button"
                                    title="Delete"
                                    className="text-muted-foreground hover:text-destructive shrink-0"
                                    onClick={(e) => { e.stopPropagation(); onDelete(entry.id); }}
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </DropdownMenuItem>
                        ))}
                    </div>
                )}
                {entries.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={onClear} className="text-destructive focus:text-destructive">
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Clear all
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
