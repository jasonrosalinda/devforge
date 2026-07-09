import { PageSpeedResults, type PageSpeedResultsHandle } from "@/components/pagespeed/pagespeed-result";
import { useRef, useState } from "react";
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
import { Loader2, Save, Sparkles, Table as TableIcon } from "lucide-react";
import { SiPagespeedinsights } from "react-icons/si";
import { PageHeader } from "@/components/layout/page-header";

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

    const canAnalyze = desktopConfig.urls.length > 0 &&
        (!desktopConfig.browserMode ? !isNullOrEmpty(desktopConfig.apiKey) : true);

    const hasResults =
        (desktopRef.current?.getResults().results1.some(r => r && r !== null) ?? false) ||
        (mobileRef.current?.getResults().results1.some(r => r && r !== null) ?? false);

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

            for (let r = 0; r < numRuns; r++) {
                const rowHtml = slots.map(s => metricDefs.map(m => {
                    const beforeRun = s.before ? s.before.runHistory?.[r] : undefined;
                    const afterRun = s.after ? s.after.runHistory?.[r] : undefined;
                    if (!comparisonMode) return td(cellText(beforeRun, m.key));
                    return td(cellText(beforeRun, m.key)) + td(cellText(afterRun, m.key));
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

        const html = `<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif">${headerRows}${bodyRows.join('')}</table>`;

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
        }).join('\n');

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
                <Button variant="outline" onClick={saveToHistory} disabled={isAuditing || !hasResults}>
                    <Save className="mr-1 h-4 w-4" />Save to history
                </Button>
                <Button variant="outline" onClick={copyAsExcelTable} disabled={isAuditing || !hasResults} title="Copy Desktop + Mobile comparison as an Excel-style table">
                    <TableIcon className="mr-1 h-4 w-4" />Copy as Table
                </Button>
                <PageSpeedConfig configHasChanged={onConfigChanged} isAuditing={isAuditing} value={restoredConfig} restoreToken={restoreToken} />
            </div>
            <PageSpeedResults ref={desktopRef} config={desktopConfig} onAuditingChange={setDesktopAuditing} />
            <PageSpeedResults ref={mobileRef} config={mobileConfig} onAuditingChange={setMobileAuditing} />
        </>
    );
}
