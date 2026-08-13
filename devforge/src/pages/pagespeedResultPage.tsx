import { PageSpeedResults, type PageSpeedResultsHandle } from "@/components/pagespeed/pagespeed-result";
import { useCallback, useRef, useState } from "react";
import PageSpeedConfig from "@/components/pagespeed/pagespeed-config";
import PageSpeedHistoryDropdown from "@/components/pagespeed/pagespeed-history-dropdown";
import { type PageSpeedConfiguration } from "@shared/types/pageSpeedInsight.types";
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
} from "@/lib/pagespeed-history";
import { useSettings } from "@/context/settings-context";
import { Button, Toast } from "@/components/ui";
import { isNullOrEmpty } from "@shared/utils/stringHelper";
import { AlertTriangle, ChevronDown, Loader2, RotateCw, Save, Sparkles, Table as TableIcon } from "lucide-react";
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
    results1: r.results1.map(s => (s == null ? null : s)) as SerializedAuditSlot[],
    results2: r.results2.map(s => (s == null ? null : s)) as SerializedAuditSlot[],
    times1: serializeTimes(r.times1),
    times2: serializeTimes(r.times2),
    auditStart: r.auditStart ? r.auditStart.toISOString() : null,
    auditEnd: r.auditEnd ? r.auditEnd.toISOString() : null,
    analyses: r.analyses,
});

export default function PageSpeedResultPage() {
    const { settings } = useSettings();
    const apiKey = settings.apiKeys.pagespeedApiKey;
    const [desktopConfig, setDesktopConfig] = useState(() => ({ ...defaultPageSpeedConfiguration('desktop'), apiKey }));
    const [mobileConfig, setMobileConfig] = useState(() => ({ ...defaultPageSpeedConfiguration('mobile'), apiKey }));
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

    const analyzeAll = () => {
        desktopRef.current?.startAudit();
        mobileRef.current?.startAudit();
    };

    const cancelAll = () => {
        desktopRef.current?.cancelAudit();
        mobileRef.current?.cancelAudit();
    };

    const canAnalyze = desktopConfig.urls.length > 0 && !isNullOrEmpty(desktopConfig.apiKey);

    // Bumped by children whenever their results change, so hasResults (read from refs)
    // is re-evaluated — refs alone don't trigger a parent re-render.
    const [, setResultsTick] = useState(0);
    const onResultsChange = useCallback(() => setResultsTick(t => t + 1), []);

    // Page-level Claude analysis covering Desktop + Mobile together.
    const [pageAnalysis, setPageAnalysis] = useState<{ status: 'running' | 'done' | 'error'; markdown: string; error: string | null } | null>(null);
    const [pageAnalysisOpen, setPageAnalysisOpen] = useState(true);

    const runPageAnalysis = async () => {
        const d = desktopRef.current?.getAnalysisSummary() ?? '';
        const m = mobileRef.current?.getAnalysisSummary() ?? '';
        if (!d && !m) {
            toast.warning('Run Desktop and/or Mobile audits first');
            return;
        }
        const summary = [
            'Combined Desktop + Mobile PageSpeed results. Cover BOTH strategies and call out where they diverge (e.g. mobile regresses while desktop improves).',
            d ? `# DESKTOP\n\n${d}` : '',
            m ? `# MOBILE\n\n${m}` : '',
        ].filter(Boolean).join('\n\n====\n\n');

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

    const slotHasAny = (ref: React.RefObject<PageSpeedResultsHandle | null>): boolean => {
        const r = ref.current?.getResults();
        if (!r) return false;
        return r.results1.some(Boolean) || r.results2.some(Boolean);
    };
    const hasResults = slotHasAny(desktopRef) || slotHasAny(mobileRef);

    const saveToHistory = () => {
        const desktop = desktopRef.current?.getResults();
        const mobile = mobileRef.current?.getResults();
        if (!desktop || !mobile) return;
        const id = String(Date.now());
        const snapshot: PageSpeedHistorySnapshot = {
            id,
            savedAt: new Date().toISOString(),
            // Strip apiKey — never persist secrets; re-injected from settings on restore.
            config: { ...desktopConfig, apiKey: '' },
            desktop: toStrategySnapshot(desktop),
            mobile: toStrategySnapshot(mobile),
            pageAnalysis: pageAnalysis?.status === 'done' && pageAnalysis.markdown
                ? { markdown: pageAnalysis.markdown }
                : null,
        };
        setHistory(saveSnapshot(snapshot));
        toast.success('Analysis saved to history');
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

        const th = (v: string, colSpan = 1, rowSpan = 1, extra = '') =>
            `<th colspan="${colSpan}" rowspan="${rowSpan}" style="background:#f1f1f1;text-align:center;padding:4px 6px;border:1px solid #999;font-size:12px${extra}">${v}</th>`;
        const td = (v: string, extra = '') =>
            `<td style="text-align:center;padding:4px 6px;border:1px solid #999;font-size:12px${extra}">${v}</td>`;

        const headerRows =
            `<tr>${th('URL', 1, 4, ';background:#fff')}${th('PAGESPEED', strategies.length * colsPerStrategy)}</tr>` +
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
                return `<td rowspan="${rowCount}" style="padding:4px 6px;border:1px solid #999;font-size:12px;vertical-align:top">${url}</td>`;
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
                    if (!b || !a) return `<td colspan="2" style="text-align:center;padding:4px 6px;border:1px solid #999;font-size:12px;color:#999">-</td>`;
                    const pct = ((b - a) / b) * 100;
                    const text = `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%`;
                    const color = pct >= 0 ? '#16a34a' : (Math.abs(pct) > desktopConfig.improvementThreshold ? '#dc2626' : '#ea580c');
                    return `<td colspan="2" style="text-align:center;padding:4px 6px;border:1px solid #999;font-size:12px;color:${color};font-weight:600">${text}</td>`;
                }).join('')).join('');
                bodyRows.push(`<tr>${urlCell()}${pctRowHtml}</tr>`);
            }
        });

        const analysisMd = pageAnalysis?.status === 'done' ? pageAnalysis.markdown : '';
        const analysisHtml = analysisMd ? `<br/>${marked.parse(analysisMd, { async: false }) as string}` : '';
        const html = `<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif">${headerRows}${bodyRows.join('')}</table>${analysisHtml}`;

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
                subtitle="Run Lighthouse / PageSpeed Insights audits across desktop and mobile — single run, branch compare, or averaged."
            />
            <div className="flex items-center justify-end gap-2">
                {isAuditing && (
                    <Button variant="outline" onClick={cancelAll}>Cancel</Button>
                )}
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
                    <Button variant="outline" onClick={saveToHistory} disabled={isAuditing || !hasResults}>
                        <Save className="mr-1 h-4 w-4" />Save to history
                    </Button>
                    <div className="flex items-center gap-2">
                        <Button variant="outline" onClick={copyAsExcelTable} disabled={isAuditing || !hasResults} title="Copy Desktop + Mobile comparison as an Excel-style table">
                            <TableIcon className="mr-1 h-4 w-4" />Copy for Teams
                        </Button>
                        <Button variant="outline" onClick={runPageAnalysis} disabled={!hasResults || pageAnalysis?.status === 'running'} title="Claude analysis across Desktop + Mobile results">
                            {pageAnalysis?.status === 'running'
                                ? <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                                : <Sparkles className="mr-1 h-4 w-4 text-primary" />}
                            Claude Analysis
                        </Button>
                    </div>
                </div>
                {pageAnalysis && (
                    <Card className="my-4 mx-6 shadow-none">
                        <CardHeader>
                            <CardTitle>
                                <button
                                    onClick={() => setPageAnalysisOpen(v => !v)}
                                    className="flex w-full items-center gap-2 text-sm text-left hover:opacity-80 transition-opacity"
                                >
                                    <Sparkles className="h-4 w-4 text-primary" />
                                    CLAUDE ANALYSIS — DESKTOP + MOBILE
                                    <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200 ${pageAnalysisOpen ? 'rotate-180' : ''}`} />
                                </button>
                            </CardTitle>
                        </CardHeader>
                        {pageAnalysisOpen && (
                        <CardContent className="text-xs">
                            {pageAnalysis.status === 'running' && (
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2 text-muted-foreground">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                        {pageAnalysis.markdown ? 'Writing the performance analysis…' : 'Reviewing Desktop & Mobile results…'}
                                    </div>
                                    {pageAnalysis.markdown && (
                                        <pre className="whitespace-pre-wrap border-t border-border pt-2 font-mono text-[11px] leading-relaxed text-foreground/80">{pageAnalysis.markdown}</pre>
                                    )}
                                </div>
                            )}
                            {pageAnalysis.status === 'error' && (
                                <div className="flex flex-col items-start gap-2">
                                    <div className="flex items-center gap-2 text-destructive">
                                        <AlertTriangle className="h-4 w-4" />
                                        <span>{pageAnalysis.error || 'Something went wrong.'}</span>
                                    </div>
                                    <Button variant="outline" size="sm" onClick={runPageAnalysis}>
                                        <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
                                    </Button>
                                </div>
                            )}
                            {pageAnalysis.status === 'done' && (
                                <div className="ps-analysis-content" dangerouslySetInnerHTML={{ __html: marked.parse(pageAnalysis.markdown, { async: false }) as string }} />
                            )}
                        </CardContent>
                        )}
                    </Card>
                )}
                <PageSpeedResults ref={desktopRef} config={desktopConfig} onAuditingChange={setDesktopAuditing} onResultsChange={onResultsChange} grouped />
                <PageSpeedResults ref={mobileRef} config={mobileConfig} onAuditingChange={setMobileAuditing} onResultsChange={onResultsChange} grouped />
            </Card>
        </>
    );
}
