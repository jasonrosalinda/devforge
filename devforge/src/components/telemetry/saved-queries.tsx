import { useState } from 'react';
import { Bell, BellRing, BookMarked, Check, Pencil, Play, Trash2, X } from 'lucide-react';
import { DEFAULT_ALERT_RULE, type SavedTelemetryQuery, type TelemetryAlertRule } from '@/lib/telemetry-library';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Hint } from '@/components/ui/hint';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** Rule editor for one saved query. Column names are suggested from the last result shown. */
function AlertEditor({ entry, columns, monitorOn, onSave, onOpenMonitorSettings }: {
    entry: SavedTelemetryQuery;
    columns: string[];
    monitorOn: boolean;
    onSave: (rule: TelemetryAlertRule | undefined) => void;
    onOpenMonitorSettings: () => void;
}) {
    const [rule, setRule] = useState<TelemetryAlertRule>(entry.alert ?? DEFAULT_ALERT_RULE);
    const set = (patch: Partial<TelemetryAlertRule>) => setRule(r => ({ ...r, ...patch }));
    const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
    const invalid =
        !(rule.windowMin >= 1) || !(rule.everyMin >= 1) ||
        (rule.kind === 'column' && (!rule.column?.trim() || !Number.isFinite(rule.threshold)));
    const listId = `alert-cols-${entry.id}`;

    return (
        <div className="flex flex-col gap-3 text-xs">
            <div className="flex items-center justify-between">
                <Label htmlFor={`alert-on-${entry.id}`} className="text-xs font-medium">Alert from the tray</Label>
                <Switch id={`alert-on-${entry.id}`} checked={rule.enabled} onCheckedChange={v => set({ enabled: v })} />
            </div>

            <div className="flex gap-1" role="radiogroup" aria-label="Alert when">
                {(['rows', 'column'] as const).map(kind => (
                    <Button key={kind} type="button" size="sm" role="radio" aria-checked={rule.kind === kind}
                        variant={rule.kind === kind ? 'secondary' : 'outline'} className="h-7 flex-1 text-xs" onClick={() => set({ kind })}>
                        {kind === 'rows' ? 'Any rows returned' : 'A column goes above'}
                    </Button>
                ))}
            </div>

            {rule.kind === 'column' && (
                <div className="grid grid-cols-[1fr_6rem] gap-2">
                    <Input list={listId} value={rule.column ?? ''} onChange={e => set({ column: e.target.value })} placeholder="column" className="h-7 text-xs font-mono" aria-label="Column" />
                    <datalist id={listId}>{columns.map(c => <option key={c} value={c} />)}</datalist>
                    <Input type="number" value={rule.threshold ?? ''} onChange={e => set({ threshold: num(e.target.value) })} placeholder="threshold" className="h-7 text-xs" aria-label="Threshold" />
                </div>
            )}

            <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Look back (min)</span>
                    <Input type="number" min={1} value={rule.windowMin} onChange={e => set({ windowMin: Number(e.target.value) })} className="h-7 text-xs" />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Check every (min)</span>
                    <Input type="number" min={1} value={rule.everyMin} onChange={e => set({ everyMin: Number(e.target.value) })} className="h-7 text-xs" />
                </label>
            </div>

            <p className="text-muted-foreground">
                Alerts once when the condition starts, and again only after it clears. Each check is one App Insights query.
            </p>
            {!monitorOn && (
                <p className="text-warning">
                    The background monitor is off, so this will not run.{' '}
                    <button type="button" className="underline underline-offset-2" onClick={onOpenMonitorSettings}>Turn it on</button>
                </p>
            )}

            <div className="flex justify-end gap-2">
                {entry.alert && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onSave(undefined)}>Remove alert</Button>}
                <Button size="sm" className="h-7 text-xs" disabled={invalid} onClick={() => onSave({ ...rule, column: rule.column?.trim() || undefined })}>Save alert</Button>
            </div>
        </div>
    );
}

/** The saved query library. Running one reuses its KQL over the current range — no Claude call. */
export function SavedQueries({
    entries, appLabel, onRun, onRename, onDelete, onAlertChange, columns = [], monitorOn = false, onOpenMonitorSettings = () => {}, disabled,
}: {
    entries: SavedTelemetryQuery[];
    appLabel: (appKey: string) => string;
    onRun: (entry: SavedTelemetryQuery) => void;
    onRename: (id: string, name: string) => void;
    onDelete: (id: string) => void;
    onAlertChange: (id: string, rule: TelemetryAlertRule | undefined) => void;
    /** Columns of the result on screen, offered as column suggestions for an alert. */
    columns?: string[];
    monitorOn?: boolean;
    onOpenMonitorSettings?: () => void;
    disabled?: boolean;
}) {
    const [editing, setEditing] = useState<string | null>(null);
    const [alertOpen, setAlertOpen] = useState<string | null>(null);
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
                    <Popover open={alertOpen === e.id} onOpenChange={o => setAlertOpen(o ? e.id : null)}>
                        <Hint label={e.alert?.enabled ? 'Alert on — edit' : 'Alert me from the tray'}>
                            <PopoverTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Alert settings for ${e.name}`}>
                                    {e.alert?.enabled ? <BellRing className="text-warning" /> : <Bell />}
                                </Button>
                            </PopoverTrigger>
                        </Hint>
                        <PopoverContent align="end" className="w-80">
                            <AlertEditor
                                entry={e}
                                columns={columns}
                                monitorOn={monitorOn}
                                onOpenMonitorSettings={() => { setAlertOpen(null); onOpenMonitorSettings(); }}
                                onSave={rule => { onAlertChange(e.id, rule); setAlertOpen(null); }}
                            />
                        </PopoverContent>
                    </Popover>
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
