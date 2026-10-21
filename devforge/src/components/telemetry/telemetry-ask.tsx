import { useCallback, useEffect, useMemo, useState } from 'react';
import { BookmarkPlus, ImageIcon, Loader2, Sparkles, Square, TableIcon } from 'lucide-react';
import type { TelemetryTarget } from '@shared/types/telemetry.types';
import useTelemetryAsk from '@/hooks/useTelemetryAsk';
import { useCopyElementAsImage } from '@/hooks/useCopyElementAsImage';
import { useSettings } from '@/context/settings-context';
import { isElectron } from '@/lib/environment';
import { cn } from '@/lib/utils';
import { toChartData, toTsv } from '@/lib/telemetry-chart';
import {
    deleteQuery, loadLibrary, loadRecent, pushRecent, renameQuery, saveQuery, type SavedTelemetryQuery,
} from '@/lib/telemetry-library';
import { toDatetimeLocal } from '@/components/app-health-check/styles';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toast } from '@/components/ui/toast';
import { KqlEditor } from './kql-editor';
import { SavedQueries } from './saved-queries';
import { TelemetryResultChart } from './telemetry-result-chart';
import { TelemetryResultTable } from './telemetry-result-table';

type RangePreset = '1h' | '24h' | '7d' | 'custom';

const PRESET_MS: Record<Exclude<RangePreset, 'custom'>, number> = {
    '1h': 3_600_000,
    '24h': 24 * 3_600_000,
    '7d': 7 * 24 * 3_600_000,
};

const STARTERS = [
    'p95 duration by operation over time',
    'Top 10 exception types',
    'Failed dependency calls by target',
    'Requests per minute and 5xx rate',
    'Slowest 20 pages by average load time',
];

const STAGE_LABEL = {
    schema: 'Reading the app’s tables…',
    generating: 'Claude is writing the query…',
    running: 'Running the query…',
    repairing: 'The query was rejected — Claude is fixing it…',
} as const;

export default function TelemetryAsk() {
    const toast = Toast();
    const { settings } = useSettings();
    const apps = settings.azure.apps;
    const { state, ask, run, cancel, load } = useTelemetryAsk();
    const { elementRef, copyAsImage, isCopying } = useCopyElementAsImage<HTMLDivElement>({ fileNamePrefix: 'telemetry' });

    const [appKey, setAppKey] = useState(() => apps[0]?.name ?? '');
    const [target, setTarget] = useState<TelemetryTarget>('fe');
    const [preset, setPreset] = useState<RangePreset>('24h');
    const [customStart, setCustomStart] = useState(() => toDatetimeLocal(new Date(Date.now() - PRESET_MS['24h'])));
    const [customEnd, setCustomEnd] = useState(() => toDatetimeLocal(new Date()));
    const [question, setQuestion] = useState('');
    const [askedQuestion, setAskedQuestion] = useState('');
    const [kqlDraft, setKqlDraft] = useState('');
    const [library, setLibrary] = useState<SavedTelemetryQuery[]>(loadLibrary);
    const [recent, setRecent] = useState<string[]>(loadRecent);

    // Settings load after first render; pick the first app once they arrive.
    useEffect(() => {
        if (!apps.some(a => a.name === appKey)) setAppKey(apps[0]?.name ?? '');
    }, [apps, appKey]);

    useEffect(() => { setKqlDraft(state.kql); }, [state.kql]);

    const app = apps.find(a => a.name === appKey);
    const hasApi = !!app?.apiName;
    useEffect(() => { if (!hasApi && target === 'api') setTarget('fe'); }, [hasApi, target]);

    const appLabel = useCallback(
        (key: string) => {
            const a = apps.find(x => x.name === key);
            return a ? (a.platformName || a.resourceGroup || a.name) : key;
        },
        [apps],
    );

    const range = () => {
        if (preset === 'custom') {
            return { startIso: new Date(customStart).toISOString(), endIso: new Date(customEnd).toISOString() };
        }
        const end = new Date();
        return { startIso: new Date(end.getTime() - PRESET_MS[preset]).toISOString(), endIso: end.toISOString() };
    };

    const running = state.status === 'running';
    const rangeInvalid = preset === 'custom' && !(new Date(customEnd) > new Date(customStart));
    const blocked = !appKey || rangeInvalid;

    const doAsk = (q = question) => {
        const text = q.trim();
        if (!text || blocked || running) return;
        setQuestion(text);
        setAskedQuestion(text);
        setRecent(pushRecent(text));
        void ask({ config: settings.azure, appKey, target, question: text, ...range() });
    };

    const doRun = (kql = kqlDraft, key = appKey, tgt = target) => {
        if (!kql.trim() || running || rangeInvalid) return;
        void run({ config: settings.azure, appKey: key, target: tgt, kql, ...range() });
    };

    const runSaved = (entry: SavedTelemetryQuery) => {
        if (apps.some(a => a.name === entry.appKey)) setAppKey(entry.appKey);
        setTarget(entry.target);
        setQuestion(entry.question);
        setAskedQuestion(entry.question);
        load(entry.kql, entry.chart);
        doRun(entry.kql, entry.appKey, entry.target);
    };

    const save = () => {
        const kql = kqlDraft.trim();
        if (!kql) return;
        const name = (askedQuestion || 'Saved query').slice(0, 80);
        const { entries, error } = saveQuery({ name, question: askedQuestion, kql, appKey, target, chart: state.chart });
        setLibrary(entries);
        if (error) toast.error(error);
        else toast.success('Saved to library');
    };

    const result = state.result;
    const chartData = useMemo(
        () => (result?.columns && result.rows ? toChartData(result.columns, result.rows, state.chart) : { kind: 'table' as const }),
        [result, state.chart],
    );

    if (!isElectron()) {
        return <p className="text-sm text-muted-foreground">Ask Telemetry runs in the desktop app only.</p>;
    }
    if (!apps.length) {
        return <p className="text-sm text-muted-foreground">Add an Azure app in Settings → Azure to ask about its telemetry.</p>;
    }

    return (
        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="flex min-w-0 flex-col gap-4">
                <Card>
                    <CardContent className="flex flex-col gap-3 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <Select value={appKey} onValueChange={setAppKey}>
                                <SelectTrigger className="h-8 w-[220px]" aria-label="App">
                                    <SelectValue placeholder="Pick an app" />
                                </SelectTrigger>
                                <SelectContent>
                                    {apps.map(a => <SelectItem key={a.name} value={a.name}>{appLabel(a.name)}</SelectItem>)}
                                </SelectContent>
                            </Select>
                            <Segmented
                                value={target}
                                onChange={(v) => setTarget(v as TelemetryTarget)}
                                options={[
                                    { value: 'fe', label: 'Frontend' },
                                    { value: 'api', label: 'API', disabled: !hasApi, hint: 'No API configured for this app' },
                                ]}
                            />
                            <Segmented
                                value={preset}
                                onChange={(v) => setPreset(v as RangePreset)}
                                options={[
                                    { value: '1h', label: '1h' },
                                    { value: '24h', label: '24h' },
                                    { value: '7d', label: '7d' },
                                    { value: 'custom', label: 'Custom' },
                                ]}
                            />
                            {preset === 'custom' && (
                                <div className="flex items-center gap-1">
                                    <Input type="datetime-local" value={customStart} onChange={e => setCustomStart(e.target.value)} className="h-8 w-[190px] text-xs" aria-label="From" />
                                    <span className="text-xs text-muted-foreground">→</span>
                                    <Input type="datetime-local" value={customEnd} onChange={e => setCustomEnd(e.target.value)} className="h-8 w-[190px] text-xs" aria-label="To" />
                                </div>
                            )}
                        </div>
                        {rangeInvalid && <p className="text-xs text-destructive">The end of the range must be after the start.</p>}

                        <div className="flex flex-col gap-2">
                            <textarea
                                value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doAsk(); }
                                }}
                                rows={2}
                                placeholder="Ask about this app’s telemetry, e.g. “which endpoints got slower in the last day?”"
                                aria-label="Question"
                                className="w-full resize-y rounded-md border bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            />
                            <div className="flex flex-wrap items-center gap-2">
                                {running ? (
                                    <Button size="sm" variant="outline" onClick={() => void cancel()}>
                                        <Square /> Cancel
                                    </Button>
                                ) : (
                                    <Button size="sm" onClick={() => doAsk()} disabled={!question.trim() || blocked}>
                                        <Sparkles /> Ask
                                    </Button>
                                )}
                                {running && state.stage && (
                                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <Loader2 className="h-3 w-3 animate-spin" /> {STAGE_LABEL[state.stage]}
                                    </span>
                                )}
                                {!running && (
                                    <span className="text-xs text-muted-foreground">Ctrl+Enter · only the question and table names go to Claude</span>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {[...recent.slice(0, 3), ...STARTERS.filter(s => !recent.includes(s))].slice(0, 6).map(s => (
                                    <button
                                        key={s}
                                        type="button"
                                        disabled={running || blocked}
                                        onClick={() => doAsk(s)}
                                        className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {state.status === 'error' && state.error && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{state.error}</div>
                )}
                {state.status === 'cancelled' && (
                    <div className="rounded-md border p-3 text-sm text-muted-foreground">Cancelled.</div>
                )}

                {(kqlDraft || state.kql) && (
                    <Card>
                        <CardContent className="flex flex-col gap-4 p-4">
                            <KqlEditor
                                kql={kqlDraft}
                                onChange={setKqlDraft}
                                onRun={() => doRun()}
                                running={running}
                                explanation={state.explanation}
                                repaired={state.repaired}
                            />

                            {result?.error && (
                                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 font-mono text-xs text-destructive whitespace-pre-wrap">
                                    {result.error}
                                </div>
                            )}

                            {result?.columns && result.rows && (
                                <div className="flex flex-col gap-3">
                                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                        <span>
                                            {result.rows.length.toLocaleString()} row{result.rows.length === 1 ? '' : 's'}
                                            {result.truncated && ' (first 5,000 — narrow the query for the rest)'}
                                            {result.durationMs != null && ` · ${(result.durationMs / 1000).toFixed(1)}s`}
                                        </span>
                                        {state.meta && state.meta.tokens.total > 0 && (
                                            // Runs on the Claude Code login, so there is no per-question charge:
                                            // tokens are what it uses of the plan; the dollar figure is only
                                            // what the same call would cost on the API.
                                            <Hint label={`Uses your Claude Code plan, not the API — no per-question charge.${state.meta.costUsd > 0 ? ` API-equivalent ≈ $${state.meta.costUsd.toFixed(3)}.` : ''}${state.meta.calls > 1 ? ` ${state.meta.calls} Claude calls.` : ''}`}>
                                                <span className="cursor-help underline decoration-dotted underline-offset-2">
                                                    Claude {state.meta.tokens.total.toLocaleString()} tokens
                                                </span>
                                            </Hint>
                                        )}
                                        <div className="flex-1" />
                                        <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard.writeText(toTsv(result.columns!, result.rows!)); toast.success('Copied rows — paste into Excel or Teams'); }}>
                                            <TableIcon /> Copy rows
                                        </Button>
                                        {chartData.kind !== 'table' && (
                                            <Button variant="ghost" size="sm" onClick={() => void copyAsImage()} disabled={isCopying}>
                                                {isCopying ? <Loader2 className="animate-spin" /> : <ImageIcon />} Copy chart
                                            </Button>
                                        )}
                                        <Button variant="outline" size="sm" onClick={save}>
                                            <BookmarkPlus /> Save
                                        </Button>
                                    </div>

                                    <Tabs key={chartData.kind} defaultValue={chartData.kind === 'table' ? 'table' : 'chart'}>
                                        <TabsList>
                                            <TabsTrigger value="chart" disabled={chartData.kind === 'table'}>Chart</TabsTrigger>
                                            <TabsTrigger value="table">Table</TabsTrigger>
                                        </TabsList>
                                        <TabsContent value="chart">
                                            <div ref={elementRef} className="rounded-md border bg-card p-3">
                                                {askedQuestion && <div className="mb-2 text-sm font-medium">{askedQuestion}</div>}
                                                <TelemetryResultChart data={chartData} />
                                                <div className="mt-1 text-[10px] text-muted-foreground">
                                                    {appLabel(appKey)} · {target === 'api' ? 'API' : 'Frontend'} · times in SGT
                                                </div>
                                            </div>
                                        </TabsContent>
                                        <TabsContent value="table">
                                            <TelemetryResultTable columns={result.columns} rows={result.rows} />
                                        </TabsContent>
                                    </Tabs>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                )}
            </div>

            <div className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">Saved queries</h2>
                <SavedQueries
                    entries={library}
                    appLabel={appLabel}
                    onRun={runSaved}
                    onRename={(id, name) => setLibrary(renameQuery(id, name))}
                    onDelete={(id) => setLibrary(deleteQuery(id))}
                    disabled={running || rangeInvalid}
                />
            </div>
        </div>
    );
}

function Segmented({
    value, onChange, options,
}: {
    value: string;
    onChange: (value: string) => void;
    options: { value: string; label: string; disabled?: boolean; hint?: string }[];
}) {
    return (
        <div className="inline-flex h-8 items-center rounded-md border p-0.5" role="radiogroup">
            {options.map(o => (
                <button
                    key={o.value}
                    type="button"
                    role="radio"
                    aria-checked={value === o.value}
                    disabled={o.disabled}
                    title={o.disabled ? o.hint : undefined}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        'h-full rounded px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                        value === o.value ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    );
}
