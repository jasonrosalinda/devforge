import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { usePageSpeedInsight } from '../../hooks/usePageSpeedInsight';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Triangle, Square, Circle, Sparkles, RotateCw, AlertTriangle, Copy, FileDown } from 'lucide-react';
import { marked } from 'marked';

type AnalysisStatus = 'running' | 'done' | 'error';
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button, Toast } from '../ui';
import type { PageSpeedInsightResult, PageSpeedMetrics, PageSpeedConfiguration, PageSpeedInsightResultMessage, PageSpeedOpportunity } from '@shared/types/pageSpeedInsight.types';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { displayPageSpeedAudit, getPageSpeedInsightResultMessages, getPageSpeedInsightResultAverage } from '@/lib/pageSpeedUtils';
import { isNullOrEmpty } from '@shared/utils/stringHelper';
import type { StrategySnapshot } from '@/lib/pagespeed-history';
type AuditSlot = PageSpeedInsightResult | null | false | undefined;
type AuditTimes = { start: Date | null; end: Date | null };

export interface PageSpeedResultsHandle {
    startAudit: () => void;
    cancelAudit: () => void;
    getResults: () => {
        results1: AuditSlot[];
        results2: AuditSlot[];
        config: PageSpeedConfiguration;
        auditStart: Date | null;
        auditEnd: Date | null;
        times1: AuditTimes;
        times2: AuditTimes;
        analyses: Record<number, { status: AnalysisStatus; markdown: string; error: string | null }>;
    };
    restoreSnapshot: (snapshot: StrategySnapshot) => void;
    // Markdown-ish data summary of every audited URL (before/after, runs, insights,
    // cross-run identical values) — feeds the page-level Desktop+Mobile AI analysis.
    getAnalysisSummary: () => string;
}

interface PageSpeedResultsProps {
    config: PageSpeedConfiguration;
    onAuditingChange?: (isAuditing: boolean) => void;
    onResultsChange?: () => void;
    // Render as a chrome-less section so the parent can group strategies inside one Card.
    grouped?: boolean;
}

// Inset box-shadow fakes borders on sticky cells — real borders get painted
// under the sticky background, but box-shadow renders above it.
// right + bottom edges only (left edge is the table boundary)
const stickyBorder = 'shadow-[inset_-1px_-1px_0_hsl(var(--border))]';

const CollapsibleMessages = ({ messages, forceExpanded }: { messages: PageSpeedInsightResultMessage[]; forceExpanded?: boolean }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const expanded = forceExpanded ?? isExpanded;

    if (messages.length === 0) return null;

    const groups: Record<string, PageSpeedInsightResultMessage[]> = {};
    const unparsed: PageSpeedInsightResultMessage[] = [];
    let hasErrors = false;
    const warningCount = messages.filter(m => !m.isError).length;
    const errorCount = messages.filter(m => m.isError).length;

    messages.forEach(m => {
        if (m.isError) hasErrors = true;

        const match = m.message.match(/^(Run \d+):\s*(.*)/);
        if (match && match[1] && match[2]) {
            const groupName = match[1];
            if (!groups[groupName]) groups[groupName] = [];
            groups[groupName].push({ ...m, message: match[2] });
        } else {
            unparsed.push(m);
        }
    });

    const summaryColor = hasErrors ? 'text-red-500' : 'text-orange-500';

    return (
        <div className="mt-1">
            <button title="Toggle errors and warnings" onClick={() => setIsExpanded(!isExpanded)} className={`flex items-center text-xs hover:opacity-80 transition-opacity ${summaryColor}`}>
                {expanded ? <ChevronDown size={14} className="mr-1 inline" data-html2canvas-ignore="true" /> : <ChevronRight size={14} className="mr-1 inline" data-html2canvas-ignore="true" />}
                {warningCount > 0 && `${warningCount} warning(s)`}
                {warningCount > 0 && errorCount > 0 && ' / '}
                {errorCount > 0 && `${errorCount} error(s)`}
            </button>
            {expanded && (
                <div className="ml-4 mt-2 space-y-2">
                    {unparsed.map((p, i) => (
                        <p key={`u-${i}`} className={`text-xs ${p.isError ? 'text-red-500' : 'text-orange-500'}`}>* {p.message}</p>
                    ))}
                    {Object.entries(groups).map(([groupName, groupMessages], i) => (
                        <div key={i} className="space-y-1">
                            <div className="text-xs font-semibold text-muted-foreground">{groupName}</div>
                            <div className="pl-2 border-l border-border space-y-1">
                                {groupMessages.map((m, j) => (
                                    <p key={j} className={`text-xs ${m.isError ? 'text-red-500' : 'text-orange-500'}`}>* {m.message}</p>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

export const PageSpeedResults = React.forwardRef<PageSpeedResultsHandle, PageSpeedResultsProps>(({ config, onAuditingChange, onResultsChange, grouped = false }, ref) => {
    const { audit, clearCache } = usePageSpeedInsight(config);
    const { elementRef, copyAsImage } = useCopyElementAsImage({
        fileNamePrefix: `pagespeed-result-${config.strategy}-${Date.now()}`,
    });

    const [copying, setCopying] = useState(false);
    const [results1, setResults1] = useState<AuditSlot[]>([]);
    const [results2, setResults2] = useState<AuditSlot[]>([]);
    const [auditing1, setAuditing1] = useState(false);
    const [auditing2, setAuditing2] = useState(false);
    const [retryingRows, setRetryingRows] = useState<Set<string>>(new Set());
    const [rerunningRuns, setRerunningRuns] = useState<Set<string>>(new Set());
    const [expandedHistory, setExpandedHistory] = useState<Set<number>>(new Set());
    const [expandedInsights, setExpandedInsights] = useState<Set<string>>(new Set());
    // Drawer Before/After cards — collapsed keys (default open).
    const [collapsedRunCards, setCollapsedRunCards] = useState<Set<string>>(new Set());
    const toggleRunCard = (key: string) => setCollapsedRunCards(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    const [analyses, setAnalyses] = useState<Record<number, { status: AnalysisStatus; markdown: string; error: string | null }>>({});
    const abortControllerRef = useRef<AbortController | null>(null);
    const activeAuditsRef = useRef(0);
    const [auditStart, setAuditStart] = useState<Date | null>(null);
    const [auditEnd, setAuditEnd] = useState<Date | null>(null);
    const [times1, setTimes1] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
    const [times2, setTimes2] = useState<{ start: Date | null; end: Date | null }>({ start: null, end: null });
    const [elapsed, setElapsed] = useState(0);
    const isAuditing = auditing1 || auditing2;
    const isRetryingAny = retryingRows.size > 0;
    const timerActive = isAuditing || isRetryingAny;

    // Let the parent re-evaluate results-dependent UI (e.g. header "Copy as Table" button)
    // whenever this strategy's results change — refs alone don't trigger parent re-renders.
    useEffect(() => {
        onResultsChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [results1, results2]);

    useEffect(() => {
        if (!timerActive || !auditStart) return;
        setElapsed(0);
        const id = setInterval(() => {
            setElapsed(Math.round((Date.now() - auditStart.getTime()) / 1000));
        }, 1000);
        return () => clearInterval(id);
    }, [timerActive, auditStart]);

    const displayAudit = displayPageSpeedAudit(config);
    const showAnalyzeButton = config.urls.length > 0 && (!config.browserMode ? !isNullOrEmpty(config.apiKey) : true);
    const toast = Toast();
    const hasSubHead = !!(displayAudit.before && displayAudit.after);
    const isAccuracyMode = config.runMode === 'average';


    const toggleHistory = (index: number) => {
        setExpandedHistory(prev => {
            const next = new Set(prev);
            if (next.has(index)) next.delete(index);
            else next.add(index);
            return next;
        });
    };

    const toggleInsight = (key: string) => {
        setExpandedInsights(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const setAuditingWithCallback = (
        setter: React.Dispatch<React.SetStateAction<boolean>>,
        value: boolean,
        otherAuditing: boolean,
    ) => {
        setter(value);
        onAuditingChange?.(value || otherAuditing);
    };

    const MAX_RETRIES = 2;

    const auditWithRetry = useCallback(async (url: string, signal?: AbortSignal, runMode?: PageSpeedConfiguration['runMode']): Promise<PageSpeedInsightResult> => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await audit(url, signal, runMode);
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                lastError = err;
                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
                }
            }
        }
        throw lastError;
    }, [audit]);

    const runAudit = async (
        setResults: React.Dispatch<React.SetStateAction<AuditSlot[]>>,
        setAuditing: React.Dispatch<React.SetStateAction<boolean>>,
        otherAuditing: boolean,
        slotKey: '1' | '2',
    ): Promise<void> => {
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const setTimes = slotKey === '1' ? setTimes1 : setTimes2;
        setTimes({ start: new Date(), end: null });
        if (activeAuditsRef.current === 0) {
            setAuditStart(new Date());
            setAuditEnd(null);
        }
        activeAuditsRef.current++;
        setAuditingWithCallback(setAuditing, true, otherAuditing);
        setResults(new Array(config.urls.length).fill(null));
        if (config.browserMode) {
            await clearCache();
        }

        try {
            const effectiveConcurrency = config.browserMode ? 1 : config.concurrency;
            const urlQueue: Array<[number, string]> = [...config.urls.entries()];

            const worker = async () => {
                while (!controller.signal.aborted) {
                    const next = urlQueue.shift();
                    if (!next) break;
                    const [index, url] = next;
                    try {
                        const result = await auditWithRetry(url, controller.signal);
                        setResults(prev => {
                            const next = [...prev];
                            next[index] = result;
                            return next;
                        });
                    } catch (error) {
                        if (error instanceof DOMException && error.name === 'AbortError') return;
                        console.error(`Audit failed for ${url} after ${MAX_RETRIES} retries:`, error);
                        setResults(prev => {
                            const next = [...prev];
                            next[index] = false;
                            return next;
                        });
                    }
                }
            };

            await Promise.all(Array.from({ length: effectiveConcurrency }, worker));
        } finally {
            setResults(prev => prev.map(slot => (slot === null ? undefined : slot)));
            setTimes(prev => ({ ...prev, end: new Date() }));
            activeAuditsRef.current--;
            if (activeAuditsRef.current === 0) setAuditEnd(new Date());
            setAuditingWithCallback(setAuditing, false, otherAuditing);
        }
    };

    const audit1 = () => runAudit(setResults1, setAuditing1, auditing2, '1');
    const audit2 = () => runAudit(setResults2, setAuditing2, auditing1, '2');

    const restoreSnapshot = (snapshot: StrategySnapshot) => {
        // Saved runs never carry `null` (loading); JSON turned `undefined` slots
        // into `null`, so map them back so the table renders "no run" not a spinner.
        const reviveSlots = (slots: StrategySnapshot['results1']): AuditSlot[] =>
            slots.map(s => (s === null ? undefined : s));
        const reviveTimes = (t: StrategySnapshot['times1']): AuditTimes => ({
            start: t.start ? new Date(t.start) : null,
            end: t.end ? new Date(t.end) : null,
        });
        const reviveAnalyses = (a: StrategySnapshot['analyses']): Record<number, { status: AnalysisStatus; markdown: string; error: string | null }> => {
            const out: Record<number, { status: AnalysisStatus; markdown: string; error: string | null }> = {};
            for (const [k, v] of Object.entries(a)) out[Number(k)] = v;
            return out;
        };

        abortControllerRef.current?.abort();
        setResults1(reviveSlots(snapshot.results1));
        setResults2(reviveSlots(snapshot.results2));
        setTimes1(reviveTimes(snapshot.times1));
        setTimes2(reviveTimes(snapshot.times2));
        setAuditStart(snapshot.auditStart ? new Date(snapshot.auditStart) : null);
        setAuditEnd(snapshot.auditEnd ? new Date(snapshot.auditEnd) : null);
        setAnalyses(reviveAnalyses(snapshot.analyses));
        setRetryingRows(new Set());
        setRerunningRuns(new Set());
        setExpandedHistory(new Set());
        setExpandedInsights(new Set());
    };

    useImperativeHandle(ref, () => ({
        startAudit: audit1,
        cancelAudit: () => abortControllerRef.current?.abort(),
        getResults: () => ({ results1, results2, config, auditStart, auditEnd, times1, times2, analyses }),
        restoreSnapshot,
        getAnalysisSummary: () => config.urls
            .map((_, i) => (getSlot1(i) || getSlot2(i) ? buildAnalysisSummary(i) : null))
            .filter(Boolean)
            .join('\n\n---\n\n'),
    }));

    const retryRow = useCallback(async (
        index: number,
        setResults: React.Dispatch<React.SetStateAction<AuditSlot[]>>,
        slotKey: '1' | '2',
    ) => {
        const url = config.urls[index];
        if (!url) return;

        const rowKey = `${slotKey}-${index}`;

        // Partial retry: when the row has run history (accuracy mode), re-run only the
        // failed runs and keep the good ones, then re-average. Otherwise re-run the whole URL.
        const runFailed = (r: PageSpeedInsightResult): boolean => {
            const err = r.errorResponse;
            if (!err) return false;
            if (err.code !== 0) return true;
            return Array.isArray(err.message) ? err.message.some(m => m.length > 0) : err.message.length > 0;
        };
        const existing = (slotKey === '1' ? results1 : results2)[index];
        const history = (existing && typeof existing === 'object') ? existing.runHistory : undefined;
        const failedRunIdx = history ? history.map((r, i) => (runFailed(r) ? i : -1)).filter(i => i >= 0) : [];
        const partial = !!history && failedRunIdx.length > 0 && failedRunIdx.length < history.length;

        if (activeAuditsRef.current === 0) setAuditEnd(null);
        activeAuditsRef.current++;
        setRetryingRows(prev => new Set(prev).add(rowKey));
        setResults(prev => {
            const next = [...prev];
            next[index] = null;
            return next;
        });

        try {
            let result: PageSpeedInsightResult;
            if (partial && history) {
                // Re-run each failed run as a single audit, splice back into the run list, re-average.
                const merged = [...history];
                for (const fi of failedRunIdx) {
                    merged[fi] = await auditWithRetry(url, undefined, 'single');
                }
                result = getPageSpeedInsightResultAverage(url, merged);
            } else {
                result = await auditWithRetry(url);
            }
            setResults(prev => {
                const next = [...prev];
                next[index] = result;
                return next;
            });
        } catch (error) {
            console.error(`Retry failed for ${url}:`, error);
            setResults(prev => {
                const next = [...prev];
                next[index] = false;
                return next;
            });
        } finally {
            (slotKey === '1' ? setTimes1 : setTimes2)(prev => ({ ...prev, end: new Date() }));
            activeAuditsRef.current--;
            if (activeAuditsRef.current === 0) setAuditEnd(new Date());
            setRetryingRows(prev => {
                const next = new Set(prev);
                next.delete(rowKey);
                return next;
            });
        }
    }, [auditWithRetry, config.urls, results1, results2]);

    // Re-run a single run within an accuracy-mode row: audit once, splice the fresh
    // result into that slot's run list at runIdx, then re-average the row.
    const rerunSingleRun = useCallback(async (
        index: number,
        runIdx: number,
        slotKey: '1' | '2',
    ) => {
        const url = config.urls[index];
        if (!url) return;
        const setResults = slotKey === '1' ? setResults1 : setResults2;
        const existing = (slotKey === '1' ? results1 : results2)[index];
        const history = (existing && typeof existing === 'object') ? existing.runHistory : undefined;
        if (!history || !history[runIdx]) return;

        const runKey = `${slotKey}-${index}-${runIdx}`;
        if (activeAuditsRef.current === 0) setAuditEnd(null);
        activeAuditsRef.current++;
        setRerunningRuns(prev => new Set(prev).add(runKey));

        try {
            const fresh = await auditWithRetry(url, undefined, 'single');
            const merged = [...history];
            merged[runIdx] = fresh;
            const result = getPageSpeedInsightResultAverage(url, merged);
            setResults(prev => {
                const next = [...prev];
                next[index] = result;
                return next;
            });
        } catch (error) {
            console.error(`Re-run failed for ${url} (run ${runIdx + 1}):`, error);
        } finally {
            (slotKey === '1' ? setTimes1 : setTimes2)(prev => ({ ...prev, end: new Date() }));
            activeAuditsRef.current--;
            if (activeAuditsRef.current === 0) setAuditEnd(new Date());
            setRerunningRuns(prev => {
                const next = new Set(prev);
                next.delete(runKey);
                return next;
            });
        }
    }, [auditWithRetry, config.urls, results1, results2]);

    // Use the value as DISPLAYED (rounded) so the improvement % is consistent
    // with the numbers shown — e.g. "1.3 s" vs "1.3 s" reads 0%, not a delta
    // hidden by rounding. Falls back to the raw numericValue if unparseable.
    const displayNum = (m?: PageSpeedMetrics): number => {
        if (!m) return 0;
        const n = parseFloat(String(m.displayValue).replace(/,/g, ''));
        return Number.isFinite(n) ? n : m.numericValue;
    };

    const calculateImprovement = (before: number, after: number): React.ReactNode => {
        if (!before || !after) return <div>-</div>;
        const improvement = ((before - after) / before) * 100;
        const formatted = improvement.toFixed(2);
        const color = improvement >= 0
            ? 'text-green-500'
            : Math.abs(improvement) > config.improvementThreshold
                ? 'text-red-500'
                : 'text-orange-500';
        return (
            <div className={color}>
                {improvement > 0 ? `+${formatted}%` : `${formatted}%`}
            </div>
        );
    };

    const onCopyAsImage = async () => {
        setCopying(true);
        await new Promise(resolve => setTimeout(resolve, 1000));
        toast.promise(copyAsImage(), {
            loading: 'Copying...',
            success: 'Copied successfully',
            error: 'Copy failed',
        });
        setCopying(false);
    };

    // Copy the comparison table (+ all-URLs analysis if present) as rich HTML for Teams.
    const copyForTeams = () => {
        const metricDefs = ([
            { show: displayAudit.SI, label: 'SI', key: 'speedIndex' },
            { show: displayAudit.LCP, label: 'LCP', key: 'largestContentfulPaint' },
            { show: displayAudit.CLS, label: 'CLS', key: 'cumulativeLayoutShift' },
            { show: displayAudit.TBT, label: 'TBT', key: 'totalBlockingTime' },
            { show: displayAudit.FCP, label: 'FCP', key: 'firstContentfulPaint' },
        ] as const).filter(m => m.show);

        const single = displayAudit.singleResult;
        const showImp = !single && displayAudit.improvement;
        const td = (v: string, extra = '') => `<td style="padding:6px;border:1px solid #ccc${extra}">${v}</td>`;
        const impCell = (b?: number, a?: number): string => {
            if (!b || !a) return td('-');
            const pct = ((b - a) / b) * 100;
            const text = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
            const color = pct >= 0 ? '#16a34a' : (Math.abs(pct) > config.improvementThreshold ? '#dc2626' : '#ea580c');
            return td(text, `;color:${color};font-weight:600`);
        };

        const headCells = ['URL'];
        for (const m of metricDefs) {
            if (single) headCells.push(m.label);
            else {
                headCells.push(`${m.label} (${config.beforeLabel})`, `${m.label} (${config.afterLabel})`);
                if (showImp) headCells.push(`${m.label} Δ`);
            }
        }
        const thead = `<tr>${headCells.map(h => `<th style="background:#f1f1f1;text-align:left;padding:6px;border:1px solid #ccc">${h}</th>`).join('')}</tr>`;

        const rows = config.urls.map((url, i) => {
            const r1 = getSlot1(i) || undefined;
            const r2 = getSlot2(i) || undefined;
            let tds = td(url);
            for (const m of metricDefs) {
                const v1 = r1?.[m.key]?.displayValue ?? '-';
                const v2 = r2?.[m.key]?.displayValue ?? '-';
                if (single) tds += td(v1);
                else {
                    tds += td(v1) + td(v2);
                    if (showImp) tds += impCell(displayNum(r1?.[m.key]), displayNum(r2?.[m.key]));
                }
            }
            let html = `<tr>${tds}</tr>`;

            // Individual runs (Average run mode) — grouped under the URL as #N sub-rows,
            // run values aligned to their Before/After columns.
            const h1 = r1?.runHistory ?? [];
            const h2 = single ? [] : (r2?.runHistory ?? []);
            const runCount = Math.max(h1.length, h2.length);
            if (runCount > 1) {
                // Values appearing in BOTH before and after run sets for the same metric get highlighted,
                // regardless of run index — spots identical measurements across the two runs.
                const matchedByMetric = new Map<string, Set<string>>();
                if (!single) {
                    for (const m of metricDefs) {
                        const set1 = new Set(h1.map(r => r?.[m.key]?.displayValue).filter(Boolean) as string[]);
                        const vals2 = h2.map(r => r?.[m.key]?.displayValue).filter(Boolean) as string[];
                        matchedByMetric.set(m.key, new Set(vals2.filter(v => set1.has(v))));
                    }
                }
                const runCell = (v: string, metricKey: string): string => {
                    const hl = v !== '-' && matchedByMetric.get(metricKey)?.has(v);
                    return td(v, hl ? ';background:#fff3cd;color:#92400e;font-weight:600;font-style:italic' : ';color:#888');
                };
                for (let ri = 0; ri < runCount; ri++) {
                    const run1 = h1[ri];
                    const run2 = h2[ri];
                    let rtds = td(`#${ri + 1}`, ';color:#888');
                    for (const m of metricDefs) {
                        const v1 = run1?.[m.key]?.displayValue ?? '-';
                        if (single) rtds += td(v1, ';color:#888');
                        else {
                            const v2 = run2?.[m.key]?.displayValue ?? '-';
                            rtds += runCell(v1, m.key) + runCell(v2, m.key);
                            if (showImp) rtds += td('');
                        }
                    }
                    html += `<tr>${rtds}</tr>`;
                }
            }
            return html;
        }).join('');

        const tableHtml = `<table style="border-collapse:collapse;font-family:Segoe UI,Arial,sans-serif;font-size:13px"><thead>${thead}</thead><tbody>${rows}</tbody></table>`;

        const analysisMd = analyses[-1]?.status === 'done' ? analyses[-1]!.markdown : '';
        const analysisHtml = analysisMd ? `<br/>${marked.parse(analysisMd, { async: false }) as string}` : '';
        const title = `${config.strategy.toUpperCase()} — PageSpeed${config.comparisonMode ? ` (${config.beforeLabel} vs ${config.afterLabel})` : ''}`;
        const html = `<h3>${title}</h3>${tableHtml}${analysisHtml}`;

        const plain = `${title}\n` + config.urls.map((url, i) => {
            const r1 = getSlot1(i) || undefined;
            const r2 = getSlot2(i) || undefined;
            const parts = metricDefs.map(m => single
                ? `${m.label} ${r1?.[m.key]?.displayValue ?? '-'}`
                : `${m.label} ${r1?.[m.key]?.displayValue ?? '-'} → ${r2?.[m.key]?.displayValue ?? '-'}`);
            const h1 = r1?.runHistory ?? [];
            const h2 = single ? [] : (r2?.runHistory ?? []);
            const runCount = Math.max(h1.length, h2.length);
            let runLines = '';
            if (runCount > 1) {
                const matched = new Map<string, Set<string>>();
                if (!single) {
                    for (const m of metricDefs) {
                        const set1 = new Set(h1.map(r => r?.[m.key]?.displayValue).filter(Boolean) as string[]);
                        const vals2 = h2.map(r => r?.[m.key]?.displayValue).filter(Boolean) as string[];
                        matched.set(m.key, new Set(vals2.filter(v => set1.has(v))));
                    }
                }
                const mark = (v: string, key: string) => (v !== '-' && matched.get(key)?.has(v)) ? `*${v}*` : v;
                for (let ri = 0; ri < runCount; ri++) {
                    const runParts = metricDefs.map(m => single
                        ? `${m.label} ${h1[ri]?.[m.key]?.displayValue ?? '-'}`
                        : `${m.label} ${mark(h1[ri]?.[m.key]?.displayValue ?? '-', m.key)} → ${mark(h2[ri]?.[m.key]?.displayValue ?? '-', m.key)}`);
                    runLines += `\n  #${ri + 1}: ${runParts.join(', ')}`;
                }
            }
            return `${url}: ${parts.join(', ')}` + runLines;
        }).join('\n') + (analysisMd ? `\n\n${analysisMd}` : '');

        const copy = navigator.clipboard.write([
            new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([plain], { type: 'text/plain' }),
            }),
        ]);
        toast.promise(copy, { loading: 'Copying…', success: 'Copied for Teams', error: 'Copy failed' });
    };

    const thSpan = (!displayAudit.before || !displayAudit.after)
        ? 1
        : (displayAudit.improvement ? 3 : 2);

    const tableHead = (label: string): React.ReactNode => (
        <TableHead colSpan={thSpan} className="text-center border">{label}</TableHead>
    );

    const tableSubHead = (): React.ReactNode => {
        const { SI, LCP, CLS, TBT, FCP } = displayAudit;
        const showMetrics = [SI, LCP, CLS, TBT, FCP].filter(Boolean).length;
        return (
            <>
                {[...Array(showMetrics)].map((_, i) => (
                    <React.Fragment key={i}>
                        {displayAudit.singleResult ? (
                            <TableHead className="text-center text-sm border">Value</TableHead>
                        ) : (
                            <>
                                <TableHead className="text-center text-sm border">{config.beforeLabel}</TableHead>
                                <TableHead className="text-center text-sm border">{config.afterLabel}</TableHead>
                                {displayAudit.improvement && (
                                    <TableHead className="text-center text-sm border">Improvement</TableHead>
                                )}
                            </>
                        )}
                    </React.Fragment>
                ))}
            </>
        );
    };

    const getSlot1 = (index: number): AuditSlot =>
        results1.length > index ? results1[index] : undefined;

    const getSlot2 = (index: number): AuditSlot =>
        results2.length > index ? results2[index] : undefined;

    const getResultMessageForUrl = (slot1: AuditSlot, slot2: AuditSlot): React.ReactNode => {
        if (slot1 === null || slot2 === null) return null;
        const r1 = slot1 || undefined;
        const r2 = slot2 || undefined;
        const messages: PageSpeedInsightResultMessage[] = getPageSpeedInsightResultMessages(r1, r2);

        if (messages.length === 0 || !config.showWarnings) return null;
        return <CollapsibleMessages messages={messages} forceExpanded={true} />;
    };

    const cellValue = (slot: AuditSlot, metric: PageSpeedMetrics | undefined): React.ReactNode => {
        if (slot === null) return <Loader2 className="animate-spin mx-auto" size={20} />;
        if (slot === undefined) return <span>-</span>;
        // Show metric when available — even on partial run failure the average is still valid
        if (metric?.displayValue) return metric.displayValue;
        if (slotHasError(slot)) return <span className="text-destructive/50 text-xs">—</span>;
        return '-';
    };

    const slotHasError = (slot: AuditSlot) => {
        if (slot === false) return true;
        if (!slot || slot === null) return false;
        const r = slot as PageSpeedInsightResult;
        const err = r.errorResponse;
        return !!err && (err.code !== 0 || (Array.isArray(err.message) ? err.message.some(m => m.length > 0) : err.message.length > 0));
    };

    const retryButton = (
        index: number,
        slot: AuditSlot,
        setResults: React.Dispatch<React.SetStateAction<AuditSlot[]>>,
        slotKey: '1' | '2',
    ): React.ReactNode => {
        if (!slotHasError(slot)) return null;
        const rowKey = `${slotKey}-${index}`;
        const isRetrying = retryingRows.has(rowKey);
        return (
            <Button
                variant="ghost"
                size="sm"
                className="h-2.5 w-2.5 p-0"
                disabled={isRetrying || isAuditing}
                onClick={() => retryRow(index, setResults, slotKey)}
                data-html2canvas-ignore="true"
            >
                <RotateCcw className={`h-2 w-2 ${isRetrying ? 'animate-spin' : ''}`} />
            </Button>
        );
    };

    // Re-run a single (non-accuracy) slot — reuses retryRow, which re-audits the
    // whole URL for that slot when there's no run history.
    const singleRunRerunButton = (
        index: number,
        setResults: React.Dispatch<React.SetStateAction<AuditSlot[]>>,
        slotKey: '1' | '2',
    ): React.ReactNode => {
        const busy = retryingRows.has(`${slotKey}-${index}`);
        return (
            <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                disabled={busy || isAuditing || isRetryingAny}
                onClick={() => retryRow(index, setResults, slotKey)}
                data-html2canvas-ignore="true"
            >
                <RotateCw className={`mr-1 h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
                Re-run
            </Button>
        );
    };

    const historyMetricValue = (metric: PageSpeedMetrics | undefined): React.ReactNode => {
        if (!metric) return <span>-</span>;
        return metric.displayValue || '-';
    };

    const formatRunTime = (fetchTime: string | undefined): string => {
        if (!fetchTime) return '-';
        const d = new Date(fetchTime);
        return isNaN(d.getTime()) ? '-' : d.toLocaleString();
    };

    const formatWindow = (start: Date, end: Date | null): string => {
        // Live windows recompute each second — the `elapsed` timer re-renders the component.
        const endMs = end ? end.getTime() : Date.now();
        const secs = Math.max(0, Math.round((endMs - start.getTime()) / 1000));
        const dur = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
        return `${start.toLocaleString()}${end ? ` – ${end.toLocaleString()}` : ''} · ${dur}`;
    };

    const scoreColor = (score: number | null): string => {
        if (score === null) return 'text-muted-foreground';
        if (score >= 0.9) return 'text-green-500';
        if (score >= 0.5) return 'text-orange-500';
        return 'text-red-500';
    };

    const severityIcon = (score: number | null): React.ReactNode => {
        if (score === null) return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
        if (score < 0.5) return <Triangle className="h-3.5 w-3.5 fill-red-500 text-red-500 shrink-0" />;
        if (score < 0.9) return <Square className="h-3.5 w-3.5 fill-orange-500 text-orange-500 shrink-0" />;
        return <Circle className="h-3.5 w-3.5 fill-green-500 text-green-500 shrink-0" />;
    };

    // Network-tree insight has no displayValue — its headline number is longestChain.duration.
    const networkMaxLatency = (details: PageSpeedOpportunity['details']): number | undefined => {
        const d = details as unknown as { items?: unknown; longestChain?: { duration?: number } } | undefined;
        if (!d) return undefined;
        const items = Array.isArray(d.items) ? d.items as Array<{ value?: { type?: string; longestChain?: { duration?: number } } } & { type?: string; longestChain?: { duration?: number } }> : [];
        for (const it of items) {
            const v = it?.value ?? it;
            if (v?.type === 'network-tree' && typeof v?.longestChain?.duration === 'number') return v.longestChain.duration;
        }
        return typeof d.longestChain?.duration === 'number' ? d.longestChain.duration : undefined;
    };

    const formatSavings = (o: PageSpeedOpportunity): string => {
        if (o.displayValue) return o.displayValue;
        const savings = o.metricSavings
            ? Object.entries(o.metricSavings)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `${k}: ${v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms'}`)
                .join(', ')
            : '';
        if (savings) return savings;
        const lat = networkMaxLatency(o.details);
        if (lat !== undefined) return `Max critical path latency: ${Math.round(lat).toLocaleString()} ms`;
        return '';
    };

    // Lighthouse descriptions are markdown — convert [text](url) links to anchors, drop the rest of the syntax.
    const renderDescription = (text: string): React.ReactNode => {
        const parts: React.ReactNode[] = [];
        const re = /\[([^\]]+)\]\(([^)]+)\)/g;
        let last = 0;
        let m: RegExpExecArray | null;
        let i = 0;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) parts.push(text.slice(last, m.index));
            parts.push(
                <a key={i++} href={m[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                    {m[1]}
                </a>,
            );
            last = m.index + m[0].length;
        }
        if (last < text.length) parts.push(text.slice(last));
        return parts;
    };

    const formatDetailCell = (value: unknown, valueType?: string): string => {
        let v: unknown = value;
        if (v && typeof v === 'object') {
            const o = v as Record<string, unknown>;
            v = o.value ?? o.url ?? o.text ?? o.snippet ?? o.name ?? '';
        }
        if (v === null || v === undefined || v === '') return '';
        if (typeof v === 'number') {
            if (valueType === 'bytes') return `${(v / 1024).toFixed(0)} KiB`;
            if (valueType === 'ms' || valueType === 'timespanMs') return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
            return String(v);
        }
        return String(v);
    };

    // ─── Network dependency tree (criticalrequestchain / network-tree insight) ───
    // Detail shape varies by Lighthouse version: old uses node.request.url + chains map,
    // newer insight uses node.url + navStartToEndTime. Stay defensive about field names.
    type TreeNode = {
        url?: string;
        navStartToEndTime?: number;
        transferSize?: number;
        isLongest?: boolean;
        request?: { url?: string; startTime?: number; endTime?: number; transferSize?: number };
        children?: Record<string, TreeNode> | TreeNode[];
    };

    const treeChains = (details: PageSpeedOpportunity['details']): TreeNode[] | null => {
        const chains = (details as unknown as { chains?: Record<string, TreeNode> | TreeNode[] } | undefined)?.chains;
        if (!chains) return null;
        const arr = Array.isArray(chains) ? chains : Object.values(chains);
        return arr.length ? arr : null;
    };

    const hasRenderableDetails = (details: PageSpeedOpportunity['details']): boolean => {
        if (!details) return false;
        const d = details as { type?: string; items?: unknown[]; headings?: unknown[] };
        if (d.type === 'list' && Array.isArray(d.items) && d.items.length > 0) return true;
        if ((details.headings?.length ?? 0) > 0 && (details.items?.length ?? 0) > 0) return true;
        return !!treeChains(details);
    };

    const childArray = (children: TreeNode['children']): TreeNode[] =>
        !children ? [] : Array.isArray(children) ? children : Object.values(children);

    const nodeUrl = (n: TreeNode): string => n.url || n.request?.url || '';
    const nodeSize = (n: TreeNode): number | undefined => n.transferSize ?? n.request?.transferSize;
    const nodeTime = (n: TreeNode): number | undefined => {
        if (typeof n.navStartToEndTime === 'number') return n.navStartToEndTime;
        const r = n.request;
        if (r && typeof r.endTime === 'number' && typeof r.startTime === 'number') return (r.endTime - r.startTime) * 1000;
        return undefined;
    };

    const fmtUrlParts = (u: string): { tail: string; host: string } => {
        try {
            const x = new URL(u);
            const segs = x.pathname.split('/').filter(Boolean);
            const lastTwo = segs.slice(-2).join('/');
            const truncated = segs.length > 2 || x.pathname.length > lastTwo.length + 1;
            let tail = lastTwo ? `${truncated ? '…/' : '/'}${lastTwo}` : (x.pathname || u);
            if (x.search) tail += x.search.length > 12 ? `${x.search.slice(0, 12)}…` : x.search;
            return { tail, host: x.host };
        } catch {
            return { tail: u, host: '' };
        }
    };

    const renderTreeNodes = (nodes: TreeNode[], depth: number, keyPrefix: string): React.ReactNode[] =>
        nodes.flatMap((n, i) => {
            const { tail, host } = fmtUrlParts(nodeUrl(n));
            const t = nodeTime(n);
            const sz = nodeSize(n);
            const k = `${keyPrefix}-${i}`;
            const longest = !!n.isLongest;
            const row = (
                <div key={k} className="flex items-baseline gap-2 py-0.5 leading-tight" style={{ paddingLeft: depth * 16 }}>
                    <span className={`break-all ${longest ? 'text-red-500' : 'text-foreground'}`}>
                        {depth > 0 && <span className="mr-1 text-muted-foreground">└</span>}
                        {tail}
                        {host && <span className="text-muted-foreground"> ({host})</span>}
                    </span>
                    <span className="ml-auto whitespace-nowrap text-muted-foreground">
                        {t !== undefined && <span className={`font-medium ${longest ? 'text-red-500' : 'text-foreground'}`}>{Math.round(t).toLocaleString()} ms</span>}
                        {sz !== undefined && <span>, {(sz / 1024).toFixed(2)} KiB</span>}
                    </span>
                </div>
            );
            return [row, ...renderTreeNodes(childArray(n.children), depth + 1, k)];
        });

    // Legacy: tree at details.chains directly (old criticalrequestchain shape)
    const renderNetworkTree = (details: PageSpeedOpportunity['details']): React.ReactNode => {
        const roots = treeChains(details);
        if (!roots) return null;
        return (
            <div className="overflow-auto rounded border border-border p-2 text-xs">
                {renderTreeNodes(roots, 0, 'n')}
            </div>
        );
    };

    // New insight 'network-tree' value: { chains: {...}, longestChain: { duration } }
    const renderNetworkTreeValue = (value: { chains?: Record<string, TreeNode>; longestChain?: { duration?: number } }): React.ReactNode => {
        const roots: TreeNode[] = value?.chains ? Object.values(value.chains) : [];
        if (!roots.length) return null;
        const maxLatency = value?.longestChain?.duration;
        return (
            <div className="overflow-auto rounded border border-border p-2 text-xs">
                {typeof maxLatency === 'number' && (
                    <p className="mb-1.5">Maximum critical path latency: <span className="font-medium text-foreground">{Math.round(maxLatency).toLocaleString()} ms</span></p>
                )}
                <p className="italic text-muted-foreground mb-1">Initial Navigation</p>
                {renderTreeNodes(roots, 0, 'n')}
            </div>
        );
    };

    type DetailHeading = { key: string; label?: string; valueType?: string };

    const renderHeadingsTable = (headings: DetailHeading[], itemsRaw: Record<string, unknown>[]): React.ReactNode => {
        const items = Array.isArray(itemsRaw) ? itemsRaw : [];
        if (!Array.isArray(headings) || !headings.length || !items.length) return null;
        return (
            <div className="overflow-auto rounded border border-border">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="border-b border-border bg-muted/40">
                            {headings.map((h, i) => (
                                <th key={i} className="text-left py-1 px-2 font-medium text-muted-foreground whitespace-nowrap">{h.label || h.key}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {items.slice(0, 50).map((item, ri) => (
                            <tr key={ri} className="border-b border-border/50 last:border-0">
                                {headings.map((h, ci) => (
                                    <td key={ci} className="py-1 px-2 align-top break-all">{formatDetailCell(item[h.key], h.valueType)}</td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
                {items.length > 50 && (
                    <p className="text-[10px] text-muted-foreground px-2 py-1">+{items.length - 50} more row(s) not shown</p>
                )}
            </div>
        );
    };

    // A list-section's typed `value` — network-tree, text, table, or scalar.
    const renderSectionValue = (value: unknown): React.ReactNode => {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'object') return <p className="text-xs text-muted-foreground">{String(value)}</p>;
        const v = value as Record<string, unknown>;
        switch (v.type) {
            case 'network-tree':
                return renderNetworkTreeValue(v as Parameters<typeof renderNetworkTreeValue>[0]);
            case 'text':
                return <p className="text-xs text-muted-foreground leading-relaxed">{renderDescription(String(v.value ?? ''))}</p>;
            case 'table':
                return renderHeadingsTable((v.headings as DetailHeading[]) ?? [], (v.items as Record<string, unknown>[]) ?? []);
            default: {
                const s = formatDetailCell(v);
                return s ? <p className="text-xs text-muted-foreground break-all">{s}</p> : null;
            }
        }
    };

    const renderDetailsTable = (details: PageSpeedOpportunity['details']): React.ReactNode => {
        if (!details) return null;
        const d = details as unknown as { type?: string; items?: unknown[]; headings?: DetailHeading[] };

        // New Lighthouse insight format: type 'list' whose items are either { value: <typed> }
        // (e.g. network-tree) or a typed object directly (e.g. { type: 'table', ... }).
        if (d.type === 'list' && Array.isArray(d.items)) {
            const items = d.items as Array<{ type?: string; title?: string; description?: string; value?: unknown }>;
            const rendered = items
                .map((it, i) => {
                    const body = renderSectionValue(it.value ?? it);
                    if (!body && !it.title && !it.description) return null;
                    return (
                        <div key={i}>
                            {it.title && <p className="text-xs font-semibold text-foreground mb-1">{it.title}</p>}
                            {it.description && <p className="text-xs text-muted-foreground mb-1 leading-relaxed">{renderDescription(String(it.description))}</p>}
                            {body}
                        </div>
                    );
                })
                .filter(Boolean);
            if (rendered.length) return <div className="space-y-3">{rendered}</div>;
        }

        // Legacy network tree at details.chains
        const tree = renderNetworkTree(details);
        if (tree) return tree;

        // Legacy headings + items table
        return renderHeadingsTable(d.headings ?? [], (details.items ?? []) as Record<string, unknown>[]);
    };

    const formatRunsSeen = (runs: number[], total: number): string => {
        if (runs.length === total) return `all ${total} runs`;
        const label = runs.length === 1 ? 'run' : 'runs';
        return `${label} ${runs.map(r => `#${r}`).join(', ')}`;
    };

    const renderInsightRow = (o: PageSpeedOpportunity, idPrefix: string, occurrence?: { runs: number[]; total: number }): React.ReactNode => {
        const key = `${idPrefix}-${o.auditKey ?? o.title}`;
        const open = expandedInsights.has(key);
        const savings = formatSavings(o);
        const hasDetail = !!o.description || hasRenderableDetails(o.details);
        const showRuns = occurrence && occurrence.total > 1 && occurrence.runs.length < occurrence.total;
        const metrics = o.metricSavings ? Object.keys(o.metricSavings) : [];
        return (
            <div key={key} className="border-b border-border last:border-0">
                <button
                    onClick={() => hasDetail && toggleInsight(key)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left ${hasDetail ? 'hover:bg-muted/40 cursor-pointer' : 'cursor-default'}`}
                >
                    {severityIcon(o.score)}
                    <span className="text-xs font-medium text-foreground">{o.title}</span>
                    {savings && <span className={`text-xs ${scoreColor(o.score)}`}>— {savings}</span>}
                    {metrics.map(m => (
                        <span key={m} className="text-[9px] uppercase tracking-wide px-1 py-px rounded border border-border text-muted-foreground">{m}</span>
                    ))}
                    {showRuns && <span className="text-[10px] text-muted-foreground">({formatRunsSeen(occurrence!.runs, occurrence!.total)})</span>}
                    {hasDetail && (
                        <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                    )}
                </button>
                {open && hasDetail && (
                    <div className="px-3 pb-3 pt-1 space-y-2">
                        {o.description && <p className="text-xs text-muted-foreground leading-relaxed">{renderDescription(o.description)}</p>}
                        {renderDetailsTable(o.details)}
                    </div>
                )}
            </div>
        );
    };

    const renderInsightGroup = (
        heading: string,
        items: PageSpeedOpportunity[],
        idPrefix: string,
        occurrences?: Record<string, { runs: number[]; total: number }>,
    ): React.ReactNode => {
        if (!items.length) return null;
        const groupKey = `group-${idPrefix}`;
        const open = expandedInsights.has(groupKey);
        return (
            <div className="mt-3">
                <button
                    onClick={() => toggleInsight(groupKey)}
                    className="flex items-center gap-1 mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground hover:text-foreground"
                >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                    {heading} ({items.length})
                </button>
                {open && (
                    <div className="border border-border rounded-md overflow-hidden bg-background">
                        {items.map(o => renderInsightRow(o, idPrefix, occurrences?.[o.auditKey ?? o.title]))}
                    </div>
                )}
            </div>
        );
    };

    const renderInsightsList = (
        opportunities: PageSpeedOpportunity[],
        idPrefix: string,
        label?: string,
        occurrences?: Record<string, { runs: number[]; total: number }>,
    ): React.ReactNode => {
        // Only keep insights that affect a metric currently shown as a column.
        const metricShown: Record<string, boolean> = {
            SI: displayAudit.SI, LCP: displayAudit.LCP, CLS: displayAudit.CLS, TBT: displayAudit.TBT, FCP: displayAudit.FCP,
        };
        const visible = opportunities.filter(o =>
            // Passing (green, score ≥ 0.9) insights are noise here — only surface actionable ones.
            !(o.score != null && o.score >= 0.9) &&
            // *-insight findings (e.g. forced reflow) aren't tied to a metric column — always show them.
            ((o.auditKey ?? '').endsWith('-insight') ||
            Object.keys(o.metricSavings ?? {}).some(m => metricShown[m])),
        );
        if (!visible.length) return null;
        return (
            <div className="mt-3">
                {label && <p className="text-xs font-semibold text-foreground">{label}</p>}
                {renderInsightGroup('PAGESPEED INSIGHTS', visible, `${idPrefix}-o`, occurrences)}
            </div>
        );
    };

    const renderInsights = (result: PageSpeedInsightResult, idPrefix: string, label?: string): React.ReactNode =>
        renderInsightsList((result.opportunities ?? []).filter(o => o.type === 'opportunity'), idPrefix, label);

    // Merge each run's insights into one set: dedupe by audit, keep the worst-scoring instance,
    // and track how many of the runs each audit appeared in.
    const consolidateRunInsights = (history: PageSpeedInsightResult[]): {
        opportunities: PageSpeedOpportunity[];
        occurrences: Record<string, { runs: number[]; total: number }>;
    } => {
        const total = history.length;
        const byKey = new Map<string, PageSpeedOpportunity>();
        const runsByKey: Record<string, number[]> = {};
        history.forEach((run, runIdx) => {
            for (const o of run.opportunities ?? []) {
                if (o.type !== 'opportunity') continue;
                const key = o.auditKey ?? o.title;
                (runsByKey[key] ??= []).push(runIdx + 1);
                const existing = byKey.get(key);
                if (!existing || (o.score ?? 0) < (existing.score ?? 0)) byKey.set(key, o);
            }
        });
        const occurrences: Record<string, { runs: number[]; total: number }> = {};
        for (const [key, runs] of Object.entries(runsByKey)) occurrences[key] = { runs, total };
        const opportunities = [...byKey.values()].sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
        return { opportunities, occurrences };
    };

    const renderConsolidatedInsights = (history: PageSpeedInsightResult[], idPrefix: string, label?: string): React.ReactNode => {
        const { opportunities, occurrences } = consolidateRunInsights(history);
        return renderInsightsList(opportunities, idPrefix, label, occurrences);
    };

    // ─── Claude before/after analysis ──────────────────────────────────────────

    const metricLine = (r: PageSpeedInsightResult | undefined): string => {
        if (!r) return '—';
        const parts: string[] = [];
        if (displayAudit.SI) parts.push(`SI ${r.speedIndex?.displayValue ?? '-'}`);
        if (displayAudit.LCP) parts.push(`LCP ${r.largestContentfulPaint?.displayValue ?? '-'}`);
        if (displayAudit.CLS) parts.push(`CLS ${r.cumulativeLayoutShift?.displayValue ?? '-'}`);
        if (displayAudit.TBT) parts.push(`TBT ${r.totalBlockingTime?.displayValue ?? '-'}`);
        if (displayAudit.FCP) parts.push(`FCP ${r.firstContentfulPaint?.displayValue ?? '-'}`);
        return parts.join(', ');
    };

    const insightsSummary = (history: PageSpeedInsightResult[] | undefined, result: PageSpeedInsightResult | undefined): string => {
        const list = history
            ? consolidateRunInsights(history).opportunities
            : (result?.opportunities ?? []).filter(o => o.type === 'opportunity');
        if (!list.length) return '(none)';
        return list.map(o => {
            const sv = formatSavings(o);
            const metrics = o.metricSavings ? Object.keys(o.metricSavings).join(', ') : '';
            return `- ${o.title}${sv ? ` — ${sv}` : ''}${metrics ? ` [affects: ${metrics}]` : ''}`;
        }).join('\n');
    };

    // PageSpeed Insights diagnostics — reference material for the Claude analysis
    // (deduped across runs, worst score kept).
    const diagnosticsSummary = (history: PageSpeedInsightResult[] | undefined, result: PageSpeedInsightResult | undefined): string => {
        const src = history?.length ? history.flatMap(r => r.opportunities ?? []) : (result?.opportunities ?? []);
        const diags = src.filter(o => o.type === 'diagnostic');
        if (!diags.length) return '(none)';
        const byKey = new Map<string, PageSpeedOpportunity>();
        for (const o of diags) {
            const key = o.auditKey ?? o.title;
            const existing = byKey.get(key);
            if (!existing || (o.score ?? 0) < (existing.score ?? 0)) byKey.set(key, o);
        }
        return [...byKey.values()]
            .sort((a, b) => (a.score ?? 1) - (b.score ?? 1))
            .map(o => {
                const metrics = o.metricSavings ? Object.keys(o.metricSavings).join(', ') : '';
                return `- ${o.title}${o.displayValue ? ` — ${o.displayValue}` : ''}${metrics ? ` [affects: ${metrics}]` : ''}`;
            })
            .join('\n');
    };

    const buildAnalysisSummary = (index: number): string => {
        const url = config.urls[index] ?? '';
        const r1 = getSlot1(index) || undefined;
        const r2 = getSlot2(index) || undefined;
        const h1 = r1?.runHistory;
        const h2 = r2?.runHistory;
        const runs = (h?: PageSpeedInsightResult[]) =>
            h ? h.map((run, i) => `#${i + 1}: ${metricLine(run)}`).join('\n') : '';

        const slot = (label: string, r: PageSpeedInsightResult | undefined, h?: PageSpeedInsightResult[]) => {
            let s = `### ${label}\nAggregate: ${metricLine(r)}\n`;
            if (h) s += `Individual runs:\n${runs(h)}\n`;
            s += `PageSpeed Insights opportunities:\n${insightsSummary(h, r)}\n`;
            s += `PageSpeed Insights diagnostics (reference):\n${diagnosticsSummary(h, r)}\n`;
            return s;
        };

        // Exact measurements appearing in BOTH before and after run sets (any run index) —
        // a strong hint of measurement noise / network jitter rather than a real change.
        const matchedSection = (() => {
            if (!h1?.length || !h2?.length) return '';
            const defs = [
                ['SI', 'speedIndex', displayAudit.SI],
                ['LCP', 'largestContentfulPaint', displayAudit.LCP],
                ['CLS', 'cumulativeLayoutShift', displayAudit.CLS],
                ['TBT', 'totalBlockingTime', displayAudit.TBT],
                ['FCP', 'firstContentfulPaint', displayAudit.FCP],
            ] as const;
            const lines: string[] = [];
            for (const [label, key, show] of defs) {
                if (!show) continue;
                const set1 = new Set(h1.map(r => r[key]?.displayValue).filter(Boolean) as string[]);
                const matches = [...new Set(h2.map(r => r[key]?.displayValue).filter(Boolean) as string[])].filter(v => set1.has(v));
                if (matches.length) lines.push(`- ${label}: ${matches.join(', ')}`);
            }
            if (!lines.length) return '';
            return [
                '',
                `### Cross-run identical values (${config.beforeLabel} vs ${config.afterLabel})`,
                'These exact measurements appear in BOTH the before and after run sets (at any run index):',
                lines.join('\n'),
                'Interpretation: identical values across before and after runs indicate measurement variance (network jitter, CDN/cache state, test-environment noise) rather than a real code-level change. Weigh the aggregate improvement or degradation cautiously against this — an apparent regression or gain overlapping these values may not be real.',
                '',
            ].join('\n');
        })();

        return [
            `URL: ${url}`,
            `Strategy: ${config.strategy}`,
            `Run mode: ${config.runMode}${isAccuracyMode && h1 ? ` (${h1.length} runs)` : ''}`,
            '',
            slot(config.beforeLabel, r1, h1),
            slot(config.afterLabel, r2, h2),
            matchedSection,
        ].join('\n');
    };

    const buildAllUrlsSummary = (): string => {
        const blocks = config.urls
            .map((_, i) => (getSlot1(i) && getSlot2(i) ? buildAnalysisSummary(i) : null))
            .filter(Boolean);
        return `Comparison across ${blocks.length} URL(s).\n\n${blocks.join('\n\n---\n\n')}`;
    };

    // key: a URL row index, or -1 for the combined all-URLs analysis.
    const startAnalysis = async (key: number, summary: string, label: string) => {
        setAnalyses(prev => ({ ...prev, [key]: { status: 'running', markdown: '', error: null } }));
        setExpandedInsights(prev => new Set(prev).add(`analysis-${key}`));
        const unsubscribe = window.electronAPI.pagespeedInsight.onAnalyzeChunk(({ chunk }) => {
            setAnalyses(prev => {
                const cur = prev[key];
                if (!cur) return prev;
                return { ...prev, [key]: { ...cur, markdown: cur.markdown + chunk } };
            });
        });
        try {
            const res = await window.electronAPI.pagespeedInsight.analyze({ url: label, summary });
            setAnalyses(prev => {
                const cur = prev[key];
                if (!cur) return prev;
                return {
                    ...prev,
                    [key]: res.success
                        ? { ...cur, status: 'done', markdown: res.analysis ?? cur.markdown }
                        : { ...cur, status: 'error', error: res.error ?? 'Analysis failed.' },
                };
            });
        } catch (err) {
            setAnalyses(prev => {
                const cur = prev[key];
                if (!cur) return prev;
                return { ...prev, [key]: { ...cur, status: 'error', error: err instanceof Error ? err.message : String(err) } };
            });
        } finally {
            unsubscribe();
        }
    };

    const runAnalysis = (index: number) => startAnalysis(index, buildAnalysisSummary(index), config.urls[index] ?? '');
    const runAllAnalysis = () => startAnalysis(-1, buildAllUrlsSummary(), `all ${config.urls.length} URLs`);

    // Build an AI-agent fix brief: the analysis + raw data + an instruction header for a coding agent.
    const buildBrief = (key: number): string => {
        const md = analyses[key]?.markdown ?? '';
        const data = key === -1 ? buildAllUrlsSummary() : buildAnalysisSummary(key);
        const title = `PageSpeed Fix Brief — ${config.strategy.toUpperCase()}${config.comparisonMode ? ` (${config.beforeLabel} vs ${config.afterLabel})` : ''}`;
        return [
            `# ${title}`,
            '',
            '> Generated by devForge PageSpeed. Hand this file to an AI coding agent (e.g. Claude Code) **run inside this repository**.',
            '> Use it to investigate the codebase and implement the performance fixes/enhancements described below.',
            '',
            '## Your Task',
            '1. Read the performance analysis and raw data below.',
            '2. For each issue, locate the responsible code in THIS repository (components, bundles, build config, headers, etc.).',
            '3. Propose a concrete fix or enhancement, then implement it.',
            '4. Prioritize regressions and high-impact, low-effort wins first; treat run-to-run noise as low priority.',
            '5. Keep changes scoped — do not alter unrelated behavior. Verify each change and note the expected metric impact.',
            '',
            '## Performance Analysis',
            md.trim() || '_No analysis was generated; rely on the raw data below._',
            '',
            '## Before / After Data & Insights',
            '```',
            data,
            '```',
        ].join('\n');
    };

    const createBrief = (key: number) => {
        const p = window.electronAPI.pagespeedInsight.saveBrief({ markdown: buildBrief(key) }).then(res => {
            if (res.canceled) return 'No folder selected';
            if (!res.success) throw new Error(res.error || 'Save failed');
            return 'Fix brief saved to project folder';
        });
        toast.promise(p, { loading: 'Creating fix brief…', success: (m: string) => m, error: (e: unknown) => (e instanceof Error ? e.message : 'Save failed') });
    };

    const renderAnalysisPanel = (key: number, run: () => void, buttonLabel: string, heading: string): React.ReactNode => {
        const ek = `analysis-${key}`;
        const open = expandedInsights.has(ek);
        const a = analyses[key];
        return (
            <div className="mt-3 border border-border rounded-md bg-background">
                <div className="flex items-center justify-between px-3 py-2">
                    <button
                        onClick={() => toggleInsight(ek)}
                        className="flex flex-1 items-center gap-1 text-[11px] font-semibold tracking-wide text-muted-foreground hover:text-foreground text-left"
                    >
                        <Sparkles className="h-3.5 w-3.5 text-primary" />
                        {heading}
                        <ChevronDown className={`ml-auto h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                    </button>
                    {a?.status === 'done' && (
                        <div className="flex items-center gap-1" data-html2canvas-ignore="true">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 text-muted-foreground"
                                onClick={() => createBrief(key)}
                                title="Save a fix brief into a project/repo folder for an AI coding agent"
                            >
                                <FileDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0 text-muted-foreground"
                                onClick={() => {
                                    const html = marked.parse(a.markdown, { async: false }) as string;
                                    const copy = navigator.clipboard.write([
                                        new ClipboardItem({
                                            'text/html': new Blob([html], { type: 'text/html' }),
                                            'text/plain': new Blob([a.markdown], { type: 'text/plain' }),
                                        }),
                                    ]);
                                    toast.promise(copy, { loading: 'Copying…', success: 'Copied for Teams', error: 'Copy failed' });
                                }}
                                title="Copy for Teams"
                            >
                                <Copy className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground" disabled={isAuditing} onClick={run} title="Re-run analysis">
                                <RotateCw className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    )}
                </div>
                {open && (
                    <div className="border-t border-border p-3 text-xs">
                        {!a && (
                            <Button variant="outline" size="sm" disabled={isAuditing} onClick={run} data-html2canvas-ignore="true">
                                <Sparkles className="mr-1.5 h-3.5 w-3.5 text-primary" />
                                {buttonLabel}
                            </Button>
                        )}
                        {a?.status === 'running' && (
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2 text-muted-foreground">
                                    <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                    {a.markdown ? 'Writing the performance analysis…' : 'Reviewing your before & after results…'}
                                </div>
                                {a.markdown && (
                                    <pre className="whitespace-pre-wrap border-t border-border pt-2 font-mono text-[11px] leading-relaxed text-foreground/80">{a.markdown}</pre>
                                )}
                            </div>
                        )}
                        {a?.status === 'error' && (
                            <div className="flex flex-col items-start gap-2">
                                <div className="flex items-center gap-2 text-destructive">
                                    <AlertTriangle className="h-4 w-4" />
                                    <span>{a.error || 'Something went wrong.'}</span>
                                </div>
                                <Button variant="outline" size="sm" onClick={run} data-html2canvas-ignore="true">
                                    <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
                                </Button>
                            </div>
                        )}
                        {a?.status === 'done' && (
                            <div className="ps-analysis-content" dangerouslySetInnerHTML={{ __html: marked.parse(a.markdown, { async: false }) as string }} />
                        )}
                    </div>
                )}
            </div>
        );
    };

    const renderAnalysisSection = (index: number): React.ReactNode => {
        if (!(config.comparisonMode && getSlot1(index) && getSlot2(index))) return null;
        return renderAnalysisPanel(index, () => runAnalysis(index), `Analyze ${config.beforeLabel} vs ${config.afterLabel}`, 'CLAUDE ANALYSIS');
    };

    // Values appearing in BOTH before and after run sets for a metric (any run index) —
    // highlighted to flag likely network jitter / measurement noise.
    const crossRunMatches = (index: number): Map<string, Set<string>> => {
        const map = new Map<string, Set<string>>();
        const h1 = (getSlot1(index) || undefined)?.runHistory ?? [];
        const h2 = (getSlot2(index) || undefined)?.runHistory ?? [];
        if (!h1.length || !h2.length) return map;
        const keys = ['speedIndex', 'largestContentfulPaint', 'cumulativeLayoutShift', 'totalBlockingTime', 'firstContentfulPaint'] as const;
        for (const key of keys) {
            const set1 = new Set(h1.map(r => r[key]?.displayValue).filter(Boolean) as string[]);
            const matches = new Set((h2.map(r => r[key]?.displayValue).filter(Boolean) as string[]).filter(v => set1.has(v)));
            if (matches.size) map.set(key, matches);
        }
        return map;
    };

    // Individual-runs metrics table. Insights are consolidated separately, below the table.
    const renderRunHistory = (history: PageSpeedInsightResult[], index: number, slotKey: '1' | '2'): React.ReactNode => {
        const matches = crossRunMatches(index);
        const hl = (key: 'speedIndex' | 'largestContentfulPaint' | 'cumulativeLayoutShift' | 'totalBlockingTime' | 'firstContentfulPaint', run: PageSpeedInsightResult): string =>
            matches.get(key)?.has(run[key]?.displayValue ?? '') ? ' italic font-semibold text-amber-400' : '';
        return (
            <table className="w-full text-xs">
                <thead>
                    <tr className="border-b border-border">
                        <th className="text-left py-1 px-2 font-medium text-muted-foreground w-px whitespace-nowrap">Run</th>
                        {displayAudit.SI && <th className="text-center py-1 px-2 font-medium text-muted-foreground">SI</th>}
                        {displayAudit.LCP && <th className="text-center py-1 px-2 font-medium text-muted-foreground">LCP</th>}
                        {displayAudit.CLS && <th className="text-center py-1 px-2 font-medium text-muted-foreground">CLS</th>}
                        {displayAudit.TBT && <th className="text-center py-1 px-2 font-medium text-muted-foreground">TBT</th>}
                        {displayAudit.FCP && <th className="text-center py-1 px-2 font-medium text-muted-foreground">FCP</th>}
                        {!copying && <th className="w-px" data-html2canvas-ignore="true" />}
                    </tr>
                </thead>
                <tbody>
                    {history.map((run, runIdx) => {
                        const rerunning = rerunningRuns.has(`${slotKey}-${index}-${runIdx}`);
                        return (
                            <tr key={runIdx} className="border-b border-border/50 last:border-0">
                                <td className="py-1 px-2 text-muted-foreground whitespace-nowrap w-px">
                                    #{runIdx + 1}<span className="ml-1 text-[10px] opacity-70">{formatRunTime(run.fetchTime)}</span>
                                </td>
                                {displayAudit.SI && <td className={`text-center py-1 px-2${hl('speedIndex', run)}`}>{historyMetricValue(run.speedIndex)}</td>}
                                {displayAudit.LCP && <td className={`text-center py-1 px-2${hl('largestContentfulPaint', run)}`}>{historyMetricValue(run.largestContentfulPaint)}</td>}
                                {displayAudit.CLS && <td className={`text-center py-1 px-2${hl('cumulativeLayoutShift', run)}`}>{historyMetricValue(run.cumulativeLayoutShift)}</td>}
                                {displayAudit.TBT && <td className={`text-center py-1 px-2${hl('totalBlockingTime', run)}`}>{historyMetricValue(run.totalBlockingTime)}</td>}
                                {displayAudit.FCP && <td className={`text-center py-1 px-2${hl('firstContentfulPaint', run)}`}>{historyMetricValue(run.firstContentfulPaint)}</td>}
                                {!copying && (
                                    <td className="py-1 px-2 w-px whitespace-nowrap text-right" data-html2canvas-ignore="true">
                                        <button
                                            onClick={() => rerunSingleRun(index, runIdx, slotKey)}
                                            disabled={isAuditing || isRetryingAny || rerunning}
                                            title={`Re-run run #${runIdx + 1}`}
                                            className="inline-flex items-center justify-center p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                        >
                                            <RotateCw className={`h-3.5 w-3.5 ${rerunning ? 'animate-spin' : ''}`} />
                                        </button>
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        );
    };

    // Calculate total column count for the history row's colSpan
    const totalColCount = (() => {
        const metricCount = [displayAudit.SI, displayAudit.LCP, displayAudit.CLS, displayAudit.TBT, displayAudit.FCP].filter(Boolean).length;
        const columnsPerMetric = displayAudit.singleResult ? 1 : (displayAudit.improvement ? 3 : 2);
        return 1 + metricCount * columnsPerMetric; // 1 for URL column
    })();

    const cellMetrics = (
        show: boolean,
        slot1: AuditSlot,
        slot2: AuditSlot,
        metrics1: PageSpeedMetrics | undefined,
        metrics2: PageSpeedMetrics | undefined,
    ): React.ReactNode => (
        <>
            {show && (
                <>
                    <TableCell className="text-center border">
                        {cellValue(slot1, metrics1)}
                    </TableCell>
                    {!displayAudit.singleResult && (
                        <TableCell className="text-center border">
                            {cellValue(slot2, metrics2)}
                        </TableCell>
                    )}
                    {!displayAudit.singleResult && displayAudit.improvement && (
                        <TableCell className="text-center border">
                            {metrics1 && metrics2
                                ? calculateImprovement(displayNum(metrics1), displayNum(metrics2))
                                : isAuditing
                                    ? <Loader2 className="animate-spin mx-auto" size={20} />
                                    : '-'}
                        </TableCell>
                    )}
                </>
            )}
        </>
    );

    return (
        <Card className={grouped ? 'my-4 mx-6 first:mt-6 last:mb-6 shadow-none' : 'my-4'} ref={elementRef}>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {config.strategy.toUpperCase()}
                    </div>
                    {!copying && showAnalyzeButton && (
                        <div className="flex items-center gap-2">
                            {config.comparisonMode && (
                                <>
                                    <Button variant="outline" onClick={audit1} disabled={isAuditing}>
                                        {auditing1 ? (
                                            <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
                                                <Loader2 className="animate-spin" size={14} />
                                                Analyzing {config.beforeLabel}
                                            </span>
                                        ) : (
                                            <>Analyze {config.beforeLabel}</>
                                        )}
                                    </Button>
                                    <Button variant="outline" onClick={audit2} disabled={isAuditing}>
                                        {auditing2 ? (
                                            <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
                                                <Loader2 className="animate-spin" size={14} />
                                                Analyzing {config.afterLabel}
                                            </span>
                                        ) : (
                                            <>Analyze {config.afterLabel}</>
                                        )}
                                    </Button>
                                </>
                            )}
                            {!config.comparisonMode && (
                                <Button variant="outline" onClick={audit1} disabled={isAuditing}>
                                    {auditing1 ? (
                                        <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
                                            <Loader2 className="animate-spin" size={14} />
                                            Analyzing...
                                        </span>
                                    ) : (
                                        <>Analyze</>
                                    )}
                                </Button>
                            )}
                            {isAuditing && (
                                <Button variant="outline" onClick={() => abortControllerRef.current?.abort()}>
                                    Cancel
                                </Button>
                            )}
                            {config.comparisonMode && config.urls.some((_, i) => getSlot1(i) && getSlot2(i)) && (
                                <Button
                                    variant="outline"
                                    onClick={runAllAnalysis}
                                    disabled={isAuditing || analyses[-1]?.status === 'running'}
                                >
                                    <Sparkles className="mr-1 h-4 w-4 text-primary" />
                                    Claude Analysis
                                </Button>
                            )}
                            {config.urls.some((_, i) => getSlot1(i) || getSlot2(i)) && (
                                <Button variant="outline" onClick={copyForTeams} disabled={copying}>
                                    <Copy className="mr-1 h-4 w-4" />
                                    Copy for Teams
                                </Button>
                            )}
                            <Button variant="outline" onClick={onCopyAsImage} disabled={copying || isAuditing}>
                                Copy as Image
                            </Button>
                        </div>
                    )}
                </CardTitle>
            </CardHeader>
            <CardContent>
                <div className="overflow-auto rounded-md border scrollable-content [&_table]:border-collapse [&_th]:border [&_th]:border-border [&_td]:border [&_td]:border-border">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                {/* sticky URL header — uses inset box-shadow instead of border
                                    because the sticky bg-background paints over real borders  */}
                                <TableHead
                                    rowSpan={hasSubHead ? 2 : 1}
                                    className={`text-center sticky left-0 bg-background align-middle ${stickyBorder}`}
                                >
                                    URL
                                </TableHead>
                                {displayAudit.SI && tableHead('SI')}
                                {displayAudit.LCP && tableHead('LCP')}
                                {displayAudit.CLS && tableHead('CLS')}
                                {displayAudit.TBT && tableHead('TBT')}
                                {displayAudit.FCP && tableHead('FCP')}
                            </TableRow>
                            {hasSubHead && (
                                <TableRow>{tableSubHead()}</TableRow>
                            )}
                        </TableHeader>
                        <TableBody>
                            {config.urls.map((url, index) => {
                                const slot1 = getSlot1(index);
                                const slot2 = getSlot2(index);
                                const result1 = slot1 || undefined;
                                const result2 = slot2 || undefined;
                                const history1 = result1?.runHistory;
                                const history2 = result2?.runHistory;
                                const hasHistory = isAccuracyMode && (history1 || history2);
                                const hasInsights = !!(
                                    result1?.opportunities?.some(o => o.type === 'opportunity') ||
                                    result2?.opportunities?.some(o => o.type === 'opportunity')
                                );
                                // Single-run rows expand too, so each slot's Re-run is always reachable.
                                const hasSingleRun = !isAccuracyMode && !!(result1 || result2);
                                const hasDrawer = hasHistory || hasInsights || hasSingleRun;
                                const isExpanded = expandedHistory.has(index);

                                return (
                                    <React.Fragment key={index}>
                                        <TableRow>
                                            {/* sticky URL cell — same inset box-shadow trick */}
                                            <TableCell className={`sticky left-0 bg-background z-10 w-1/3 ${stickyBorder}`}>
                                                <div className="flex items-start gap-1">
                                                    {!copying && hasDrawer && (
                                                        <button
                                                            onClick={() => toggleHistory(index)}
                                                            className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-muted transition-colors"
                                                            title={isExpanded ? 'Hide details' : 'Show details'}
                                                        >
                                                            <ChevronDown
                                                                className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                                                            />
                                                        </button>
                                                    )}
                                                    <div className="flex-1">
                                                        <a href={url} target="_blank" rel="noopener noreferrer" className="break-all">
                                                            {url}
                                                        </a>
                                                        {getResultMessageForUrl(slot1, slot2)}
                                                        {!copying && (slotHasError(slot1) || slotHasError(slot2)) && (
                                                            <div className="flex items-center gap-1 mt-1">
                                                                <span className="text-xs text-destructive">Audit failed.</span>
                                                                {retryButton(index, slot1, setResults1, '1')}
                                                                {!displayAudit.singleResult && retryButton(index, slot2, setResults2, '2')}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </TableCell>

                                            {cellMetrics(displayAudit.SI, slot1, slot2, result1?.speedIndex, result2?.speedIndex)}
                                            {cellMetrics(displayAudit.LCP, slot1, slot2, result1?.largestContentfulPaint, result2?.largestContentfulPaint)}
                                            {cellMetrics(displayAudit.CLS, slot1, slot2, result1?.cumulativeLayoutShift, result2?.cumulativeLayoutShift)}
                                            {cellMetrics(displayAudit.TBT, slot1, slot2, result1?.totalBlockingTime, result2?.totalBlockingTime)}
                                            {cellMetrics(displayAudit.FCP, slot1, slot2, result1?.firstContentfulPaint, result2?.firstContentfulPaint)}
                                        </TableRow>

                                        {/* Details drawer row */}
                                        {hasDrawer && isExpanded && (
                                            <TableRow className="bg-muted/30">
                                                <TableCell colSpan={totalColCount} className="p-0">
                                                    <div className="px-4 py-3">
                                                        {/* Slot 1: runs table + consolidated insights across those runs */}
                                                        {history1 && (() => {
                                                            const cardKey = `runs-${index}-1`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className={`rounded-md border border-border bg-background p-3 ${history2 ? 'mb-3' : ''}`}>
                                                                <button onClick={() => toggleRunCard(cardKey)} className="flex w-full items-center gap-1 text-left mb-1.5">
                                                                    <p className="text-xs font-medium text-muted-foreground">{displayAudit.singleResult ? 'Individual Runs' : `${config.beforeLabel} — Individual Runs`}</p>
                                                                    <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                </button>
                                                                {cardOpen && (
                                                                    <>
                                                                        {renderRunHistory(history1, index, '1')}
                                                                        {renderConsolidatedInsights(history1, `${index}-1`, undefined)}
                                                                    </>
                                                                )}
                                                            </div>
                                                            );
                                                        })()}

                                                        {/* Slot 2 (comparison mode) */}
                                                        {history2 && !displayAudit.singleResult && (() => {
                                                            const cardKey = `runs-${index}-2`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className="rounded-md border border-border bg-background p-3">
                                                                <button onClick={() => toggleRunCard(cardKey)} className="flex w-full items-center gap-1 text-left mb-1.5">
                                                                    <p className="text-xs font-medium text-muted-foreground">{config.afterLabel} — Individual Runs</p>
                                                                    <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                </button>
                                                                {cardOpen && (
                                                                    <>
                                                                        {renderRunHistory(history2, index, '2')}
                                                                        {renderConsolidatedInsights(history2, `${index}-2`, undefined)}
                                                                    </>
                                                                )}
                                                            </div>
                                                            );
                                                        })()}

                                                        {/* Single-run slots (no run history): per-slot label + Re-run, then insights */}
                                                        {!history1 && result1 && (() => {
                                                            const cardKey = `single-${index}-1`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className="mt-3 rounded-md border border-border bg-background p-3">
                                                                <div className="mb-1.5 flex items-center gap-2">
                                                                    <button onClick={() => toggleRunCard(cardKey)} className="flex flex-1 items-center gap-2 text-left">
                                                                        <p className="text-xs font-semibold text-foreground">{displayAudit.singleResult ? 'Details' : config.beforeLabel}</p>
                                                                        <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                    </button>
                                                                    {singleRunRerunButton(index, setResults1, '1')}
                                                                </div>
                                                                {cardOpen && renderInsights(result1, `${index}-1`)}
                                                            </div>
                                                            );
                                                        })()}

                                                        {!history2 && result2 && !displayAudit.singleResult && (() => {
                                                            const cardKey = `single-${index}-2`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className="mt-3 rounded-md border border-border bg-background p-3">
                                                                <div className="mb-1.5 flex items-center gap-2">
                                                                    <button onClick={() => toggleRunCard(cardKey)} className="flex flex-1 items-center gap-2 text-left">
                                                                        <p className="text-xs font-semibold text-foreground">{config.afterLabel}</p>
                                                                        <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                    </button>
                                                                    {singleRunRerunButton(index, setResults2, '2')}
                                                                </div>
                                                                {cardOpen && renderInsights(result2, `${index}-2`)}
                                                            </div>
                                                            );
                                                        })()}

                                                        {/* Claude before/after analysis (comparison mode, both sides audited) */}
                                                        {!copying && renderAnalysisSection(index)}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
                <style>{`
                    .ps-analysis-content { font-size: 12px; line-height: 1.6; color: hsl(var(--foreground)); }
                    .ps-analysis-content > *:first-child { margin-top: 0; }
                    .ps-analysis-content h1 { font-size: 1.1rem; font-weight: 700; margin: 0 0 .5rem; }
                    .ps-analysis-content h2 { font-size: 1rem; font-weight: 700; margin: 1rem 0 .4rem; padding-bottom: .2rem; border-bottom: 1px solid hsl(var(--border)); }
                    .ps-analysis-content h3 { font-size: .9rem; font-weight: 600; margin: .8rem 0 .3rem; }
                    .ps-analysis-content p { margin: .4rem 0; }
                    .ps-analysis-content ul, .ps-analysis-content ol { margin: .4rem 0; padding-left: 1.25rem; }
                    .ps-analysis-content li { margin: .15rem 0; }
                    .ps-analysis-content code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .85em; background: hsl(var(--muted)); padding: .1em .35em; border-radius: 4px; }
                    .ps-analysis-content table { width: 100%; border-collapse: collapse; margin: .4rem 0; font-size: 11px; }
                    .ps-analysis-content th, .ps-analysis-content td { border: 1px solid hsl(var(--border)); padding: 4px 7px; text-align: left; vertical-align: top; }
                    .ps-analysis-content th { background: hsl(var(--muted)); font-weight: 600; }
                    .ps-analysis-content a { color: hsl(var(--primary)); }
                    .ps-analysis-content blockquote { border-left: 3px solid hsl(var(--border)); padding-left: .6rem; color: hsl(var(--muted-foreground)); margin: .4rem 0; }
                `}</style>
                {analyses[-1] &&
                    renderAnalysisPanel(-1, runAllAnalysis, `Analyze all ${config.urls.length} URLs (${config.beforeLabel} vs ${config.afterLabel})`, 'CLAUDE ANALYSIS — ALL URLS')}
                {(times1.start || times2.start) && (
                    <div className="mt-2 text-right text-xs text-muted-foreground space-y-0.5">
                        {config.comparisonMode ? (
                            <>
                                {times1.start && <div><span className="font-medium">{config.beforeLabel}:</span> {formatWindow(times1.start, times1.end)}</div>}
                                {times2.start && <div><span className="font-medium">{config.afterLabel}:</span> {formatWindow(times2.start, times2.end)}</div>}
                            </>
                        ) : (
                            times1.start && <div>{formatWindow(times1.start, times1.end)}</div>
                        )}
                    </div>
                )}
            </CardContent>
        </Card>
    );
});

export default PageSpeedResults;