import { History, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { Hint } from "@/components/ui/hint";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { PageSpeedHistorySnapshot } from '@/lib/pagespeed-history';

interface PageSpeedHistoryDropdownProps {
    entries: PageSpeedHistorySnapshot[];
    onSelect: (snapshot: PageSpeedHistorySnapshot) => void;
    onDelete: (id: string) => void;
    onClear: () => void;
    disabled?: boolean;
}

function summarize(snapshot: PageSpeedHistorySnapshot): string {
    const { config } = snapshot;
    const count = config.urls.length;
    const parts = [`${count} URL${count === 1 ? '' : 's'}`];
    if (config.comparisonMode) parts.push('compare');
    if (config.runs > 1) parts.push(`${config.runs}× ${config.aggregation}`);
    return parts.join(' · ');
}

export default function PageSpeedHistoryDropdown({ entries, onSelect, onDelete, onClear, disabled }: PageSpeedHistoryDropdownProps) {
    return (
        <DropdownMenu>
            <Hint label={entries.length === 0 ? 'No saved analyses yet - use Save to history after a run' : 'Reopen a saved analysis, config and results included'}>
                <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={disabled || entries.length === 0}>
                        <History className="mr-1 h-4 w-4" />
                        History{entries.length > 0 ? ` (${entries.length})` : ''}
                    </Button>
                </DropdownMenuTrigger>
            </Hint>
            <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel>Saved analyses</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {entries.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved analyses yet.</div>
                ) : (
                    <div className="max-h-80 overflow-y-auto scrollable-content">
                        {entries.map(entry => (
                            <DropdownMenuItem
                                key={entry.id}
                                onClick={() => onSelect(entry)}
                                className="flex items-start justify-between gap-2"
                            >
                                <div className="flex flex-col">
                                    <span className="text-sm">{new Date(entry.savedAt).toLocaleString()}</span>
                                    <span className="text-xs text-muted-foreground">{summarize(entry)}</span>
                                </div>
                                <Hint label="Delete this saved analysis" side="left">
                                    <button
                                        type="button"
                                        className="text-muted-foreground hover:text-destructive"
                                        onClick={e => { e.stopPropagation(); onDelete(entry.id); }}
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                </Hint>
                            </DropdownMenuItem>
                        ))}
                    </div>
                )}
                {entries.length > 0 && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={onClear}
                            className="text-destructive focus:text-destructive"
                        >
                            <Trash2 className="mr-2 h-3.5 w-3.5" /> Clear all
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
