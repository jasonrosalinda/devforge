import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
    AlertTriangle, BookOpen, Check, Cloud, FileCode2, FileDown, FileText, FileType2, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, ImagePlus,
    Loader2, Search, Settings2, ShieldAlert, Share2, Sparkles, Trash2, Wrench, X,
} from 'lucide-react';
import type { InvestigationCategory, InvestigationProgress } from '@shared/types/app-investigation.types';
import useAppInvestigation from '@/hooks/useAppInvestigation';
import { useRcaReport } from '@/hooks/useRcaReport';
import { useSettings } from '@/context/settings-context';
import { useSettingsUi } from '@/context/settings-ui-context';
import { isElectron } from '@/lib/environment';
import { parseCitation } from '@/lib/safe-markdown';
import {
    deleteInvestigation, loadInvestigationHistory, metaOf, saveInvestigation, type InvestigationHistoryEntry,
} from '@/lib/app-investigation-history';
import { newRunId, splitInvestigationReport } from '@/lib/rca-report';
import type { AzureAppEntry, AzureSettings } from '@/types/settings.types';
import type { ReleaseResult } from '@shared/types/azureMetrics.types';
import { releaseStatus, releaseTitle, SOURCE_LABEL } from '@/components/azure/releaseMarkers';
import { toDatetimeLocal } from '@/components/app-health-check/styles';
import { downtimePeriod, formatSgt, formatSgtRange } from '@/components/azure/rcaHtml';
import { useUptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { RcaSection } from '@/components/azure/rcaSection';
import { MAX_IMAGE_BYTES, imageFilesFrom, readAsDataUrl } from '@/components/azure/richTextField';
import { AnalysisCard, type AnalysisState } from '@/components/shared/analysis-card';
import { Segmented } from '@/components/telemetry/telemetry-ask';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toast } from '@/components/ui/toast';

type RangePreset = '1h' | '6h' | '24h' | '3d';
const PRESET_MS: Record<RangePreset, number> = { '1h': 3_600_000, '6h': 6 * 3_600_000, '24h': 24 * 3_600_000, '3d': 72 * 3_600_000 };

const STARTERS = [
    'Users got 500 errors around 2pm yesterday',
    'The API has been slow since this morning’s deploy',
    'The app restarted several times overnight',
    'SQL timeouts spiked in the last hour',
];

const CATEGORY_LABEL: Record<InvestigationCategory, string> = {
    downtime: 'Downtime', errors: 'Errors / 5xx', exceptions: 'Exceptions', latency: 'Slowness', resource: 'CPU / memory',
    restart: 'Restarts', deployment: 'Deployment', dependency: 'Dependency / SQL', other: 'Other',
};

const REFUSAL_TITLE: Record<string, string> = {
    ACTION_REQUEST: 'Investigation only reads',
    SECRET_REQUEST: 'Secrets stay secret',
    OUT_OF_SCOPE: 'Outside what App Investigation covers',
    UNKNOWN_APP: 'No matching app',
};

type ReportTab = 'findings' | 'rca' | 'tracker';

const MAX_IMAGES = 5;
/** "705×573" for an attachment chip, or '' when the image will not decode. */
const imageSize = (src: string) => new Promise<string>(resolve => {
    const img = new Image();
    img.onload = () => resolve(`${img.naturalWidth}×${img.naturalHeight}`);
    img.onerror = () => resolve('');
    img.src = src;
});
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// The API shares the app's repository unless it has its own.
const repoFor = (app: AzureAppEntry | undefined, target: 'app' | 'api') =>
    (target === 'api' && app?.apiSourcePath) || app?.sourcePath || '';
const hasSeparateApiRepo = (app: AzureAppEntry | undefined) => !!app?.apiSourcePath && app.apiSourcePath !== app.sourcePath;

export default function AppInvestigation() {
    const toast = Toast();
    const { settings } = useSettings();
    const { openSettings } = useSettingsUi();
    const apps = settings.azure.apps;
    const { state, interpret, editInterpretation, run, cancel, backToConfirm, restore, reset } = useAppInvestigation();

    const [query, setQuery] = useState('');
    const [selectedAppKey, setSelectedAppKey] = useState(() => apps[0]?.name ?? '');
    const [preset, setPreset] = useState<RangePreset>('24h');
    const [repoOverride, setRepoOverride] = useState('');
    const [reportOpen, setReportOpen] = useState(true);
    const [tab, setTab] = useState<ReportTab>('findings');
    // Screenshots sent with the run as evidence. Main re-checks type, size and count.
    const [images, setImages] = useState<Array<{ name: string; dataUrl: string; size?: string }>>([]);
    const addImages = async (files: File[]) => {
        let count = images.length;
        for (const f of files) {
            if (count >= MAX_IMAGES) { toast.error(`At most ${MAX_IMAGES} screenshots per investigation.`); break; }
            if (!IMAGE_TYPES.includes(f.type)) { toast.error(`${f.name || 'That file'} isn’t a PNG, JPEG, GIF or WEBP image.`); continue; }
            if (f.size > MAX_IMAGE_BYTES) { toast.error(`${f.name || 'That image'} is over 4 MB.`); continue; }
            const dataUrl = await readAsDataUrl(f);
            count++;
            const size = await imageSize(dataUrl);
            setImages(prev => prev.length >= MAX_IMAGES ? prev : [...prev, { name: f.name || 'image.png', dataUrl, ...(size ? { size } : {}) }]);
        }
    };
    // A screenshot pasted anywhere on this page is attached, not only in the description.
    // The RCA's rich-text fields embed their own (they cancel the paste first), and the
    // page is skipped while its tab is hidden, since hidden tabs stay mounted.
    const rootRef = useRef<HTMLDivElement>(null);
    const addImagesRef = useRef(addImages);
    addImagesRef.current = addImages;
    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => {
            const root = rootRef.current;
            if (e.defaultPrevented || !e.clipboardData || !root || root.closest('[hidden]')) return;
            const files = imageFilesFrom(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void addImagesRef.current(files);
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
    }, []);
    const [history, setHistory] = useState<InvestigationHistoryEntry[]>(loadInvestigationHistory);
    const [currentId, setCurrentId] = useState<string | null>(null);

    // Settings load after first render; pick the first app once they arrive.
    useEffect(() => {
        if (!apps.some(a => a.name === selectedAppKey)) setSelectedAppKey(apps[0]?.name ?? '');
    }, [apps, selectedAppKey]);

    const i = state.interpretation;
    const app = apps.find(a => a.name === (i?.appKey ?? selectedAppKey));
    const appLabel = (a: AzureAppEntry | undefined) => a ? (a.platformName || a.resourceGroup || a.name) : '';
    const repoPath = repoOverride || repoFor(app, i?.target ?? 'app');
    const busy = state.status === 'interpreting' || state.status === 'running';

    // ── RCA, in App Health Check's business format ──────────────────────────
    // The investigation's window once interpreted, else the picked preset up to now.
    const rcaWindow = useMemo(() => {
        const endMs = i?.endMs ?? Date.now();
        return { startMs: i?.startMs ?? endMs - PRESET_MS[preset], endMs };
    }, [i?.startMs, i?.endMs, preset]);
    // Incident Period as App Health Check measures it: UptimeRobot downtime in the window.
    const { monitors: urMonitors } = useUptimeRobotMonitor(
        settings.apiKeys.uptimeRobotApiKey, app?.uptimeRobotMonitorIds,
        new Date(rcaWindow.startMs).toISOString(), new Date(rcaWindow.endMs).toISOString(),
    );
    const rcaPeriod = downtimePeriod(urMonitors.flatMap(m => (m.logs ?? []).filter(l => l.type === 1)
        .map(l => ({ start: l.datetime * 1000, end: (l.datetime + l.duration) * 1000 }))));

    const getPayload = useCallback(() => ({
        subscriptionId: settings.azure.subscriptionId,
        resourceGroup: app?.resourceGroup,
        appName: app?.name ?? '',
        appType: app?.type ?? 'appservice',
        appInsightsAppId: app?.appInsightsAppId,
        apiName: app?.apiName,
        apiInsightsAppId: app?.apiInsightsAppId,
        apiType: app?.apiType,
        dbName: app?.dbName,
        dbServerName: app?.dbServerName,
        logAnalyticsWorkspaceId: app?.logAnalyticsWorkspaceId,
        appGatewayResourceId: app?.appGatewayResourceId,
        frontDoorResourceId: app?.frontDoorResourceId,
        loadBalancerResourceId: app?.loadBalancerResourceId,
        startMs: rcaWindow.startMs,
        endMs: rcaWindow.endMs,
    }), [settings.azure.subscriptionId, app, rcaWindow]);
    const rca = useRcaReport({ appKey: app?.name ?? '', getPayload, fileSuffix: app?.incidentSuffix });
    // A report only fills blank fields, so the next incident starts on a fresh form once
    // one has been filled. Notes typed before anything filled it are kept.
    const [rcaFormKey, setRcaFormKey] = useState(0);
    const filledByReport = useRef(false);
    useEffect(() => { if (state.status === 'done') filledByReport.current = true; }, [state.status]);
    const freshRca = () => {
        if (filledByReport.current) setRcaFormKey(k => k + 1);
        filledByReport.current = false;
        rca.reset();
    };

    const doAsk = (q = query) => {
        const text = q.trim();
        if (!text || busy || !apps.length) return;
        setQuery(text);
        setRepoOverride('');
        setCurrentId(null);
        freshRca();
        const end = Date.now();
        void interpret({ query: text, config: settings.azure, selectedAppKey: selectedAppKey || null, fallbackWindow: { startMs: end - PRESET_MS[preset], endMs: end } });
    };

    const doRun = () => {
        if (!i || !repoPath) return;
        freshRca();
        setReportOpen(true);
        setTab('findings');
        void run({ config: settings.azure, repoPath, images });
    };

    // Save each finished run once, the moment it lands.
    useEffect(() => {
        if (state.status !== 'done' || !state.meta || !i || currentId) return;
        const id = newRunId();
        const { entries, error } = saveInvestigation({
            id, at: Date.now(), query: state.query, interpretation: i, report: state.report,
            meta: {
                repoRoot: state.meta.repoRoot, branch: state.meta.branch, head: state.meta.head,
                durationMs: state.meta.durationMs, warnings: state.meta.warnings,
            },
        });
        setCurrentId(id);
        setHistory(entries);
        if (error) toast.error(error);
    }, [state.status, state.meta, state.query, state.report, i, currentId, toast]);

    const onReportClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const el = (e.target as HTMLElement).closest('code[data-cite]');
        const cite = el && parseCitation(el.textContent ?? '');
        if (!cite || !state.meta) return;
        void window.electronAPI.appInvestigation.openCitation({ root: state.meta.repoRoot, ...cite }).then(r => {
            if (!r.success) toast.error(r.error ?? 'Could not open the file.');
        });
    };

    const pickRepo = async () => {
        const res = await window.electronAPI.appInvestigation.pickRepo();
        if (res.success && res.path) setRepoOverride(res.path);
        else if (!res.canceled && res.error) toast.error(res.error);
    };

    // One run writes both: the findings, then the RCA that fills the RCA and Tracker tabs.
    const parts = useMemo(() => splitInvestigationReport(state.report), [state.report]);
    const analysis: AnalysisState = state.status === 'running'
        ? { status: 'running', markdown: splitInvestigationReport(state.stream).findings, error: null }
        : state.status === 'done'
            ? { status: 'done', markdown: parts.findings, error: null }
            : { status: 'error', markdown: '', error: state.error };
    const showReport = state.status === 'running' || state.status === 'done' || (state.status === 'error' && !!i);


    if (!isElectron()) return <p className="text-sm text-muted-foreground">App Investigation runs in the desktop app only.</p>;
    if (!apps.length) {
        return (
            <p className="text-sm text-muted-foreground">
                Add an Azure app in <button className="underline" onClick={() => openSettings('azure')}>Settings → Azure</button> to investigate its incidents.
            </p>
        );
    }

    return (
        <div ref={rootRef} className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="flex min-w-0 flex-col gap-4">
                {/* ── 1. the question ─────────────────────────────────────── */}
                <Card>
                    <CardContent className="flex flex-col gap-3 p-4">
                        {/* One box, as in a chat composer: attached screenshots sit as chips
                            above the text. Drop files anywhere on it. */}
                        <div
                            className="flex flex-col rounded-md border bg-background focus-within:ring-1 focus-within:ring-ring"
                            onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
                            onDrop={e => {
                                const files = Array.from(e.dataTransfer.files);
                                if (files.length) { e.preventDefault(); void addImages(files); }
                            }}
                        >
                            {images.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                                    {images.map((img, n) => (
                                        <span key={n} className="flex max-w-[220px] items-center gap-1.5 rounded-md border bg-muted/40 py-0.5 pl-0.5 pr-1 text-xs">
                                            <img src={img.dataUrl} alt="" className="h-5 w-5 flex-shrink-0 rounded-sm object-cover" />
                                            <span className="truncate font-medium" title={img.name}>{img.name}</span>
                                            {img.size && <span className="flex-shrink-0 text-muted-foreground">{img.size}</span>}
                                            <button type="button" disabled={busy} aria-label={`Remove ${img.name}`}
                                                onClick={() => setImages(prev => prev.filter((_, k) => k !== n))}
                                                className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50">
                                                <X className="h-3 w-3" />
                                            </button>
                                        </span>
                                    ))}
                                </div>
                            )}
                            <textarea
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doAsk(); } }}
                                rows={3}
                                maxLength={2000}
                                placeholder="Describe the incident: which app, what went wrong, roughly when. e.g. “MEDU users got 500s around 2pm yesterday”. Paste or drop screenshots here."
                                aria-label="Incident description"
                                className="w-full resize-y bg-transparent p-3 text-sm focus-visible:outline-none"
                            />
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Hint label="Used when the description doesn’t name an app">
                                <div>
                                    <Select value={selectedAppKey} onValueChange={setSelectedAppKey}>
                                        <SelectTrigger className="h-8 w-[200px]" aria-label="Default app"><SelectValue placeholder="Pick an app" /></SelectTrigger>
                                        <SelectContent>{apps.map(a => <SelectItem key={a.name} value={a.name}>{appLabel(a)}</SelectItem>)}</SelectContent>
                                    </Select>
                                </div>
                            </Hint>
                            <Hint label="Window used when the description doesn’t say when">
                                <div>
                                    <Segmented value={preset} onChange={v => setPreset(v as RangePreset)}
                                        options={(['1h', '6h', '24h', '3d'] as const).map(p => ({ value: p, label: p }))} />
                                </div>
                            </Hint>
                            <Hint label={`Attach screenshots as evidence — an error page, a chart, an alert (up to ${MAX_IMAGES}, 4 MB each). You can also paste or drop them into the description.`}>
                                <Button variant="outline" size="sm" disabled={busy || images.length >= MAX_IMAGES} onClick={() => {
                                    const input = document.createElement('input');
                                    input.type = 'file';
                                    input.accept = IMAGE_TYPES.join(',');
                                    input.multiple = true;
                                    input.onchange = () => void addImages(Array.from(input.files ?? []));
                                    input.click();
                                }}>
                                    <ImagePlus /> Screenshot
                                </Button>
                            </Hint>
                            <div className="flex-1" />
                            <Button size="sm" onClick={() => doAsk()} disabled={!query.trim() || busy}>
                                {state.status === 'interpreting' ? <Loader2 className="animate-spin" /> : <Sparkles />} Understand
                            </Button>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {STARTERS.map(s => (
                                <button key={s} type="button" disabled={busy} onClick={() => setQuery(s)}
                                    className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50">
                                    {s}
                                </button>
                            ))}
                        </div>
                        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <ShieldAlert className="h-3 w-3" />
                            Read-only. Claude reads telemetry and source code and reports; it never changes the app, Azure or the repository. Ctrl+Enter
                        </p>
                    </CardContent>
                </Card>

                {state.status === 'interpreting' && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Claude is reading your description and checking it is in scope…
                    </div>
                )}

                {state.status === 'error' && !i && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{state.error}</div>
                )}

                {/* ── 2a. refused ─────────────────────────────────────────── */}
                {state.status === 'refused' && state.refusal && (
                    <div className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/5 p-4 text-sm" role="alert">
                        <div className="flex items-center gap-2 font-medium">
                            <ShieldAlert className="h-4 w-4 text-warning" />
                            {REFUSAL_TITLE[state.refusal.code] ?? 'Can’t investigate that'}
                        </div>
                        <p className="text-muted-foreground">{state.refusal.reason}</p>
                        <p className="text-xs text-muted-foreground">App Investigation answers questions like:</p>
                        <div className="flex flex-wrap gap-1.5">
                            {STARTERS.slice(0, 3).map(s => (
                                <button key={s} type="button" onClick={() => setQuery(s)}
                                    className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">{s}</button>
                            ))}
                        </div>
                    </div>
                )}

                {/* ── 2b. understood as — confirm before anything costly ─────── */}
                {i && state.status !== 'refused' && (
                    <UnderstoodCard
                        interpretation={i}
                        apps={apps}
                        config={settings.azure}
                        appLabel={appLabel}
                        repoPath={repoPath}
                        repoIsOverride={!!repoOverride}
                        locked={state.status === 'running' || state.status === 'done'}
                        onEdit={editInterpretation}
                        onBrowse={() => void pickRepo()}
                        onOpenSettings={() => openSettings('azure')}
                        onRun={doRun}
                        onEditAgain={backToConfirm}
                        running={state.status === 'running'}
                        done={state.status === 'done'}
                    />
                )}

                {/* ── 3. the report: Findings, RCA and Tracker tabs ───────── */}
                {app && (
                    <div className="-mx-6">
                        <AnalysisCard
                            tabs={
                                <Tabs value={tab} onValueChange={v => setTab(v as ReportTab)}>
                                    <TabsList>
                                        <TabsTrigger value="findings">Findings</TabsTrigger>
                                        <TabsTrigger value="rca">RCA</TabsTrigger>
                                        <TabsTrigger value="tracker">Tracker</TabsTrigger>
                                    </TabsList>
                                </Tabs>
                            }
                            showBody={tab === 'findings' && showReport}
                            state={analysis}
                            heading="Investigation report"
                            icon={<Search className="h-4 w-4 text-primary" />}
                            open={reportOpen}
                            onToggle={() => setReportOpen(o => !o)}
                            onRetry={doRun}
                            retryHint="Run the investigation again with the same settings"
                            runningLabel="Investigating…"
                            writingLabel="Writing the report…"
                            onCancel={() => void cancel()}
                            onReportClick={onReportClick}
                            footer={state.status === 'running'
                                ? <Trail items={state.trail} />
                                : state.status === 'done' && state.meta && (
                                    <ReportFooter
                                        meta={state.meta}
                                        onSave={() => void rca.exportMd('investigation', parts.findings)}
                                        onPdf={() => void rca.exportPdf('investigation', parts.findings)}
                                        onWord={() => void rca.exportWord('investigation', parts.findings)}
                                        onCopy={() => void rca.copyTeams(parts.findings)}
                                        onReset={() => { reset(); setCurrentId(null); freshRca(); setImages([]); }}
                                    />
                                )}
                        >
                    {tab === 'findings' && !showReport && (
                        <p className="text-muted-foreground">Run an investigation to see its findings here. The RCA and Tracker tabs can be filled in before a run.</p>
                    )}
                {/* RCA and Tracker, in App Health Check's format. Mounted throughout (hidden
                    on Findings, and while the card is collapsed) so edits survive; keyed per
                    app so another app's draft never carries over. A finished investigation's
                    RCA part fills the blank fields. */}
                    <div className={tab === 'findings' ? 'hidden' : '-mx-4'}>
                    <RcaSection
                        key={`${app.name}:${rcaFormKey}`}
                        view={tab === 'tracker' ? 'tracker' : 'rca'}
                        markdown={state.status === 'done' ? parts.rca : ''}
                        onDraftChange={rca.setDraft}
                        defaultTitle={`${appLabel(app)} Downtime`}
                        defaultServices={(app.platformUrls?.length ? app.platformUrls : [appLabel(app), app.apiName].filter(Boolean)).join(', ')}
                        period={rcaPeriod}
                        periodSource={rcaPeriod ? 'uptimerobot' : 'none'}
                        onExportPdf={() => void rca.exportPdf()}
                        onExportWord={() => void rca.exportWord()}
                        onCopyTeams={() => void rca.copyTeams()}
                    />
                    </div>
                        </AnalysisCard>
                    </div>
                )}
            </div>

            {/* ── history ─────────────────────────────────────────────────── */}
            <div className="flex min-w-0 flex-col gap-2">
                <h2 className="text-sm font-medium">Recent investigations</h2>
                {history.length === 0 && <p className="text-xs text-muted-foreground">Finished reports appear here.</p>}
                {history.map(h => (
                    <div key={h.id} className={`group flex items-start gap-2 rounded-md border p-2 text-xs ${h.id === currentId ? 'border-primary/60 bg-primary/5' : ''}`}>
                        <button type="button" disabled={busy} className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left disabled:opacity-50"
                            onClick={() => {
                                setQuery(h.query);
                                setCurrentId(h.id);
                                setRepoOverride('');
                                freshRca();
                                restore({ query: h.query, interpretation: h.interpretation, report: h.report, meta: metaOf(h) });
                            }}>
                            <span className="line-clamp-2 font-medium">{h.interpretation.question || h.query}</span>
                            <span className="text-muted-foreground">
                                {appLabel(apps.find(a => a.name === h.interpretation.appKey)) || h.interpretation.appKey} · {CATEGORY_LABEL[h.interpretation.category] ?? h.interpretation.category}
                            </span>
                            <span className="text-muted-foreground">{formatSgtRange(h.interpretation.startMs, h.interpretation.endMs)}</span>
                        </button>
                        <Hint label="Delete from history">
                            <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={() => setHistory(deleteInvestigation(h.id))}>
                                <Trash2 className="h-3 w-3" />
                            </Button>
                        </Hint>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ─── pieces ─────────────────────────────────────────────────────────────────

function UnderstoodCard({
    interpretation: i, apps, config, appLabel, repoPath, repoIsOverride, locked, running, done,
    onEdit, onBrowse, onOpenSettings, onRun, onEditAgain,
}: {
    interpretation: NonNullable<ReturnType<typeof useAppInvestigation>['state']['interpretation']>;
    apps: AzureAppEntry[];
    config: AzureSettings;
    appLabel: (a: AzureAppEntry | undefined) => string;
    repoPath: string;
    repoIsOverride: boolean;
    locked: boolean;
    running: boolean;
    done: boolean;
    onEdit: (patch: Partial<typeof i>) => void;
    onBrowse: () => void;
    onOpenSettings: () => void;
    onRun: () => void;
    onEditAgain: () => void;
}) {
    const app = apps.find(a => a.name === i.appKey);
    const windowInvalid = !(i.endMs > i.startMs);
    return (
        <Card>
            <CardContent className="flex flex-col gap-3 p-4 text-xs">
                <div className="flex items-center gap-2 text-sm font-medium">
                    <Check className="h-4 w-4 text-success" /> Understood as
                    {i.reason && <span className="truncate text-xs font-normal text-muted-foreground">— {i.reason}</span>}
                </div>
                <Input value={i.question} disabled={locked} maxLength={200} onChange={e => onEdit({ question: e.target.value })} aria-label="Investigation question" className="h-8 text-sm" />

                <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="App">
                        <Select value={i.appKey} disabled={locked} onValueChange={v => onEdit({ appKey: v, target: 'app' })}>
                            <SelectTrigger className="h-8" aria-label="App"><SelectValue /></SelectTrigger>
                            <SelectContent>{apps.map(a => <SelectItem key={a.name} value={a.name}>{appLabel(a)}</SelectItem>)}</SelectContent>
                        </Select>
                    </Field>
                    <Field label="Category">
                        <Select value={i.category} disabled={locked} onValueChange={v => onEdit({ category: v as InvestigationCategory })}>
                            <SelectTrigger className="h-8" aria-label="Category"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                {(Object.keys(CATEGORY_LABEL) as InvestigationCategory[]).map(c => <SelectItem key={c} value={c}>{CATEGORY_LABEL[c]}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field label={`Window (local time) · ${i.windowSource === 'query' ? 'from your description' : 'from the page'}`}>
                        <div className="flex items-center gap-1">
                            <Input type="datetime-local" disabled={locked} value={toDatetimeLocal(new Date(i.startMs))} aria-label="From" className="h-8 text-xs"
                                onChange={e => { const v = new Date(e.target.value).getTime(); if (Number.isFinite(v)) onEdit({ startMs: v, windowSource: 'page' }); }} />
                            <span className="text-muted-foreground">→</span>
                            <Input type="datetime-local" disabled={locked} value={toDatetimeLocal(new Date(i.endMs))} aria-label="To" className="h-8 text-xs"
                                onChange={e => { const v = new Date(e.target.value).getTime(); if (Number.isFinite(v)) onEdit({ endMs: v, windowSource: 'page' }); }} />
                        </div>
                        <span className={windowInvalid ? 'text-destructive' : 'text-muted-foreground'}>
                            {windowInvalid ? 'The end must be after the start.' : formatSgtRange(i.startMs, i.endMs)}
                        </span>
                    </Field>
                    {/* One repository for app and API: the choice changes nothing, so it is hidden. */}
                    {hasSeparateApiRepo(app) && (
                        <Field label="Code to read">
                            <Segmented value={i.target} onChange={v => onEdit({ target: v as 'app' | 'api' })}
                                options={[
                                    { value: 'app', label: 'App repository', disabled: locked },
                                    { value: 'api', label: 'API repository', disabled: locked || !app?.apiName, hint: 'No API configured for this app' },
                                ]} />
                        </Field>
                    )}
                </div>

                {!windowInvalid && <WindowReleases config={config} appKey={i.appKey} startMs={i.startMs} endMs={i.endMs} hasApi={!!app?.apiName} target={i.target} repoPath={repoPath} />}

                {i.symptoms.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground">Symptoms</span>
                        {i.symptoms.map(s => <span key={s} className="rounded-full bg-muted px-2 py-0.5">{s}</span>)}
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5">
                    <FolderGit2 className="h-3.5 w-3.5 text-muted-foreground" />
                    {repoPath
                        ? <span className="min-w-0 flex-1 truncate font-mono" title={repoPath}>{repoPath}{repoIsOverride && <span className="ml-1 font-sans text-muted-foreground">(this run only)</span>}</span>
                        : <span className="flex-1 text-warning">No {i.target === 'api' ? 'API' : 'app'} repository set for {appLabel(app)}.</span>}
                    {!locked && (
                        <>
                            <Hint label="Use a different folder for this run">
                                <Button variant="ghost" size="sm" className="h-6 px-2" onClick={onBrowse}><FolderOpen className="h-3 w-3" /> Browse</Button>
                            </Hint>
                            <Hint label="Save the repository for this app in Settings → Azure">
                                <Button variant="ghost" size="sm" className="h-6 px-2" onClick={onOpenSettings}><Settings2 className="h-3 w-3" /> Settings</Button>
                            </Hint>
                        </>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">Claude reads only: Azure telemetry for this window, git history, and the repository’s files.</span>
                    <div className="flex-1" />
                    {done
                        ? <Button size="sm" variant="outline" onClick={onEditAgain}><Wrench /> Adjust & re-run</Button>
                        : (
                            <Hint label={!repoPath ? 'Set a source repository first' : windowInvalid ? 'Fix the window first' : 'Pull telemetry and read the code — takes a few minutes'}>
                                <span>
                                    <Button size="sm" onClick={onRun} disabled={running || !repoPath || windowInvalid}>
                                        {running ? <Loader2 className="animate-spin" /> : <Search />} Investigate
                                    </Button>
                                </span>
                            </Hint>
                        )}
                </div>
            </CardContent>
        </Card>
    );
}

/** The last release live at the window's end (as App Health Check shows it), and whether one landed inside the window. */
function WindowReleases({ config, appKey, startMs, endMs, hasApi, target, repoPath }: {
    config: AzureSettings; appKey: string; startMs: number; endMs: number; hasApi: boolean; target: 'app' | 'api'; repoPath: string;
}) {
    const [rel, setRel] = useState<{ loading: boolean; fe: ReleaseResult | null; api: ReleaseResult | null }>({ loading: true, fe: null, api: null });
    useEffect(() => {
        let live = true;
        setRel(r => ({ ...r, loading: true }));
        // Debounced: the window inputs fire on every keystroke.
        const t = setTimeout(() => {
            window.electronAPI.azureMetrics.fetchReleases({
                appKey, range: 'custom', config, customStart: new Date(startMs).toISOString(), customEnd: new Date(endMs).toISOString(),
            })
                .then(r => { if (live) setRel({ loading: false, fe: r.fe ?? null, api: r.api ?? null }); })
                .catch(() => { if (live) setRel({ loading: false, fe: null, api: null }); });
        }, 400);
        return () => { live = false; clearTimeout(t); };
    }, [config, appKey, startMs, endMs]);

    const inWindow = [rel.fe, rel.api].flatMap(r => r?.events ?? []).filter(ev => {
        const at = Date.parse(ev.at);
        return at >= startMs && at <= endMs;
    }).length;
    // The release live at the window end on the site whose code is read.
    const live = (target === 'api' ? rel.api : rel.fe)?.events.filter(ev => Date.parse(ev.at) <= endMs).at(-1) ?? null;
    const sites = [
        { key: 'app', label: 'Frontend', r: rel.fe },
        ...(hasApi ? [{ key: 'api', label: 'API', r: rel.api }] : []),
    ];
    return (
        <section aria-label="Production at window end" className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Production at window end</span>
                {!rel.loading && inWindow > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                        <AlertTriangle className="h-3 w-3" />{inWindow} release{inWindow > 1 ? 's' : ''} inside this window
                    </span>
                )}
            </div>
            {rel.loading
                ? <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading releases…</span>
                : (
                    <>
                        {repoPath && <DeployedBranch repoPath={repoPath} endMs={endMs} commit={live?.commit} branch={live?.branch} />}
                        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                            {sites.map(s => (
                                <Fragment key={s.key}>
                                    <dt className={s.key === target ? 'font-medium text-foreground' : 'text-muted-foreground'}>{s.label}</dt>
                                    <dd className="min-w-0"><SiteRelease r={s.r} startMs={startMs} /></dd>
                                </Fragment>
                            ))}
                        </dl>
                    </>
                )}
        </section>
    );
}

/** How a release sits against the incident: "6 days before the window", "3h before the window", "inside the window". */
function relativeToWindow(atMs: number, startMs: number): string {
    if (atMs >= startMs) return 'inside the window';
    const h = (startMs - atMs) / 3_600_000;
    return h < 48 ? `${Math.max(1, Math.round(h))}h before the window` : `${Math.round(h / 24)} days before the window`;
}

/** One site's last release up to the window end: when, how long before the incident, how and who. */
function SiteRelease({ r, startMs }: { r: ReleaseResult | null; startMs: number }) {
    const last = r?.last;
    if (!last) return <span className="text-muted-foreground">{releaseStatus(r)?.text ?? 'unavailable'}</span>;
    const at = Date.parse(last.at);
    const detail = [relativeToWindow(at, startMs), SOURCE_LABEL[last.source], last.build && `build ${last.build}`, last.by].filter(Boolean);
    return (
        <span title={releaseTitle(last)}>
            <span className="font-medium text-foreground">{formatSgt(at)}</span>
            <span className={at >= startMs ? 'text-warning' : 'text-muted-foreground'}> · {detail.join(' · ')}</span>
        </span>
    );
}

const BASIS_TITLE = {
    'commit': 'The exact commit Azure recorded for the release live at the window end. The investigation reads this code.',
    'branch-at-end': 'Estimated: Azure recorded no matching commit, so this is the release branch as it stood at the window end (Azure\'s branch name first, else the one with the latest commit by then). The investigation reads this code.',
    'checked-out': 'No release branch found in the repository, so the checked-out branch is read. It may not match production.',
} as const;

/** "Release branch": the code the investigation treats as production at the window end. */
function DeployedBranch({ repoPath, endMs, commit, branch }: { repoPath: string; endMs: number; commit?: string | undefined; branch?: string | undefined }) {
    const [res, setRes] = useState<Awaited<ReturnType<typeof window.electronAPI.appInvestigation.deployedRef>> | null>(null);
    useEffect(() => {
        let live = true;
        setRes(null);
        window.electronAPI.appInvestigation.deployedRef({ repoPath, endMs, release: commit || branch ? { commit, branch } : null })
            .then(r => { if (live) setRes(r); })
            .catch(() => { if (live) setRes({ success: false }); });
        return () => { live = false; };
    }, [repoPath, endMs, commit, branch]);

    if (!res) return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Finding the release branch…</span>;
    if (!res.success || !res.branch) return null;
    const badge = res.basis && BASIS_BADGE[res.basis];
    return (
        <div className="flex flex-col gap-0.5" title={[res.basis && BASIS_TITLE[res.basis], res.note].filter(Boolean).join('\n')}>
            <div className="flex flex-wrap items-center gap-2">
                <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-mono text-sm font-semibold">{res.branch}</span>
                {res.sha && <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{res.sha}</span>}
                {badge && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>{badge.text}</span>}
            </div>
            <span className="pl-5 text-xs text-muted-foreground">
                The investigation reads this code{res.note && <span className="text-warning"> · {res.note}</span>}
            </span>
        </div>
    );
}

const BASIS_BADGE = {
    'commit': { text: 'Deployed commit', cls: 'bg-success/10 text-success' },
    'branch-at-end': { text: 'Estimated', cls: 'bg-warning/10 text-warning' },
    'checked-out': { text: 'Checked-out branch · may not match production', cls: 'bg-warning/10 text-warning' },
} as const;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

const PHASE_ICON: Record<InvestigationProgress['phase'], React.ComponentType<{ className?: string }>> = {
    repo: FolderGit2, azure: Cloud, git: GitCommitHorizontal, agent: Sparkles, init: Sparkles, tool: FileCode2, denied: X,
};

/** The live investigation trail: host stages, then every file Claude opens or searches. */
function Trail({ items }: { items: InvestigationProgress[] }) {
    if (!items.length) return null;
    const reads = items.filter(t => t.phase === 'tool').length;
    return (
        <div className="mt-3 flex flex-col gap-1 border-t pt-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Investigation trail{reads ? ` · ${reads} read${reads === 1 ? '' : 's'}` : ''}
            </div>
            <ol className="flex max-h-56 flex-col-reverse gap-0.5 overflow-auto font-mono text-[11px]">
                {[...items].reverse().map((t, idx) => {
                    const Icon = PHASE_ICON[t.phase] ?? FileCode2;
                    return (
                        <li key={items.length - idx} className={`flex items-center gap-1.5 ${t.phase === 'denied' ? 'text-destructive' : 'text-muted-foreground'}`}>
                            <Icon className="h-3 w-3 flex-shrink-0" />
                            {t.tool && <span className="text-foreground">{t.tool}</span>}
                            <span className="truncate">{t.detail}</span>
                        </li>
                    );
                })}
            </ol>
        </div>
    );
}

function ReportFooter({ meta, onSave, onPdf, onWord, onCopy, onReset }: {
    meta: NonNullable<ReturnType<typeof useAppInvestigation>['state']['meta']>;
    onSave: () => void; onPdf: () => void; onWord: () => void; onCopy: () => void; onReset: () => void;
}) {
    return (
        <div className="mt-4 flex flex-col gap-2 border-t pt-3">
            {meta.warnings.map(w => (
                <div key={w.code} className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/5 p-2 text-warning">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" /> {w.message}
                </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                <span className="font-mono" title={meta.repoRoot}>{meta.branch} @ {meta.head.split(' ')[0]}</span>
                {meta.durationMs != null && <span>· {Math.round(meta.durationMs / 1000)}s</span>}
                {(meta.tokens?.total ?? 0) > 0 && (
                    <Hint label={`Uses your Claude Code plan, not the API — no per-run charge.${meta.costUsd ? ` API-equivalent ≈ $${meta.costUsd.toFixed(2)}.` : ''}`}>
                        <span className="cursor-help underline decoration-dotted underline-offset-2">· Claude {meta.tokens!.total.toLocaleString()} tokens</span>
                    </Hint>
                )}
                {meta.deniedTools.length > 0 && <span>· {meta.deniedTools.length} blocked tool call(s)</span>}
                <div className="flex-1" />
                <Hint label="Save the report as markdown and copy it"><Button variant="ghost" size="sm" onClick={onSave}><FileText /> .md</Button></Hint>
                <Hint label="Save the report as PDF"><Button variant="ghost" size="sm" onClick={onPdf}><FileDown /> PDF</Button></Hint>
                <Hint label="Save the report as a Word document you can edit"><Button variant="ghost" size="sm" onClick={onWord}><FileType2 /> Word</Button></Hint>
                <Hint label="Copy the report, formatted for Teams"><Button variant="ghost" size="sm" onClick={onCopy}><Share2 /> Copy for Teams</Button></Hint>
                <Hint label="Start a new investigation"><Button variant="outline" size="sm" onClick={onReset}><BookOpen /> New</Button></Hint>
            </div>
            <p className="text-[11px] text-muted-foreground">Click a <code className="rounded bg-muted px-1">file:line</code> citation to open it in VS Code.</p>
        </div>
    );
}
