import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { usePageSpeedInsight } from '../../hooks/usePageSpeedInsight';
import { ChevronDown, ChevronRight, Loader2, RotateCcw } from 'lucide-react';
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button, Toast } from '../ui';
import type { PageSpeedInsightResult, PageSpeedMetrics, PageSpeedConfiguration, PageSpeedInsightResultMessage } from '@shared/types/pageSpeedInsight.types';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { displayPageSpeedAudit, getPageSpeedInsightResultMessages } from '@/lib/pageSpeedUtils';
import { isNullOrEmpty } from '@shared/utils/stringHelper';
type AuditSlot = PageSpeedInsightResult | null | false | undefined;

export interface PageSpeedResultsHandle {
    startAudit: () => void;
    cancelAudit: () => void;
    getResults: () => {
        results1: AuditSlot[];
        results2: AuditSlot[];
        config: PageSpeedConfiguration;
        auditStart: Date | null;
        auditEnd: Date | null;
    };
}

interface PageSpeedResultsProps {
    config: PageSpeedConfiguration;
    onAuditingChange?: (isAuditing: boolean) => void;
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
                {expanded ? <ChevronDown size={14} className="mr-1 inline" /> : <ChevronRight size={14} className="mr-1 inline" />}
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

export const PageSpeedResults = React.forwardRef<PageSpeedResultsHandle, PageSpeedResultsProps>(({ config, onAuditingChange }, ref) => {
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
    const [expandedHistory, setExpandedHistory] = useState<Set<number>>(new Set());
    const abortControllerRef = useRef<AbortController | null>(null);
    const activeAuditsRef = useRef(0);
    const [auditStart, setAuditStart] = useState<Date | null>(null);
    const [auditEnd, setAuditEnd] = useState<Date | null>(null);
    const [elapsed, setElapsed] = useState(0);
    const isAuditing = auditing1 || auditing2;
    const isRetryingAny = retryingRows.size > 0;
    const timerActive = isAuditing || isRetryingAny;

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

    const setAuditingWithCallback = (
        setter: React.Dispatch<React.SetStateAction<boolean>>,
        value: boolean,
        otherAuditing: boolean,
    ) => {
        setter(value);
        onAuditingChange?.(value || otherAuditing);
    };

    const MAX_RETRIES = 2;

    const auditWithRetry = useCallback(async (url: string, signal?: AbortSignal): Promise<PageSpeedInsightResult> => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await audit(url, signal);
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
    ): Promise<void> => {
        const controller = new AbortController();
        abortControllerRef.current = controller;
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
            activeAuditsRef.current--;
            if (activeAuditsRef.current === 0) setAuditEnd(new Date());
            setAuditingWithCallback(setAuditing, false, otherAuditing);
        }
    };

    const audit1 = () => runAudit(setResults1, setAuditing1, auditing2);
    const audit2 = () => runAudit(setResults2, setAuditing2, auditing1);

    useImperativeHandle(ref, () => ({
        startAudit: audit1,
        cancelAudit: () => abortControllerRef.current?.abort(),
        getResults: () => ({ results1, results2, config, auditStart, auditEnd }),
    }));

    const retryRow = useCallback(async (
        index: number,
        setResults: React.Dispatch<React.SetStateAction<AuditSlot[]>>,
        slotKey: '1' | '2',
    ) => {
        const url = config.urls[index];
        if (!url) return;

        const rowKey = `${slotKey}-${index}`;
        if (activeAuditsRef.current === 0) setAuditEnd(null);
        activeAuditsRef.current++;
        setRetryingRows(prev => new Set(prev).add(rowKey));
        setResults(prev => {
            const next = [...prev];
            next[index] = null;
            return next;
        });

        try {
            const result = await auditWithRetry(url);
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
            activeAuditsRef.current--;
            if (activeAuditsRef.current === 0) setAuditEnd(new Date());
            setRetryingRows(prev => {
                const next = new Set(prev);
                next.delete(rowKey);
                return next;
            });
        }
    }, [auditWithRetry, config.urls]);

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
            >
                <RotateCcw className={`h-2 w-2 ${isRetrying ? 'animate-spin' : ''}`} />
            </Button>
        );
    };

    const historyMetricValue = (metric: PageSpeedMetrics | undefined): React.ReactNode => {
        if (!metric) return <span>-</span>;
        return metric.displayValue || '-';
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
                            {isAuditing
                                ? <Loader2 className="animate-spin mx-auto" size={20} />
                                : metrics1 && metrics2
                                    ? calculateImprovement(metrics1.numericValue, metrics2.numericValue)
                                    : '-'}
                        </TableCell>
                    )}
                </>
            )}
        </>
    );

    return (
        <Card className="my-4" ref={elementRef}>
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
                                const isExpanded = expandedHistory.has(index);

                                return (
                                    <React.Fragment key={index}>
                                        <TableRow>
                                            {/* sticky URL cell — same inset box-shadow trick */}
                                            <TableCell className={`sticky left-0 bg-background z-10 w-1/3 ${stickyBorder}`}>
                                                <div className="flex items-start gap-1">
                                                    {!copying && hasHistory && (
                                                        <button
                                                            onClick={() => toggleHistory(index)}
                                                            className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-muted transition-colors"
                                                            title={isExpanded ? 'Hide run history' : 'Show run history'}
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

                                        {/* History drawer row */}
                                        {hasHistory && isExpanded && (
                                            <TableRow className="bg-muted/30">
                                                <TableCell colSpan={totalColCount} className="p-0">
                                                    <div className="px-4 py-3">
                                                        {/* Slot 1 history */}
                                                        {history1 && (
                                                            <div className={history2 ? 'mb-3' : ''}>
                                                                {!displayAudit.singleResult && (
                                                                    <p className="text-xs font-medium text-muted-foreground mb-1.5">{config.beforeLabel} — Individual Runs</p>
                                                                )}
                                                                <table className="w-full text-xs">
                                                                    <thead>
                                                                        <tr className="border-b border-border">
                                                                            <th className="text-center py-1 px-2 font-medium text-muted-foreground">Run</th>
                                                                            {displayAudit.SI && <th className="text-center py-1 px-2 font-medium text-muted-foreground">SI</th>}
                                                                            {displayAudit.LCP && <th className="text-center py-1 px-2 font-medium text-muted-foreground">LCP</th>}
                                                                            {displayAudit.CLS && <th className="text-center py-1 px-2 font-medium text-muted-foreground">CLS</th>}
                                                                            {displayAudit.TBT && <th className="text-center py-1 px-2 font-medium text-muted-foreground">TBT</th>}
                                                                            {displayAudit.FCP && <th className="text-center py-1 px-2 font-medium text-muted-foreground">FCP</th>}
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {history1.map((run, runIdx) => (
                                                                            <tr key={runIdx} className="border-b border-border/50 last:border-0">
                                                                                <td className="text-center py-1 px-2 text-muted-foreground">#{runIdx + 1}</td>
                                                                                {displayAudit.SI && <td className="text-center py-1 px-2">{historyMetricValue(run.speedIndex)}</td>}
                                                                                {displayAudit.LCP && <td className="text-center py-1 px-2">{historyMetricValue(run.largestContentfulPaint)}</td>}
                                                                                {displayAudit.CLS && <td className="text-center py-1 px-2">{historyMetricValue(run.cumulativeLayoutShift)}</td>}
                                                                                {displayAudit.TBT && <td className="text-center py-1 px-2">{historyMetricValue(run.totalBlockingTime)}</td>}
                                                                                {displayAudit.FCP && <td className="text-center py-1 px-2">{historyMetricValue(run.firstContentfulPaint)}</td>}
                                                                            </tr>
                                                                        ))}
                                                                    </tbody>
                                                                </table>
                                                            </div>
                                                        )}

                                                        {/* Slot 2 history (comparison mode) */}
                                                        {history2 && !displayAudit.singleResult && (
                                                            <div>
                                                                <p className="text-xs font-medium text-muted-foreground mb-1.5">{config.afterLabel} — Individual Runs</p>
                                                                <table className="w-full text-xs">
                                                                    <thead>
                                                                        <tr className="border-b border-border">
                                                                            <th className="text-center py-1 px-2 font-medium text-muted-foreground">Run</th>
                                                                            {displayAudit.SI && <th className="text-center py-1 px-2 font-medium text-muted-foreground">SI</th>}
                                                                            {displayAudit.LCP && <th className="text-center py-1 px-2 font-medium text-muted-foreground">LCP</th>}
                                                                            {displayAudit.CLS && <th className="text-center py-1 px-2 font-medium text-muted-foreground">CLS</th>}
                                                                            {displayAudit.TBT && <th className="text-center py-1 px-2 font-medium text-muted-foreground">TBT</th>}
                                                                            {displayAudit.FCP && <th className="text-center py-1 px-2 font-medium text-muted-foreground">FCP</th>}
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {history2.map((run, runIdx) => (
                                                                            <tr key={runIdx} className="border-b border-border/50 last:border-0">
                                                                                <td className="text-center py-1 px-2 text-muted-foreground">#{runIdx + 1}</td>
                                                                                {displayAudit.SI && <td className="text-center py-1 px-2">{historyMetricValue(run.speedIndex)}</td>}
                                                                                {displayAudit.LCP && <td className="text-center py-1 px-2">{historyMetricValue(run.largestContentfulPaint)}</td>}
                                                                                {displayAudit.CLS && <td className="text-center py-1 px-2">{historyMetricValue(run.cumulativeLayoutShift)}</td>}
                                                                                {displayAudit.TBT && <td className="text-center py-1 px-2">{historyMetricValue(run.totalBlockingTime)}</td>}
                                                                                {displayAudit.FCP && <td className="text-center py-1 px-2">{historyMetricValue(run.firstContentfulPaint)}</td>}
                                                                            </tr>
                                                                        ))}
                                                                    </tbody>
                                                                </table>
                                                            </div>
                                                        )}
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
                {auditStart && (
                    <div className="mt-2 text-right text-xs text-muted-foreground">
                        {auditStart.toLocaleString()}{auditEnd ? ` – ${auditEnd.toLocaleString()}` : ''}
                        {' · '}
                        {(() => {
                            const secs = auditEnd
                                ? Math.round((auditEnd.getTime() - auditStart.getTime()) / 1000)
                                : elapsed;
                            return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
                        })()}
                    </div>
                )}
            </CardContent>
        </Card>
    );
});

export default PageSpeedResults;