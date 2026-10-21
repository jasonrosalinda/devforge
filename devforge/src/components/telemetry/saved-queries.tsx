import { useState } from 'react';
import { BookMarked, Check, Pencil, Play, Trash2, X } from 'lucide-react';
import type { SavedTelemetryQuery } from '@/lib/telemetry-library';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Hint } from '@/components/ui/hint';

/** The saved query library. Running one reuses its KQL over the current range — no Claude call. */
export function SavedQueries({
    entries, appLabel, onRun, onRename, onDelete, disabled,
}: {
    entries: SavedTelemetryQuery[];
    appLabel: (appKey: string) => string;
    onRun: (entry: SavedTelemetryQuery) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
    disabled?: boolean;
}) {
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState('');

    if (!entries.length) {
        return (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                <BookMarked className="h-5 w-5" />
                Saved queries appear here. Save one after a good answer to rerun it on any time range without asking again.
            </div>
        );
    }

    const commit = (id: string) => { onRename(id, draft); setEditing(null); };

    return (
        <ul className="flex flex-col divide-y rounded-md border">
            {entries.map(e => (
                <li key={e.id} className="flex items-start gap-2 p-3">
                    <div className="min-w-0 flex-1">
                        {editing === e.id ? (
                            <div className="flex items-center gap-1">
                                <Input
                                    autoFocus
                                    value={draft}
                                    onChange={(ev) => setDraft(ev.target.value)}
                                    onKeyDown={(ev) => {
                                        if (ev.key === 'Enter') commit(e.id);
                                        if (ev.key === 'Escape') setEditing(null);
                                    }}
                                    className="h-7 text-sm"
                                    aria-label="Query name"
                                />
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => commit(e.id)} aria-label="Save name"><Check /></Button>
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(null)} aria-label="Cancel rename"><X /></Button>
                            </div>
                        ) : (
                            <div className="truncate text-sm font-medium" title={e.question}>{e.name}</div>
                        )}
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {appLabel(e.appKey)} · {e.target === 'api' ? 'API' : 'FE'} · {new Date(e.savedAt).toLocaleDateString()}
                        </div>
                    </div>
                    <Hint label="Run on the current time range">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onRun(e)} disabled={disabled} aria-label={`Run ${e.name}`}>
                            <Play />
                        </Button>
                    </Hint>
                    <Hint label="Rename">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => { setEditing(e.id); setDraft(e.name); }} aria-label={`Rename ${e.name}`}>
                            <Pencil />
                        </Button>
                    </Hint>
                    <Hint label="Delete">
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onDelete(e.id)} aria-label={`Delete ${e.name}`}>
                            <Trash2 className="text-muted-foreground" />
                        </Button>
                    </Hint>
                </li>
            ))}
        </ul>
    );
}
