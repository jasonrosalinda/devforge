import { PageSpeedResults, type PageSpeedResultsHandle } from "@/components/pagespeed/pagespeed-result";
import { useCallback, useEffect, useRef, useState } from "react";
import PageSpeedConfig from "@/components/pagespeed/pagespeed-config";
import PageSpeedHistoryDropdown from "@/components/pagespeed/pagespeed-history-dropdown";
import { type PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
import type { AttributionResult, GitRefResolution } from "@shared/types/electron";
import { defaultPageSpeedConfiguration } from "@/lib/pageSpeedUtils";
import {
    loadHistory,
    saveSnapshot,
    deleteSnapshot,
    clearHistory,
    type PageSpeedHistorySnapshot,
    type StrategySnapshot,
    type SerializedAuditSlot,
    type SerializedTimes,
    type LegacyConfig,
    migrateConfig,
    slimForStorage,
} from "@/lib/pagespeed-history";
import { useSettings } from "@/context/settings-context";
import { useSettingsUi } from "@/context/settings-ui-context";
import { Button, Toast } from "@/components/ui";
import { Hint } from "@/components/ui/hint";
import { isNullOrEmpty } from "@shared/utils/stringHelper";
import { AlertTriangle, ChevronDown, Download, FileDown, Loader2, RotateCw, Save, Sparkles, Table as TableIcon, Upload, Wrench } from "lucide-react";
import { SiPagespeedinsights } from "react-icons/si";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { marked } from "marked";

type ResultsBundle = ReturnType<PageSpeedResultsHandle["getResults"]>;
type AuditSlot = ResultsBundle["results1"][number];
type MetricKey = "speedIndex" | "largestContentfulPaint" | "cumulativeLayoutShift" | "totalBlockingTime" | "firstContentfulPaint";

const serializeTimes = (t: { start: Date | null; end: Date | null }): SerializedTimes => ({
    start: t.start ? t.start.toISOString() : null,
    end: t.end ? t.end.toISOString() : null,
});

const toStrategySnapshot = (r: ResultsBundle): StrategySnapshot => ({
    // Drop `null` (loading) and coerce `undefined` to null for stable JSON round-tripping.
    // slimForStorage sheds the per-resource detail of runs nothing reads back, which is
    // what kept pushing snapshots past the localStorage quota.
    results1: r.results1.map(s => slimForStorage(s == null ? null : s)) as SerializedAuditSlot[],
    results2: r.results2.map(s => slimForStorage(s == null ? null : s)) as SerializedAuditSlot[],
    times1: serializeTimes(r.times1),
    times2: serializeTimes(r.times2),
    auditStart: r.auditStart ? r.auditStart.toISOString() : null,
    auditEnd: r.auditEnd ? r.auditEnd.toISOString() : null,
    analyses: r.analyses,
});

type AnalysisState = { status: 'running' | 'done' | 'error'; markdown: string; error: string | null };

// What to call a compared side: the branch or tag it resolved to ("release/v3.14.1"),
// falling back to the label the user typed, then to the commit as a last resort.
const refName = (r: GitRefResolution | undefined, fallback: string): string =>
    r?.ref ?? r?.label ?? (r?.short ? r.short : fallback);

// Shared shell for both assessments: the quick Desktop+Mobile read and the repository
// investigation. Same four states, same streaming pane — only the labels differ.
function AnalysisCard({
    state, heading, icon, open, onToggle, onRetry, retryHint, runningLabel, writingLabel, progress, onCancel, footer,
}: {
    state: AnalysisState;
    heading: string;
    icon: React.ReactNode;
    open: boolean;
    onToggle: () => void;
    onRetry: () => void;
    retryHint: string;
    runningLabel: string;
    writingLabel: string;
    progress?: string | undefined;
    onCancel?: (() => void) | undefined;
    footer?: React.ReactNode;
}) {
    return (
        <Card className="my-4 mx-6 shadow-none">
            <CardHeader>
                <CardTitle>
                    <Hint label={open ? 'Collapse the analysis' : 'Expand the analysis'} className="w-full">
                        <button
                            onClick={onToggle}
                            className="flex w-full items-center gap-2 text-sm text-left hover:opacity-80 transition-opacity"
                        >
                            {icon}
                            {heading}
                            <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                        </button>
                    </Hint>
                </CardTitle>
            </CardHeader>
            {open && (
                <CardContent className="text-xs">
                    {state.status === 'running' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                {state.markdown ? writingLabel : runningLabel}
                                {onCancel && (
                                    <Hint label="Stop the investigation">
                                        <Button variant="ghost" size="sm" className="ml-auto h-6 px-2" onClick={onCancel}>Cancel</Button>
                                    </Hint>
                                )}
                            </div>
                            {/* Tool activity, kept out of the report text so the finished
                                answer isn't interleaved with investigation noise. */}
                            {progress && (
                                <div className="truncate font-mono text-[11px] text-muted-foreground/80">{progress}</div>
                            )}
                            {state.markdown && (
                                <pre className="whitespace-pre-wrap border-t border-border pt-2 font-mono text-[11px] leading-relaxed text-foreground/80">{state.markdown}</pre>
                            )}
                        </div>
                    )}
                    {state.status === 'error' && (
                        <div className="flex flex-col items-start gap-2">
                            <div className="flex items-center gap-2 text-destructive">
                                <AlertTriangle className="h-4 w-4" />
                                <span>{state.error || 'Something went wrong.'}</span>
                            </div>
                            <Hint label={retryHint}>
                                <Button variant="outline" size="sm" onClick={onRetry}>
                                    <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
                                </Button>
                            </Hint>
                        </div>
                    )}
                    {state.status === 'done' && (
                        <div className="ps-analysis-content" dangerouslySetInnerHTML={{ __html: marked.parse(state.markdown, { async: false }) as string }} />
                    )}
                    {footer}
                </CardContent>
            )}
        </Card>
    );
}

export default function PageSpeedResultPage() {
    const { settings, loading: settingsLoading } = useSettings();
    const { openSettings } = useSettingsUi();
    const apiKey = settings.apiKeys.pagespeedApiKey;
    const [desktopConfig, setDesktopConfig] = useState(() => ({ ...defaultPageSpeedConfiguration('desktop'), apiKey }));
    const [mobileConfig, setMobileConfig] = useState(() => ({ ...defaultPageSpeedConfiguration('mobile'), apiKey }));
    // Settings load asynchronously, so the key is empty on first render -- re-inject it once it arrives,
    // otherwise the configs keep a blank key and the Analyze buttons never show.
    useEffect(() => {
        setDesktopConfig(c => (c.apiKey === apiKey ? c : { ...c, apiKey }));
        setMobileConfig(c => (c.apiKey === apiKey ? c : { ...c, apiKey }));
    }, [apiKey]);

    const onConfigChanged = (config: PageSpeedConfiguration) => {
        setDesktopConfig({ ...config, strategy: 'desktop', apiKey });
        setMobileConfig({ ...config, strategy: 'mobile', apiKey });
    };

    const [desktopAuditing, setDesktopAuditing] = useState(false);
    const [mobileAuditing, setMobileAuditing] = useState(false);
    const isAuditing = desktopAuditing || mobileAuditing;

    const [exportingInsights, setExportingInsights] = useState(false);

    const toast = Toast();
    const [history, setHistory] = useState<PageSpeedHistorySnapshot[]>(() => loadHistory());
    const [restoredConfig, setRestoredConfig] = useState<PageSpeedConfiguration | undefined>(undefined);
    const [restoreToken, setRestoreToken] = useState(0);

    const desktopRef = useRef<PageSpeedResultsHandle>(null);
    const mobileRef = useRef<PageSpeedResultsHandle>(null);
    const importInputRef = useRef<HTMLInputElement>(null);

    const analyzeAll = () => {
        desktopRef.current?.startAudit();
        mobileRef.current?.startAudit();
    };

    // Bumped by children whenever their results change, so hasResults (read from refs)
    // is re-evaluated — refs alone don't trigger a parent re-render.
    const [, setResultsTick] = useState(0);
    const onResultsChange = useCallback(() => setResultsTick(t => t + 1), []);

    // Page-level Claude analysis covering Desktop + Mobile together.
    const [pageAnalysis, setPageAnalysis] = useState<{ status: 'running' | 'done' | 'error'; markdown: string; error: string | null } | null>(null);
    const [pageAnalysisOpen, setPageAnalysisOpen] = useState(true);

    const runPageAnalysis = async () => {
        const summary = combinedSummary();
        if (!summary) {
            toast.warning('Run Desktop and/or Mobile audits first');
            return;
        }

        setPageAnalysis({ status: 'running', markdown: '', error: null });
        setPageAnalysisOpen(true);
        const unsubscribe = window.electronAPI.pagespeedInsight.onAnalyzeChunk(({ chunk }) => {
            setPageAnalysis(prev => (prev && prev.status === 'running') ? { ...prev, markdown: prev.markdown + chunk } : prev);
        });
        try {
            const res = await window.electronAPI.pagespeedInsight.analyze({ url: 'Desktop + Mobile', summary });
            setPageAnalysis(res.success
                ? { status: 'done', markdown: res.analysis ?? '', error: null }
                : { status: 'error', markdown: '', error: res.error ?? 'Analysis failed.' });
        } catch (err) {
            setPageAnalysis({ status: 'error', markdown: '', error: err instanceof Error ? err.message : String(err) });
        } finally {
            unsubscribe();
        }
    };

    // Full Assessment — the same data, investigated inside the site's own repository.
    // The repo is located by hand on every run and never stored: not in the config,
    // not in history, not in an export.
    const [deepDive, setDeepDive] = useState<AnalysisState | null>(null);
    const [deepDiveOpen, setDeepDiveOpen] = useState(true);
    const [deepDiveProgress, setDeepDiveProgress] = useState('');
    const [deepDiveMeta, setDeepDiveMeta] = useState<AttributionResult['meta'] | null>(null);

    const combinedSummary = (): string => {
        const d = desktopRef.current?.getAnalysisSummary() ?? '';
        const m = mobileRef.current?.getAnalysisSummary() ?? '';
        if (!d && !m) return '';
        return [
            'Combined Desktop + Mobile PageSpeed results. Cover BOTH strategies and call out where they diverge (e.g. mobile regresses while desktop improves).',
            d ? `# DESKTOP\n\n${d}` : '',
            m ? `# MOBILE\n\n${m}` : '',
        ].filter(Boolean).join('\n\n====\n\n');
    };

    const runFullAssessment = async () => {
        const summary = combinedSummary();
        if (!summary) {
            toast.warning('Run Desktop and/or Mobile audits first');
            return;
        }

        const pick = await window.electronAPI.pagespeedInsight.pickRepo();
        if (!pick.success) {
            if (!pick.canceled) toast.error(pick.error ?? 'Could not open the folder picker.');
            return;
        }
        const repoPath = pick.path!;

        const check = await window.electronAPI.pagespeedInsight.validateRepo({
            repoPath,
            beforeLabel: desktopConfig.beforeLabel,
            afterLabel: desktopConfig.afterLabel,
        });
        if (!check.success) {
            toast.error(check.error ?? 'That folder is not a git repository.');
            return;
        }
        // Unresolved labels are recoverable: offer the closest tags rather than failing.
        const unresolved = [check.before, check.after].filter(r => r && !r.resolved);
        if (unresolved.length) {
            const names = unresolved.map(r => `"${r!.label}"`).join(' and ');
            const hints = unresolved[0]?.candidates?.slice(0, 5).join(', ');
            toast.error(
                `${names} did not resolve to a commit in ${check.root}.`
                + (hints ? ` Closest tags: ${hints}. Rename the Before/After labels to match, then run again.` : ''),
            );
            return;
        }
        for (const w of check.warnings ?? []) toast.warning(w.message);

        setDeepDive({ status: 'running', markdown: '', error: null });
        setDeepDiveOpen(true);
        setDeepDiveProgress('');
        setDeepDiveMeta(null);

        const offChunk = window.electronAPI.pagespeedInsight.onAttributionChunk(({ chunk }) => {
            setDeepDive(prev => (prev && prev.status === 'running') ? { ...prev, markdown: prev.markdown + chunk } : prev);
        });
        const offProgress = window.electronAPI.pagespeedInsight.onAttributionProgress((p) => {
            setDeepDiveProgress(p.tool ? `${p.tool}: ${p.detail ?? ''}` : (p.detail ?? ''));
        });
        try {
            const res = await window.electronAPI.pagespeedInsight.analyzeAttribution({
                repoPath,
                summary,
                urls: desktopConfig.urls,
                beforeLabel: desktopConfig.beforeLabel,
                afterLabel: desktopConfig.afterLabel,
            });
            if (res.success) {
                setDeepDive({ status: 'done', markdown: res.analysis ?? '', error: null });
                setDeepDiveMeta(res.meta ?? null);
            } else {
                setDeepDive({ status: 'error', markdown: '', error: res.error ?? 'The investigation failed.' });
            }
        } catch (err) {
            setDeepDive({ status: 'error', markdown: '', error: err instanceof Error ? err.message : String(err) });
        } finally {
            offChunk();
            offProgress();
            setDeepDiveProgress('');
        }
    };

    const slotHasAny = (ref: React.RefObject<PageSpeedResultsHandle | null>): boolean => {
        const r = ref.current?.getResults();
        if (!r) return false;
        return r.results1.some(Boolean) || r.results2.some(Boolean);
    };
    const hasResults = slotHasAny(desktopRef) || slotHasAny(mobileRef);

    const buildSnapshot = (): PageSpeedHistorySnapshot | null => {
        const desktop = desktopRef.current?.getResults();
        const mobile = mobileRef.current?.getResults();
        if (!desktop || !mobile) return null;
        return {
            id: String(Date.now()),
            savedAt: new Date().toISOString(),
            // Strip apiKey — never persist secrets; re-injected from settings on restore.
            config: { ...desktopConfig, apiKey: '' },
            desktop: toStrategySnapshot(desktop),
            mobile: toStrategySnapshot(mobile),
            pageAnalysis: pageAnalysis?.status === 'done' && pageAnalysis.markdown
                ? { markdown: pageAnalysis.markdown }
                : null,
            // Ref names only — the repo path stays out of history and out of exports.
            pageDeepDive: deepDive?.status === 'done' && deepDive.markdown
                ? {
                    markdown: deepDive.markdown,
                    beforeRef: refName(deepDiveMeta?.before, desktopConfig.beforeLabel),
                    afterRef: refName(deepDiveMeta?.after, desktopConfig.afterLabel),
                }
                : null,
        };
    };

    const saveToHistory = () => {
        const snapshot = buildSnapshot();
        if (!snapshot) return;
        const { entries, error } = saveSnapshot(snapshot);
        setHistory(entries);
        if (error) toast.error(error);
        else toast.success('Analysis saved to history');
    };

    // Export/import use the same snapshot shape as history, so a .json file round-trips
    // through the restore path and is interchangeable with a saved history entry.
    const exportResults = () => {
        const snapshot = buildSnapshot();
        if (!snapshot) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const href = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = href;
        a.download = `pagespeed-${stamp}.json`;
        a.click();
        URL.revokeObjectURL(href);
        toast.success('Results exported');
    };

    // A prompt file for an AI coding agent run inside the audited repo: the agent has the
    // codebase but not the measurements, so the brief carries the raw before/after data,
    // the run setup needed to read it, and an explicit task - find what regressed, find
    // what to improve, then fix it.
    const buildFixBrief = (): string => {
        const desktop = desktopRef.current?.getAnalysisSummary() ?? '';
        const mobile = mobileRef.current?.getAnalysisSummary() ?? '';
        const cfg = desktopConfig;
        const assessment = pageAnalysis?.status === 'done' ? pageAnalysis.markdown.trim() : '';
        const shown = ([
            [cfg.showSI, 'SI (Speed Index)'],
            [cfg.showLCP, 'LCP (Largest Contentful Paint)'],
            [cfg.showCLS, 'CLS (Cumulative Layout Shift)'],
            [cfg.showTBT, 'TBT (Total Blocking Time)'],
            [cfg.showFCP, 'FCP (First Contentful Paint)'],
        ] as const).filter(([on]) => on).map(([, label]) => label);

        return [
            '# PageSpeed Fix Brief — Desktop + Mobile',
            '',
            `> Generated by devForge PageSpeed on ${new Date().toLocaleString()}.`,
            '> Hand this file to an AI coding agent (e.g. Claude Code) **run inside the repository that serves these URLs**.',
            '> It has the code; this file has the measurements.',
            '',
            '## Your Task',
            '1. Read the Run Setup, then the assessment (if present) and the raw data for both strategies.',
            '2. **What is degrading the score** — for every metric that got worse, or that is failing outright,',
            '   find the code in THIS repository responsible for it: components, bundles, images, fonts,',
            '   third-party scripts, build config, cache/compression headers, render-blocking assets.',
            '   Name the file and the mechanism, not just the symptom.',
            '3. **What to enhance** — list the changes that would move these metrics most, cheapest first.',
            '4. Rank everything by (metric impact x confidence) / effort. Desktop and mobile often differ —',
            '   say which strategy each fix helps, and flag anything that helps one and hurts the other.',
            '5. Implement the top items. Keep each change scoped; do not alter unrelated behaviour.',
            '6. For each change, report: file(s) touched, what was wrong, what you did, and the metric you',
            '   expect to move and roughly by how much.',
            '',
            '## How to read the data',
            '- SI, LCP, TBT, FCP: milliseconds/seconds — **lower is better**.',
            '- CLS: unitless layout-shift score — **lower is better** (Google\'s threshold is 0.1).',
            `- A metric is treated as a regression here past **${cfg.improvementThreshold}%** worse.`,
            '- Sections headed "Cross-run identical values" mark measurements that appear in BOTH the before',
            '  and after run sets. Those are measurement noise (network jitter, CDN/cache state), not code',
            '  changes — do not chase them, and discount any apparent win or loss that overlaps them.',
            '- "opportunities" come from Lighthouse and are ranked estimates, not instructions. Verify each',
            '  against the actual code before acting on it.',
            '- Sections headed "Evidence diff" compare the two runs audit by audit and file by file: which',
            '  audits appeared, worsened or were resolved, and which resources were added, removed or grew.',
            '  Start there — a file listed as new or heavier is the shortest path from a metric to a commit.',
            '  Resource names are fingerprint-normalized (`theme.9f2ab1.css` → `theme.css`), so a row marked',
            '  "new" is a genuinely new file rather than a rebuilt one.',
            '',
            '## Run Setup',
            `- Strategies: Desktop and Mobile (same URLs, same run count)`,
            `- URLs (${cfg.urls.length}):`,
            ...cfg.urls.map(u => `  - ${u}`),
            `- Runs per URL: ${cfg.runs}${cfg.runs > 1 ? ` — collapsed by **${cfg.aggregation}**` : ''}`,
            `- Mode: ${cfg.comparisonMode ? `comparison — "${cfg.beforeLabel}" vs "${cfg.afterLabel}"` : 'single snapshot (no before/after to compare)'}`,
            `- Metrics captured: ${shown.length ? shown.join(', ') : 'none selected'}`,
            '',
            '## Assessment',
            assessment || '_No assessment was generated — work from the raw data below._',
            '',
            '## DESKTOP — raw data & insights',
            '```',
            desktop.trim() || 'No desktop results.',
            '```',
            '',
            '## MOBILE — raw data & insights',
            '```',
            mobile.trim() || 'No mobile results.',
            '```',
        ].join('\n');
    };

    const createFixBrief = () => {
        if (!hasResults) {
            toast.warning('Run Desktop and/or Mobile audits first');
            return;
        }
        const p = window.electronAPI.pagespeedInsight.saveBrief({ markdown: buildFixBrief() }).then(res => {
            if (res.canceled) return 'No folder selected';
            if (!res.success) throw new Error(res.error || 'Save failed');
            return 'Fix brief saved to project folder';
        });
        toast.promise(p, {
            loading: 'Creating fix brief…',
            success: (m: string) => m,
            error: (e: unknown) => (e instanceof Error ? e.message : 'Save failed'),
        });
    };

    // An imported file is untrusted input, and restoreSnapshot assumes a snapshot this app
    // wrote itself (it reads times/analyses unguarded) — so validate and fill before handing over.
    const parseSnapshotFile = (raw: unknown): PageSpeedHistorySnapshot => {
        const invalid = () => new Error('Not a devForge PageSpeed export.');
        if (!raw || typeof raw !== 'object') throw invalid();
        const s = raw as Partial<PageSpeedHistorySnapshot>;
        if (!s.config || !Array.isArray(s.config.urls)) throw invalid();

        const strategy = (v: unknown): StrategySnapshot => {
            const t = (v ?? {}) as Partial<StrategySnapshot>;
            if (!Array.isArray(t.results1) || !Array.isArray(t.results2)) throw invalid();
            const times = (x: SerializedTimes | undefined): SerializedTimes => ({ start: x?.start ?? null, end: x?.end ?? null });
            return {
                results1: t.results1,
                results2: t.results2,
                times1: times(t.times1),
                times2: times(t.times2),
                auditStart: t.auditStart ?? null,
                auditEnd: t.auditEnd ?? null,
                analyses: t.analyses ?? {},
            };
        };

        return {
            id: s.id ?? String(Date.now()),
            savedAt: s.savedAt ?? new Date().toISOString(),
            config: migrateConfig(s.config as LegacyConfig),
            desktop: strategy(s.desktop),
            mobile: strategy(s.mobile),
            pageAnalysis: s.pageAnalysis ?? null,
            pageDeepDive: s.pageDeepDive ?? null,
        };
    };

    const onImportClick = () => importInputRef.current?.click();

    const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // let the same file be picked again after a failed import
        if (!file) return;
        const reader = new FileReader();
        reader.onload = event => {
            try {
                restoreFromHistory(parseSnapshotFile(JSON.parse(String(event.target?.result ?? ''))));
            } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Import failed');
            }
        };
        reader.onerror = () => toast.error('Could not read that file');
        reader.readAsText(file);
    };

    const restoreFromHistory = (snapshot: PageSpeedHistorySnapshot) => {
        setDesktopConfig({ ...snapshot.config, strategy: 'desktop', apiKey });
        setMobileConfig({ ...snapshot.config, strategy: 'mobile', apiKey });
        setRestoredConfig({ ...snapshot.config, apiKey });
        setRestoreToken(t => t + 1);
        desktopRef.current?.restoreSnapshot(snapshot.desktop);
        mobileRef.current?.restoreSnapshot(snapshot.mobile);
        setPageAnalysis(snapshot.pageAnalysis?.markdown
            ? { status: 'done', markdown: snapshot.pageAnalysis.markdown, error: null }
            : null);
        setDeepDive(snapshot.pageDeepDive?.markdown
            ? { status: 'done', markdown: snapshot.pageDeepDive.markdown, error: null }
            : null);
        // The repo path was never saved, so a restored report keeps its refs for the
        // heading but a re-run means locating the folder again.
        setDeepDiveMeta(snapshot.pageDeepDive
            ? {
                before: { label: snapshot.pageDeepDive.beforeRef, ref: snapshot.pageDeepDive.beforeRef, resolved: true },
                after: { label: snapshot.pageDeepDive.afterRef, ref: snapshot.pageDeepDive.afterRef, resolved: true },
            }
            : null);
        toast.info('Restored analysis from ' + new Date(snapshot.savedAt).toLocaleString());
    };

    const onDeleteHistory = (id: string) => setHistory(deleteSnapshot(id));
    const onClearHistory = () => { clearHistory(); setHistory([]); };

    // Excel-style Desktop+Mobile comparison table: individual runs as rows, then an
    // averaged row, then a %-improvement row per metric pair — mirrors a pasted Excel sheet.
    const copyAsExcelTable = () => {
        const desktop = desktopRef.current?.getResults();
        const mobile = mobileRef.current?.getResults();
        if (!desktop || !mobile) return;
        if (!desktop.results1.some(Boolean) && !mobile.results1.some(Boolean)) {
            toast.warning('Run Desktop and/or Mobile audits first');
            return;
        }

        const metricDefs = ([
            { show: desktopConfig.showSI,  label: 'SI',  key: 'speedIndex' as MetricKey },
            { show: desktopConfig.showLCP, label: 'LCP', key: 'largestContentfulPaint' as MetricKey },
            { show: desktopConfig.showCLS, label: 'CLS', key: 'cumulativeLayoutShift' as MetricKey },
            { show: desktopConfig.showTBT, label: 'TBT', key: 'totalBlockingTime' as MetricKey },
            { show: desktopConfig.showFCP, label: 'FCP', key: 'firstContentfulPaint' as MetricKey },
        ]).filter(m => m.show);

        const strategies: { label: string; bundle: ResultsBundle }[] = [
            { label: 'DESKTOP', bundle: desktop },
            { label: 'MOBILE', bundle: mobile },
        ];
        const comparisonMode = desktopConfig.comparisonMode;
        const beforeLabel = desktopConfig.beforeLabel || 'Before';
        const afterLabel = desktopConfig.afterLabel || 'After';
        const colsPerMetric = comparisonMode ? 2 : 1;
        const colsPerStrategy = metricDefs.length * colsPerMetric;

        // The legacy align attribute rides along with the CSS: Teams and Word drop
        // `text-align` on a cell in some paste paths, and a colspan'd cell is where that
        // shows up first - the value ends up hugging the left edge of a double-width cell.
        const th = (v: string, colSpan = 1, rowSpan = 1, extra = '') =>
            `<th colspan="${colSpan}" rowspan="${rowSpan}" align="center" style="background:#f1f1f1;text-align:center;padding:1px 2px;border:1px solid #999;font-size:10px${extra}">${v}</th>`;
        const td = (v: string, extra = '') =>
            `<td align="center" style="text-align:center;padding:1px 2px;border:1px solid #999;font-size:10px${extra}">${v}</td>`;

        // Keep the whole Desktop+Mobile table inside one screenful: fixed layout + a colgroup
        // so the URL column can't stretch to its longest URL (auto layout ignores a width hint
        // once the table overflows), and the metric columns stay just wide enough for a value.
        const URL_W = 50;
        const COL_W = 38;
        const totalDataCols = strategies.length * colsPerStrategy;
        const colgroup = `<colgroup><col style="width:${URL_W}px" />${`<col style="width:${COL_W}px" />`.repeat(totalDataCols)}</colgroup>`;
        const tableWidth = URL_W + totalDataCols * COL_W;

        // Name the statistic in the header when there is one - a single run has nothing to
        // aggregate, so "PAGESPEED" alone is honest there.
        const aggLabel = desktopConfig.runs > 1
            ? ` (${desktopConfig.aggregation === 'median' ? 'Median' : 'Average'})`
            : '';

        const headerRows =
            `<tr>${th('URL', 1, 4, ';background:#fff')}${th(`PAGESPEED${aggLabel}`, strategies.length * colsPerStrategy)}</tr>` +
            `<tr>${strategies.map(s => th(s.label, colsPerStrategy)).join('')}</tr>` +
            `<tr>${strategies.map(() => metricDefs.map(m => th(m.label, colsPerMetric)).join('')).join('')}</tr>` +
            (comparisonMode
                ? `<tr>${strategies.map(() => metricDefs.map(() => th(beforeLabel) + th(afterLabel)).join('')).join('')}</tr>`
                : '');

        const cellText = (slot: AuditSlot, key: MetricKey): string => (slot ? slot[key]?.displayValue ?? '-' : '-');
        const cellNum = (slot: AuditSlot, key: MetricKey): number => {
            if (!slot) return 0;
            const n = parseFloat(String(slot[key]?.displayValue ?? '').replace(/,/g, ''));
            return Number.isFinite(n) ? n : (slot[key]?.numericValue ?? 0);
        };

        const bodyRows: string[] = [];
        desktopConfig.urls.forEach((url, i) => {
            const slots = strategies.map(s => ({ before: s.bundle.results1[i], after: s.bundle.results2[i] }));
            const numRuns = Math.max(0, ...slots.flatMap(s => [s.before, s.after]).map(s => (s && s.runHistory?.length) || 0));
            const rowCount = (numRuns > 0 ? numRuns + 1 : 1) + (comparisonMode ? 1 : 0);

            let urlCellEmitted = false;
            const urlCell = () => {
                if (urlCellEmitted) return '';
                urlCellEmitted = true;
                return `<td rowspan="${rowCount}" align="left" style="text-align:left;padding:1px 3px;border:1px solid #999;font-size:10px;vertical-align:top;line-height:1.2;word-break:break-all;overflow-wrap:anywhere">${url}</td>`;
            };

            // Values appearing in BOTH before and after run sets for a metric (any run index)
            // get highlighted — same jitter-spotting rule as the per-strategy Copy for Teams.
            const matchedByStrategy = slots.map(s => {
                const map = new Map<MetricKey, Set<string>>();
                if (!comparisonMode) return map;
                const h1 = (s.before ? s.before.runHistory : undefined) ?? [];
                const h2 = (s.after ? s.after.runHistory : undefined) ?? [];
                if (!h1.length || !h2.length) return map;
                for (const m of metricDefs) {
                    const set1 = new Set(h1.map(run => run[m.key]?.displayValue).filter(Boolean) as string[]);
                    const matches = new Set((h2.map(run => run[m.key]?.displayValue).filter(Boolean) as string[]).filter(v => set1.has(v)));
                    if (matches.size) map.set(m.key, matches);
                }
                return map;
            });
            const HL = ';background:#fff3cd;color:#92400e;font-weight:600;font-style:italic';

            for (let r = 0; r < numRuns; r++) {
                const rowHtml = slots.map((s, si) => metricDefs.map(m => {
                    const beforeRun = s.before ? s.before.runHistory?.[r] : undefined;
                    const afterRun = s.after ? s.after.runHistory?.[r] : undefined;
                    if (!comparisonMode) return td(cellText(beforeRun, m.key));
                    const hl = (v: string) => (v !== '-' && matchedByStrategy[si]?.get(m.key)?.has(v)) ? HL : '';
                    const bv = cellText(beforeRun, m.key);
                    const av = cellText(afterRun, m.key);
                    return td(bv, hl(bv)) + td(av, hl(av));
                }).join('')).join('');
                bodyRows.push(`<tr>${urlCell()}${rowHtml}</tr>`);
            }

            const avgRowHtml = slots.map(s => metricDefs.map(m => {
                if (!comparisonMode) return td(cellText(s.before, m.key), ';background:#f2f2f2');
                return td(cellText(s.before, m.key), ';background:#f2f2f2') + td(cellText(s.after, m.key), ';background:#f2f2f2');
            }).join('')).join('');
            bodyRows.push(`<tr>${urlCell()}${avgRowHtml}</tr>`);

            if (comparisonMode) {
                const pctRowHtml = slots.map(s => metricDefs.map(m => {
                    const b = cellNum(s.before, m.key);
                    const a = cellNum(s.after, m.key);
                    if (!b || !a) return `<td colspan="2" align="center" style="text-align:center;padding:1px 2px;border:1px solid #999;font-size:10px;color:#999">-</td>`;
                    const pct = ((b - a) / b) * 100;
                    const text = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
                    const color = pct >= 0 ? '#16a34a' : (Math.abs(pct) > desktopConfig.improvementThreshold ? '#dc2626' : '#ea580c');
                    return `<td colspan="2" align="center" style="text-align:center;padding:1px 2px;border:1px solid #999;font-size:10px;color:${color};font-weight:600">${text}</td>`;
                }).join('')).join('');
                bodyRows.push(`<tr>${urlCell()}${pctRowHtml}</tr>`);
            }
        });

        const analysisMd = pageAnalysis?.status === 'done' ? pageAnalysis.markdown : '';
        const analysisHtml = analysisMd ? `<br/>${marked.parse(analysisMd, { async: false }) as string}` : '';
        const html = `<table style="border-collapse:collapse;table-layout:fixed;width:${tableWidth}px;font-family:Segoe UI,Arial,sans-serif">${colgroup}${headerRows}${bodyRows.join('')}</table>${analysisHtml}`;

        const plain = desktopConfig.urls.map((url, i) => {
            const parts = strategies.map(s => {
                const before = s.bundle.results1[i];
                const after = s.bundle.results2[i];
                const metrics = metricDefs.map(m => comparisonMode
                    ? `${m.label} ${cellText(before, m.key)} → ${cellText(after, m.key)}`
                    : `${m.label} ${cellText(before, m.key)}`).join(', ');
                return `${s.label}: ${metrics}`;
            }).join(' | ');
            return `${url}: ${parts}`;
        }).join('\n') + (analysisMd ? `\n\n${analysisMd}` : '');

        const copy = navigator.clipboard.write([
            new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([plain], { type: 'text/plain' }),
            }),
        ]);
        toast.promise(copy, { loading: 'Copying…', success: 'Copied table', error: 'Copy failed' });
    };

    const exportInsights = async () => {
        setExportingInsights(true);
        try {
            const desktop = desktopRef.current?.getResults();
            const mobile = mobileRef.current?.getResults();
            await window.electronAPI.pagespeedInsight.generate({ desktop, mobile });
        } finally {
            setExportingInsights(false);
        }
    };

    return (
        <>
            <PageHeader
                icon={SiPagespeedinsights}
                title="PageSpeed"
                subtitle="Run Lighthouse / PageSpeed Insights audits across desktop and mobile — 1-10 runs per URL, averaged or median, with optional branch comparison."
            />
            {!settingsLoading && isNullOrEmpty(apiKey) && (
                <div className="mb-4 flex items-start gap-2 rounded-md border border-warning/35 bg-warning/10 px-4 py-3 text-sm text-foreground">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <span>
                        No PageSpeed API key set - Analyze buttons stay hidden until one is added under{' '}
                        <button
                            type="button"
                            onClick={() => openSettings('apikeys')}
                            className="font-medium text-info underline underline-offset-2 hover:opacity-80"
                        >
                            Settings / API Keys
                        </button>
                        . Without a key the audit falls back to the shared anonymous Google quota and
                        fails with a "Queries per day" quota error.
                    </span>
                </div>
            )}
            <div className="flex items-center justify-end gap-2">
                <Hint label="Load a previously exported .json file — replaces the results on screen">
                    <Button variant="outline" onClick={onImportClick} disabled={isAuditing}>
                        <Upload className="mr-1 h-4 w-4" />Import
                    </Button>
                </Hint>
                <input ref={importInputRef} type="file" accept="application/json,.json" onChange={handleImportFile} className="hidden" />
                <Hint label="Save the current Desktop + Mobile results to a .json file, run history included">
                    <Button variant="outline" onClick={exportResults} disabled={isAuditing || !hasResults}>
                        <Download className="mr-1 h-4 w-4" />Export
                    </Button>
                </Hint>
                <PageSpeedHistoryDropdown
                    entries={history}
                    onSelect={restoreFromHistory}
                    onDelete={onDeleteHistory}
                    onClear={onClearHistory}
                    disabled={isAuditing}
                />
                <PageSpeedConfig configHasChanged={onConfigChanged} isAuditing={isAuditing} value={restoredConfig} restoreToken={restoreToken} />
            </div>
            <Card className="my-4">
                <div className="flex items-center justify-between gap-2 px-6 pt-6">
                    <Hint label="Keep this run in the History list on this machine — the last 25 are kept">
                        <Button variant="outline" onClick={saveToHistory} disabled={isAuditing || !hasResults}>
                            <Save className="mr-1 h-4 w-4" />Save to history
                        </Button>
                    </Hint>
                    <div className="flex items-center gap-2">
                        <Hint label="Copy Desktop + Mobile as one Excel-style table, ready to paste into Teams">
                            <Button variant="outline" onClick={copyAsExcelTable} disabled={isAuditing || !hasResults}>
                                <TableIcon className="mr-1 h-4 w-4" />Copy for Teams
                            </Button>
                        </Hint>
                        <Hint label="Ask Claude to read both strategies together and call out where mobile and desktop diverge">
                            <Button variant="outline" onClick={runPageAnalysis} disabled={!hasResults || pageAnalysis?.status === 'running'}>
                                {pageAnalysis?.status === 'running'
                                    ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                                    : <Sparkles className="mr-1 h-4 w-4 text-primary" />}
                                Run Assessment
                            </Button>
                        </Hint>
                        <Hint label="Locate the source repository for these URLs, then have Claude read it (read-only) and tie each metric change to the commit and file that caused it. You pick the folder each time; nothing about it is saved.">
                            <span>
                                <Button variant="outline" onClick={runFullAssessment} disabled={!hasResults || deepDive?.status === 'running'}>
                                    {deepDive?.status === 'running'
                                        ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                                        : <Wrench className="mr-1 h-4 w-4 text-primary" />}
                                    Full Assessment
                                </Button>
                            </span>
                        </Hint>
                        <Hint label="Write a Markdown prompt into a project folder — hand it to Claude Code in that repo to find what is degrading the scores and fix it">
                            <Button variant="outline" onClick={createFixBrief} disabled={isAuditing || !hasResults}>
                                <FileDown className="mr-1 h-4 w-4" />Fix Brief
                            </Button>
                        </Hint>
                    </div>
                </div>
                {pageAnalysis && (
                    <AnalysisCard
                        state={pageAnalysis}
                        heading="ASSESSMENT RESULTS — DESKTOP + MOBILE"
                        icon={<Sparkles className="h-4 w-4 text-primary" />}
                        open={pageAnalysisOpen}
                        onToggle={() => setPageAnalysisOpen(v => !v)}
                        onRetry={runPageAnalysis}
                        retryHint="Run the combined Desktop + Mobile analysis again"
                        runningLabel="Reviewing Desktop & Mobile results…"
                        writingLabel="Writing the performance analysis…"
                    />
                )}
                {deepDive && (
                    <AnalysisCard
                        state={deepDive}
                        // Name what was compared, not its hashes — the resolved ref
                        // (release/v3.14.1) is what the user recognises.
                        heading={`FULL ASSESSMENT — ${refName(deepDiveMeta?.before, desktopConfig.beforeLabel)} → ${refName(deepDiveMeta?.after, desktopConfig.afterLabel)}`}
                        icon={<Wrench className="h-4 w-4 text-primary" />}
                        open={deepDiveOpen}
                        onToggle={() => setDeepDiveOpen(v => !v)}
                        onRetry={runFullAssessment}
                        retryHint="Locate the repository again and re-run the investigation"
                        runningLabel="Reading the repository and correlating commits…"
                        writingLabel="Writing the cause attribution…"
                        progress={deepDiveProgress}
                        onCancel={() => window.electronAPI.pagespeedInsight.cancelAttribution()}
                        footer={deepDiveMeta && (
                            <div className="mt-3 space-y-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
                                <div>
                                    {refName(deepDiveMeta.before, desktopConfig.beforeLabel)}
                                    {deepDiveMeta.before?.short && ` (${deepDiveMeta.before.short})`}
                                    {' → '}
                                    {refName(deepDiveMeta.after, desktopConfig.afterLabel)}
                                    {deepDiveMeta.after?.short && ` (${deepDiveMeta.after.short})`}
                                </div>
                                <div>
                                    {deepDiveMeta.repoRoot} · {deepDiveMeta.commitCount ?? 0} commit(s), {deepDiveMeta.filesChanged ?? 0} file(s) changed
                                    {deepDiveMeta.costUsd !== undefined && ` · $${deepDiveMeta.costUsd.toFixed(2)}`}
                                </div>
                                {deepDiveMeta.warnings?.map(w => (
                                    <div key={w.code} className={w.code === 'REPO_MUTATED' ? 'text-destructive' : 'text-warning'}>
                                        {w.code}: {w.message}
                                    </div>
                                ))}
                            </div>
                        )}
                    />
                )}
                <PageSpeedResults ref={desktopRef} config={desktopConfig} onAuditingChange={setDesktopAuditing} onResultsChange={onResultsChange} grouped />
                <PageSpeedResults ref={mobileRef} config={mobileConfig} onAuditingChange={setMobileAuditing} onResultsChange={onResultsChange} grouped />
            </Card>
        </>
    );
}
