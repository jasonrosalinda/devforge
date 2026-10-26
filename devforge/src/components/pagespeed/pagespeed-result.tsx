import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { usePageSpeedInsight } from '../../hooks/usePageSpeedInsight';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, Triangle, Square, Circle, RotateCw, AlertTriangle, ArrowUp, Copy, Play, Snowflake, CircleAlert, CircleCheck, CircleHelp, Waves, Equal, Info, X, Ban, Image as ImageIcon } from 'lucide-react';
import { marked } from 'marked';

type AnalysisStatus = 'running' | 'done' | 'error';
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button, Toast } from '../ui';
import { Hint } from '../ui/hint';
import type { PageSpeedInsightResult, PageSpeedMetrics, PageSpeedConfiguration, PageSpeedInsightResultMessage, PageSpeedOpportunity } from '@shared/types/pageSpeedInsight.types';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { displayPageSpeedAudit, getPageSpeedInsightResultMessages, aggregatePageSpeedInsightResults, allRunsFailed, improvementPercent, absoluteChange, zeroBaseline, zeroBaselineFloor, excessOverTargets, findDegradingRuns, mapUrlsToPreviousIndexes, describePageSpeedTestEnvironment, realignIndexSet, realignIndexedRecord, realignSlots, resultHasError, type ComparableMetricKey } from '@/lib/pageSpeedUtils';
import { buildEvidenceDiffSection } from '@/lib/pagespeedEvidenceDiff';
import { auditErrorText, cachedAttemptsByRun, describeReauditRun, detectWarmUp, explainSpike, flaggedAfterRuns, isRunFlagged, metricVerdict, nextReauditRun, reauditStallCause, reauditStalled, type MetricVerdict, type MetricVerdictResult, type ReauditRunReport } from '@/lib/pagespeedRunForensics';
import { RunSpreadStrip } from './run-spread-strip';
import { CopyForTeamsButton } from './copy-for-teams-button';
import { breakableUrlLink } from '@/lib/teams-html';
import { teamsCopyHeader, urlLabels } from '@/lib/pagespeed-teams-copy';
import { consolidateInsights, diffInsights, insightKey, type InsightChange, type InsightSet } from '@/lib/pagespeed-insight-diff';
import { isNullOrEmpty } from '@shared/utils/stringHelper';
import { Skeleton } from '@/components/ui/skeleton';
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
    restoreSnapshot: (snapshot: StrategySnapshot, urls: string[]) => void;
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

    const summaryColor = hasErrors ? 'text-error' : 'text-warning';

    return (
        <div className="mt-1">
            <Hint label={expanded ? 'Hide the errors and warnings from this run' : 'Show the errors and warnings from this run'}>
            <button onClick={() => setIsExpanded(!isExpanded)} className={`flex items-center text-xs hover:opacity-80 transition-opacity ${summaryColor}`}>
                {expanded ? <ChevronDown size={14} className="mr-1 inline" data-html2canvas-ignore="true" /> : <ChevronRight size={14} className="mr-1 inline" data-html2canvas-ignore="true" />}
                {warningCount > 0 && `${warningCount} warning(s)`}
                {warningCount > 0 && errorCount > 0 && ' / '}
                {errorCount > 0 && `${errorCount} error(s)`}
            </button>
            </Hint>
            {expanded && (
                <div className="ml-4 mt-2 space-y-2">
                    {unparsed.map((p, i) => (
                        <p key={`u-${i}`} className={`text-xs ${p.isError ? 'text-error' : 'text-warning'}`}>* {p.message}</p>
                    ))}
                    {Object.entries(groups).map(([groupName, groupMessages], i) => (
                        <div key={i} className="space-y-1">
                            <div className="text-xs font-semibold text-muted-foreground">{groupName}</div>
                            <div className="pl-2 border-l border-border space-y-1">
                                {groupMessages.map((m, j) => (
                                    <p key={j} className={`text-xs ${m.isError ? 'text-error' : 'text-warning'}`}>* {m.message}</p>
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
    const { audit } = usePageSpeedInsight(config);
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
    // Re-audit of flagged runs: row key → the run and attempt in flight (both 1-based).
    const [reauditProgress, setReauditProgress] = useState<Record<string, { run: number; attempt: number }>>({});
    // Re-audit outcome, shown inside the After card until dismissed or the next audit —
    // a toast is too easy to miss once the user has scrolled to another row.
    const [reauditNotice, setReauditNotice] = useState<Record<string, { tone: 'success' | 'info' | 'warning'; text: string; details: string[]; cachedRuns: ReturnType<typeof cachedAttemptsByRun> }>>({});
    const dismissReauditNotice = (key: string) => setReauditNotice(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
    });
    const reauditCancelRef = useRef<Set<string>>(new Set());
    const [expandedHistory, setExpandedHistory] = useState<Set<number>>(new Set());
    const [expandedInsights, setExpandedInsights] = useState<Set<string>>(new Set());
    // Drawer Before/After cards — collapsed keys (default open).
    const [collapsedRunCards, setCollapsedRunCards] = useState<Set<string>>(new Set());
    const toggleRunCard = (key: string) => setCollapsedRunCards(prev => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key); else next.add(key);
        return next;
    });
    // Per-run warning/error lists inside the Individual Runs table — collapsed by default.
    const [expandedRunMessages, setExpandedRunMessages] = useState<Set<string>>(new Set());
    const toggleRunMessages = (key: string) => setExpandedRunMessages(prev => {
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
    const isAuditing = auditing1 || auditing2;
    const isRetryingAny = retryingRows.size > 0;
    // One re-audit at a time — each can fire up to 3 audits per flagged run.
    const isReauditingAny = Object.keys(reauditProgress).length > 0;

    // Let the parent re-evaluate results-dependent UI (e.g. header "Copy as Table" button)
    // whenever this strategy's results change — refs alone don't trigger parent re-renders.
    useEffect(() => {
        onResultsChange?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [results1, results2]);

    // Results, analyses and expanded rows are all stored positionally against `config.urls`.
    // Editing the list (removing a URL, reordering) would otherwise slide every later row's
    // numbers onto the wrong URL, so carry each row's data to its new position by URL.
    const urlsRef = useRef(config.urls);
    useEffect(() => {
        const prevUrls = urlsRef.current;
        if (prevUrls.length === config.urls.length && prevUrls.every((u, i) => u === config.urls[i])) return;
        urlsRef.current = config.urls;
        const indexMap = mapUrlsToPreviousIndexes(prevUrls, config.urls);
        setResults1(prev => realignSlots(prev, indexMap));
        setResults2(prev => realignSlots(prev, indexMap));
        setAnalyses(prev => realignIndexedRecord(prev, indexMap));
        setExpandedHistory(prev => realignIndexSet(prev, indexMap));
        // Open/collapsed drawer state is keyed by `index-...` strings, so a shifted row
        // would inherit a neighbour's toggles. Cheaper to reset than to re-key.
        setExpandedInsights(new Set());
        setCollapsedRunCards(new Set());
        setExpandedRunMessages(new Set());
    }, [config.urls]);

    // Aggregation only applies when a URL's runs collapse into one row, which happens at
    // audit time — so switching Average↔Median afterwards has to recompute the stored rows
    // from their run history, otherwise the table keeps showing the old statistic until a re-run.
    const aggregationRef = useRef(config.aggregation);
    useEffect(() => {
        if (aggregationRef.current === config.aggregation) return;
        aggregationRef.current = config.aggregation;
        const reaggregate = (slots: AuditSlot[]): AuditSlot[] => slots.map(slot => {
            if (!slot || typeof slot !== 'object') return slot;
            const history = slot.runHistory;
            if (!history || history.length < 2) return slot;
            return aggregatePageSpeedInsightResults(slot.url, history, config.aggregation);
        });
        setResults1(prev => reaggregate(prev));
        setResults2(prev => reaggregate(prev));
    }, [config.aggregation]);

    const displayAudit = displayPageSpeedAudit(config);
    const showAnalyzeButton = config.urls.length > 0 && !isNullOrEmpty(config.apiKey);
    const toast = Toast();
    // Columns drawn for each metric. Comparison mode can show one side only, so this
    // is a count of what is actually visible rather than a 1-vs-3 guess.
    const columnsPerMetric = displayAudit.singleResult
        ? 1
        : [displayAudit.before, displayAudit.after, displayAudit.improvement].filter(Boolean).length;
    // Only a two-sided comparison needs a label under each metric. With one side hidden
    // every label would read the same, so the row carries no information and goes.
    const hasSubHead = !!(displayAudit.before && displayAudit.after);
    // Which run each expanded row may show. Hiding a comparison column hides that run
    // everywhere, so the detail below a URL matches the columns above it.
    const showSide1 = displayAudit.singleResult || displayAudit.before;
    const showSide2 = displayAudit.after;
    const isMultiRun = config.runs > 1;


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

    /**
     * Re-runs an audit until it produces something usable, at most MAX_RETRIES times.
     *
     * Two kinds of failure have to be caught here, and only one of them throws. A
     * transport error rejects; but a Lighthouse failure ("Failed to fetch", a page that
     * never finished loading) is caught per run inside googleApi and comes back as a
     * *resolved* result carrying an errorResponse. Retrying only on a rejection left
     * exactly the failure the user sees in the table — every metric a dash — with no
     * second attempt at all, so a resolved total failure is retried the same as a throw.
     *
     * A partial failure is kept, not retried: its surviving runs still aggregate into
     * numbers worth reading, and re-running would discard them for no gain.
     */
    // `warmUp` undefined → the config decides; single-run re-runs pass false (cache already warm).
    const auditWithRetry = useCallback(async (url: string, signal?: AbortSignal, runs?: number, warmUp?: boolean): Promise<PageSpeedInsightResult> => {
        let lastError: unknown;
        let lastFailed: PageSpeedInsightResult | undefined;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const result = await audit(url, signal, runs, warmUp);
                if (!allRunsFailed(result)) return result;
                lastFailed = result;
            } catch (err) {
                if (err instanceof DOMException && err.name === 'AbortError') throw err;
                lastError = err;
            }
            if (attempt < MAX_RETRIES) {
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            }
        }
        // Attempts exhausted. A failed result is worth more than a throw — it carries the
        // API's own message, which the row prints under the URL.
        if (lastFailed) return lastFailed;
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
        if (slotKey === '2') setReauditNotice({});

        try {
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

            await worker();
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

    const restoreSnapshot = (snapshot: StrategySnapshot, urls: string[]) => {
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
        // The restored config's URLs arrive as a prop a render later; pin them now so the
        // realign effect sees no change and leaves the restored rows alone.
        urlsRef.current = urls;
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
                    merged[fi] = await auditWithRetry(url, undefined, 1, false);
                }
                result = aggregatePageSpeedInsightResults(url, merged, config.aggregation);
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
            const fresh = await auditWithRetry(url, undefined, 1, false);
            const merged = [...history];
            merged[runIdx] = fresh;
            const result = aggregatePageSpeedInsightResults(url, merged, config.aggregation);
            setResults(prev => {
                const next = [...prev];
                next[index] = result;
                return next;
            });
            // The run was just replaced, so a "cached" mark from the last re-audit no longer applies.
            if (slotKey === '2') {
                setReauditNotice(prev => {
                    const notice = prev[`2-${index}`];
                    if (!notice?.cachedRuns[runIdx]) return prev;
                    const { [runIdx]: _replaced, ...cachedRuns } = notice.cachedRuns;
                    return { ...prev, [`2-${index}`]: { ...notice, cachedRuns } };
                });
            }
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

    // ─── Re-audit flagged runs ────────────────────────────────────────────────
    // PSI is noisy enough that a few unlucky runs drag a score down and make a release
    // read as a regression. Re-audit re-runs only the flagged After runs — the fewest
    // worst runs whose removal clears the regression — up to REAUDIT_MAX_ATTEMPTS times
    // each. A run is done once it is no worse than the Before score on every shown
    // metric, and the whole re-audit stops as soon as the row is no longer worse than
    // Before. A fresh run only replaces the flagged one when it sits closer to the Before
    // scores, so a row can never end up worse than where it started.
    const REAUDIT_MAX_ATTEMPTS = 3;

    // Only the metrics the user is actually showing count.
    const shownMetricKeys = (): ComparableMetricKey[] => ([
        ['speedIndex', displayAudit.SI],
        ['largestContentfulPaint', displayAudit.LCP],
        ['cumulativeLayoutShift', displayAudit.CLS],
        ['totalBlockingTime', displayAudit.TBT],
        ['firstContentfulPaint', displayAudit.FCP],
    ] as const).filter(([, show]) => show).map(([key]) => key);

    const METRIC_LABELS: Record<ComparableMetricKey, string> = {
        speedIndex: 'SI',
        largestContentfulPaint: 'LCP',
        cumulativeLayoutShift: 'CLS',
        totalBlockingTime: 'TBT',
        firstContentfulPaint: 'FCP',
    };

    // A value in the displayed unit (ms; unitless CLS), formatted like the table.
    const formatShown = (key: ComparableMetricKey, value: number): string => {
        if (key === 'cumulativeLayoutShift') return value.toFixed(3);
        return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
    };

    // After runs flagged on any shown metric (red rows), in run order.
    const flaggedRunIndexes = (index: number): number[] =>
        flaggedAfterRuns(getSlot1(index) || undefined, getSlot2(index) || undefined, shownMetricKeys(), config.aggregation);

    // ─── Run forensics ────────────────────────────────────────────────────────
    // Whether a Before → After change is real or run-to-run noise, and why each flagged
    // run spiked. Pure analysis lives in pagespeedRunForensics; this is presentation.
    const VERDICT_LABELS: Record<MetricVerdict, string> = {
        regression: 'real regression',
        improved: 'real improvement',
        noise: 'likely noise',
        'no-change': 'within noise',
        'too-few': 'too few runs',
    };
    // Icon beside the Improvement %; the label and the reasoning live in the tooltip.
    const VERDICT_ICONS: Record<MetricVerdict, { icon: typeof CircleAlert; className: string }> = {
        regression: { icon: CircleAlert, className: 'text-error' },
        improved: { icon: CircleCheck, className: 'text-success' },
        noise: { icon: Waves, className: 'text-muted-foreground' },
        'no-change': { icon: Equal, className: 'text-muted-foreground' },
        'too-few': { icon: CircleHelp, className: 'text-muted-foreground' },
    };

    const runList = (runs: number[]): string => runs.map(i => `#${i + 1}`).join(', ');
    const runRange = (runs: number[]): string =>
        runs.length > 1 ? `#${runs[0]! + 1}–#${runs[runs.length - 1]! + 1}` : `#${runs[0]! + 1}`;

    // Only comparison rows with run histories on both sides have runs to weigh.
    const verdictOf = (r1: PageSpeedInsightResult | undefined, r2: PageSpeedInsightResult | undefined, key: ComparableMetricKey): MetricVerdictResult | undefined =>
        config.comparisonMode && r1?.runHistory && r2?.runHistory ? metricVerdict(r1, r2, key, config.aggregation) : undefined;

    // The table and the copy only mark degraded scores — a gain needs no explaining.
    const degradedVerdictOf = (r1: PageSpeedInsightResult | undefined, r2: PageSpeedInsightResult | undefined, key: ComparableMetricKey): MetricVerdictResult | undefined => {
        const pct = improvementPercent(r1?.[key], r2?.[key]);
        return pct !== null && pct < 0 ? verdictOf(r1, r2, key) : undefined;
    };

    const describeVerdict = (v: MetricVerdictResult): string => {
        if (v.verdict === 'too-few') return 'Needs at least 3 runs on each side to tell a real change from noise. Raise Runs per URL.';
        const share = `${config.afterLabel} is slower in ${Math.round(v.slowerShare * 100)}% of the ${v.pairs} ${config.beforeLabel}/${config.afterLabel} run pairs (50% = no difference).`;
        const meaning = {
            regression: `The ${config.afterLabel} runs are consistently slower: a real regression, not noise.`,
            improved: `The ${config.afterLabel} runs are consistently faster: a real improvement.`,
            noise: 'The runs overlap, so this regression is within run-to-run noise.',
            'no-change': 'The runs overlap; the difference is within run-to-run noise.',
        }[v.verdict];
        const trimmed = v.trimmedImprovement !== undefined
            ? ` Without run${v.excluded.length > 1 ? 's' : ''} ${runList(v.excluded)}: ${v.trimmedImprovement > 0 ? '+' : ''}${v.trimmedImprovement.toFixed(2)}%.`
            : '';
        return `${share} ${meaning}${trimmed}`;
    };

    const verdictChip = (r1: PageSpeedInsightResult | undefined, r2: PageSpeedInsightResult | undefined, key: ComparableMetricKey): React.ReactNode => {
        const v = degradedVerdictOf(r1, r2, key);
        if (!v) return null;
        const { icon: Icon, className } = VERDICT_ICONS[v.verdict];
        const label = VERDICT_LABELS[v.verdict];
        return (
            <Hint label={`${label.charAt(0).toUpperCase()}${label.slice(1)}: ${describeVerdict(v)}`}>
                <span className={`inline-flex ${className}`} role="img" aria-label={label}>
                    <Icon className="h-3.5 w-3.5" />
                </span>
            </Hint>
        );
    };

    const pageOriginOf = (index: number): string | undefined => {
        try { return new URL(config.urls[index] ?? '').origin; } catch { return undefined; }
    };

    const reauditFlaggedRuns = useCallback(async (index: number) => {
        const url = config.urls[index];
        if (!url || !config.comparisonMode) return;
        const key = `2-${index}`;

        // Second click on a running re-audit stops it after the attempt in flight.
        if (reauditProgress[key]) {
            reauditCancelRef.current.add(key);
            return;
        }

        const before = getSlot1(index) || undefined;
        let history = [...((getSlot2(index) || undefined)?.runHistory ?? [])];
        const flagged = flaggedRunIndexes(index);
        if (!before || !history.length || !flagged.length) return;

        const keys = shownMetricKeys();
        // Fixed for the whole re-audit: the Before side is not being re-run.
        const targets = Object.fromEntries(keys.map(k => [k, before[k]])) as Partial<Record<ComparableMetricKey, PageSpeedMetrics>>;
        const commit = (runs: PageSpeedInsightResult[]): boolean => {
            const aggregated = aggregatePageSpeedInsightResults(url, runs, config.aggregation);
            setResults2(prev => {
                const next = [...prev];
                next[index] = aggregated;
                return next;
            });
            // Cleared once no shown metric is worse than Before any more.
            return Object.keys(findDegradingRuns(before, aggregated, keys, config.aggregation)).length === 0;
        };

        reauditCancelRef.current.delete(key);
        dismissReauditNotice(key);
        if (activeAuditsRef.current === 0) setAuditEnd(null);
        activeAuditsRef.current++;

        let fixed = 0;
        let cleared = false;
        // Each run gets one turn of up to REAUDIT_MAX_ATTEMPTS. A run's turn ends as soon as
        // it is no longer flagged — even if it is still worse than Before on some metric it
        // was never flagged for — and the next still-flagged run takes over.
        const attempted = new Set<number>();
        // What each attempt did. A failed audit resolves instead of throwing, so without
        // this "the audit errored" and "the fresh run was no closer" look the same.
        const reports: ReauditRunReport[] = [];
        const seenFetchTimes = new Set(history.flatMap(r => (r.fetchTime ? [r.fetchTime] : [])));
        let stalled = false;
        try {
            runs: for (;;) {
                const next = nextReauditRun(before, history, keys, config.aggregation, attempted);
                if (!next) break;
                // Judge this run only on the metrics it is flagged for.
                const { runIdx, keys: runKeys } = next;
                attempted.add(runIdx);
                const report: ReauditRunReport = { runIdx, outcomes: [], elapsedMs: 0 };
                reports.push(report);
                const runKey = `2-${index}-${runIdx}`;
                setRerunningRuns(prev => new Set(prev).add(runKey));
                let excess = excessOverTargets(history[runIdx]!, targets, runKeys);
                let stillFlagged = true;
                try {
                    for (let attempt = 1; attempt <= REAUDIT_MAX_ATTEMPTS && stillFlagged; attempt++) {
                        if (reauditCancelRef.current.has(key)) break runs;
                        setReauditProgress(prev => ({ ...prev, [key]: { run: runIdx + 1, attempt } }));
                        let fresh: PageSpeedInsightResult;
                        const startedAt = performance.now();
                        try {
                            fresh = await auditWithRetry(url, undefined, 1, false);
                        } catch (error) {
                            report.elapsedMs = (report.elapsedMs ?? 0) + performance.now() - startedAt;
                            console.error(`Re-audit of run ${runIdx + 1} (attempt ${attempt}) failed for ${url}:`, error);
                            report.outcomes.push('errored');
                            report.error = auditErrorText(error);
                            continue;
                        }
                        report.elapsedMs = (report.elapsedMs ?? 0) + performance.now() - startedAt;
                        // Same Lighthouse run served again: not new data, and it can never be closer.
                        if (fresh.fetchTime && seenFetchTimes.has(fresh.fetchTime)) {
                            console.warn(`Re-audit of run ${runIdx + 1} (attempt ${attempt}) got an audit already in the row (fetchTime ${fresh.fetchTime}) for ${url}`);
                            report.outcomes.push('repeat');
                            continue;
                        }
                        if (fresh.fetchTime) seenFetchTimes.add(fresh.fetchTime);
                        if (resultHasError(fresh)) {
                            console.error(`Re-audit of run ${runIdx + 1} (attempt ${attempt}) returned an error for ${url}:`, fresh.errorResponse);
                            report.outcomes.push('errored');
                            report.error = auditErrorText(fresh.errorResponse);
                            continue;
                        }
                        const freshExcess = excessOverTargets(fresh, targets, runKeys);
                        if (freshExcess < excess) {
                            history = history.map((r, i) => (i === runIdx ? fresh : r));
                            excess = freshExcess;
                            report.outcomes.push('improved');
                            cleared = commit(history);
                            if (cleared) break runs;
                            stillFlagged = isRunFlagged(before, history, keys, config.aggregation, runIdx);
                        } else {
                            report.outcomes.push('no-closer');
                        }
                    }
                } finally {
                    setRerunningRuns(prev => {
                        const next = new Set(prev);
                        next.delete(runKey);
                        return next;
                    });
                }
                if (!stillFlagged) fixed++;
                // Every attempt on the first runs errored: the API is refusing us, so the
                // remaining runs would only burn more audits to fail the same way.
                if (reauditStalled(reports)) {
                    stalled = true;
                    break;
                }
            }
        } finally {
            const cancelled = reauditCancelRef.current.has(key);
            reauditCancelRef.current.delete(key);
            setReauditProgress(prev => {
                const next = { ...prev };
                delete next[key];
                return next;
            });
            setTimes2(prev => ({ ...prev, end: new Date() }));
            activeAuditsRef.current--;
            if (activeAuditsRef.current === 0) setAuditEnd(new Date());

            if (cleared) fixed = attempted.size;
            const total = attempted.size;
            const erroredAttempts = reports.reduce((sum, r) => sum + r.outcomes.filter(o => o === 'errored').length, 0);
            const unusable = erroredAttempts + reports.reduce((sum, r) => sum + r.outcomes.filter(o => o === 'repeat').length, 0);
            const details = reports.filter(r => r.outcomes.length > 0).map(describeReauditRun);
            const notice = cleared
                ? { tone: 'success' as const, text: `${config.afterLabel} is no longer worse than ${config.beforeLabel} on any shown metric (${fixed} of ${total} flagged run${total === 1 ? '' : 's'} re-audited into range).` }
                : stalled
                    ? { tone: 'warning' as const, text: reauditStallCause(reports) === 'cached'
                        ? `Re-audit stopped after ${reports.length} of ${flagged.length} flagged runs: PageSpeed is replaying stored audits for this URL (instant, identical results), so re-running now cannot produce new runs. Wait a few minutes and re-audit again. Kept the best runs found.`
                        : `Re-audit stopped after ${reports.length} of ${flagged.length} flagged runs: the audits keep failing, so no run could be replaced. Check the API key and quota, then try again. Kept the best runs found.` }
                    : cancelled
                        ? { tone: 'info' as const, text: `Re-audit stopped. ${fixed} of ${total} flagged run${total === 1 ? '' : 's'} now no worse than the ${config.beforeLabel} score. Kept the best runs found.` }
                        : { tone: 'warning' as const, text: `Still worse than ${config.beforeLabel} after re-auditing ${total} flagged run${total === 1 ? '' : 's'} (up to ${REAUDIT_MAX_ATTEMPTS} attempts each). ${fixed} cleared; ${unusable ? `${unusable} audit${unusable === 1 ? '' : 's'} errored or repeated an earlier result, so this may not reflect the page. Details below.` : 'the rest stayed slow, which points to a real regression.'} Kept the best runs found.` };
            setReauditNotice(prev => ({ ...prev, [key]: { ...notice, details, cachedRuns: cachedAttemptsByRun(reports) } }));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auditWithRetry, config.urls, config.aggregation, config.comparisonMode, config.beforeLabel, results1, results2, reauditProgress]);

    const calculateImprovement = (before?: PageSpeedMetrics, after?: PageSpeedMetrics): React.ReactNode => {
        const improvement = improvementPercent(before, after);
        if (improvement === null) return <div>-</div>;
        const formatted = improvement.toFixed(2);
        const color = improvement >= 0
            ? 'text-success'
            : Math.abs(improvement) > config.improvementThreshold
                ? 'text-error'
                : 'text-warning';
        const text = improvement > 0 ? `+${formatted}%` : `${formatted}%`;
        // From zero there is no true percentage; say what this one is measured against.
        if (zeroBaseline(before, after)) {
            return (
                <Hint label={`${config.beforeLabel} was 0, so this is measured against ${zeroBaselineFloor(after!).label} instead. Actual change: ${absoluteChange(before, after)?.text ?? '-'} (${before?.displayValue} → ${after?.displayValue}).`}>
                    <div className={color}>{text}</div>
                </Hint>
            );
        }
        return <div className={color}>{text}</div>;
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
    // `includeRuns` false copies one row per URL — the aggregates and Δ only.
    const copyForTeams = (includeRuns = true) => {
        const metricDefs = ([
            { show: displayAudit.SI, label: 'SI', key: 'speedIndex' },
            { show: displayAudit.LCP, label: 'LCP', key: 'largestContentfulPaint' },
            { show: displayAudit.CLS, label: 'CLS', key: 'cumulativeLayoutShift' },
            { show: displayAudit.TBT, label: 'TBT', key: 'totalBlockingTime' },
            { show: displayAudit.FCP, label: 'FCP', key: 'firstContentfulPaint' },
        ] as const).filter(m => m.show);

        // A hidden comparison column collapses the copy to one value column too, so the
        // pasted table matches the screen. `primaryOf` picks whichever run that column is.
        const single = !(showSide1 && showSide2);
        const primaryOf = <T,>(a: T, b: T): T => (showSide1 ? a : b);
        const soloLabel = showSide1 ? config.beforeLabel : config.afterLabel;
        const showImp = displayAudit.improvement;
        // Pages as paths when every URL shares one host; the host goes in the header.
        const { host, labels } = urlLabels(config.urls);
        const header = teamsCopyHeader({
            comparison: config.comparisonMode && !single,
            soloLabel: config.comparisonMode ? soloLabel : '',
            beforeLabel: config.beforeLabel,
            afterLabel: config.afterLabel,
            runs: config.runs,
            aggregation: config.aggregation,
            host,
            strategy: config.strategy === 'mobile' ? 'Mobile' : 'Desktop',
        });
        const td = (v: string, extra = '') => `<td style="padding:6px;border:1px solid #ccc${extra}">${v}</td>`;
        const verdictNote = (r1: PageSpeedInsightResult | undefined, r2: PageSpeedInsightResult | undefined, key: ComparableMetricKey): string => {
            const v = degradedVerdictOf(r1, r2, key);
            return v ? ` · ${VERDICT_LABELS[v.verdict]}` : '';
        };
        const impCell = (b?: PageSpeedMetrics, a?: PageSpeedMetrics, note = ''): string => {
            const pct = improvementPercent(b, a);
            if (pct === null) return td('-');
            const text = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%${note}`;
            const color = pct >= 0 ? '#16a34a' : (Math.abs(pct) > config.improvementThreshold ? '#dc2626' : '#ea580c');
            return td(text, `;color:${color};font-weight:600`);
        };

        const headCells = [host ? 'Page' : 'URL'];
        for (const m of metricDefs) {
            if (single) headCells.push(displayAudit.singleResult ? m.label : `${m.label} (${soloLabel})`);
            else {
                headCells.push(`${m.label} (${config.beforeLabel})`, `${m.label} (${config.afterLabel})`);
                if (showImp) headCells.push(`${m.label} Δ`);
            }
        }
        // Teams drops CSS widths on paste; the URL column keeps a legacy width attribute and
        // wraps through the break points breakableUrlLink puts in the text.
        const URL_W = 180;
        const thead = `<tr>${headCells.map((h, i) => `<th${i === 0 ? ` width="${URL_W}"` : ''} style="background:#f1f1f1;text-align:left;padding:6px;border:1px solid #ccc${i === 0 ? `;width:${URL_W}px` : ''}">${h}</th>`).join('')}</tr>`;

        const rows = config.urls.map((url, i) => {
            const r1 = getSlot1(i) || undefined;
            const r2 = getSlot2(i) || undefined;
            let tds = `<td width="${URL_W}" style="padding:6px;border:1px solid #ccc;width:${URL_W}px;max-width:${URL_W}px;vertical-align:top">${breakableUrlLink(url, labels[i])}</td>`;
            for (const m of metricDefs) {
                const v1 = r1?.[m.key]?.displayValue ?? '-';
                const v2 = r2?.[m.key]?.displayValue ?? '-';
                if (single) tds += td(primaryOf(v1, v2));
                else {
                    tds += td(v1) + td(v2);
                    if (showImp) tds += impCell(r1?.[m.key], r2?.[m.key], verdictNote(r1, r2, m.key));
                }
            }
            let html = `<tr>${tds}</tr>`;

            // Individual runs (Average run mode) — grouped under the URL as #N sub-rows,
            // run values aligned to their Before/After columns.
            const h1 = (single ? primaryOf(r1, r2) : r1)?.runHistory ?? [];
            const h2 = single ? [] : (r2?.runHistory ?? []);
            const runCount = Math.max(h1.length, h2.length);
            if (includeRuns && runCount > 1) {
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
                // After runs that drive the regression — the fewest worst runs whose removal clears it.
                const degrading = single ? {} : findDegradingRuns(r1, r2, metricDefs.map(m => m.key), config.aggregation);
                const runCell = (v: string, metricKey: ComparableMetricKey, degraded = false): string => {
                    if (degraded) return td(v, ';background:#fde2e2;color:#b91c1c');
                    const hl = v !== '-' && matchedByMetric.get(metricKey)?.has(v);
                    return td(v, hl ? ';background:#fff3cd;color:#92400e;font-style:italic' : ';color:#888');
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
                            rtds += runCell(v1, m.key) + runCell(v2, m.key, !!degrading[m.key]?.runs.has(ri));
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
        // Throttling/emulation PSI used, so a reader knows what the numbers were measured on.
        const envSummary = describePageSpeedTestEnvironment(config.strategy, [...results1, ...results2]).summary;
        const envHtml = `<p style="margin:4px 0 0;font-family:Segoe UI,Arial,sans-serif;font-size:10px;color:#6b7280">${envSummary}</p>`;
        const html = `${header.html}${tableHtml}${envHtml}${analysisHtml}`;

        const plain = `${header.plain}\n` + config.urls.map((url, i) => {
            const r1 = getSlot1(i) || undefined;
            const r2 = getSlot2(i) || undefined;
            const parts = metricDefs.map(m => single
                ? `${m.label} ${primaryOf(r1, r2)?.[m.key]?.displayValue ?? '-'}`
                : `${m.label} ${r1?.[m.key]?.displayValue ?? '-'} → ${r2?.[m.key]?.displayValue ?? '-'}${verdictNote(r1, r2, m.key)}`);
            const h1 = (single ? primaryOf(r1, r2) : r1)?.runHistory ?? [];
            const h2 = single ? [] : (r2?.runHistory ?? []);
            const runCount = Math.max(h1.length, h2.length);
            let runLines = '';
            if (includeRuns && runCount > 1) {
                const matched = new Map<string, Set<string>>();
                if (!single) {
                    for (const m of metricDefs) {
                        const set1 = new Set(h1.map(r => r?.[m.key]?.displayValue).filter(Boolean) as string[]);
                        const vals2 = h2.map(r => r?.[m.key]?.displayValue).filter(Boolean) as string[];
                        matched.set(m.key, new Set(vals2.filter(v => set1.has(v))));
                    }
                }
                const degrading = single ? {} : findDegradingRuns(r1, r2, metricDefs.map(m => m.key), config.aggregation);
                const mark = (v: string, key: string) => (v !== '-' && matched.get(key)?.has(v)) ? `*${v}*` : v;
                // ↑ = this run drives the regression.
                const markAfter = (v: string, key: ComparableMetricKey, ri: number) =>
                    degrading[key]?.runs.has(ri) ? `${v} ↑` : mark(v, key);
                for (let ri = 0; ri < runCount; ri++) {
                    const runParts = metricDefs.map(m => single
                        ? `${m.label} ${h1[ri]?.[m.key]?.displayValue ?? '-'}`
                        : `${m.label} ${mark(h1[ri]?.[m.key]?.displayValue ?? '-', m.key)} → ${markAfter(h2[ri]?.[m.key]?.displayValue ?? '-', m.key, ri)}`);
                    runLines += `\n  #${ri + 1}: ${runParts.join(', ')}`;
                }
            }
            return `${labels[i] ?? url}: ${parts.join(', ')}` + runLines;
        }).join('\n') + `\n\n${envSummary}` + (analysisMd ? `\n\n${analysisMd}` : '');

        const copy = navigator.clipboard.write([
            new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([plain], { type: 'text/plain' }),
            }),
        ]);
        toast.promise(copy, { loading: 'Copying…', success: 'Copied for Teams', error: 'Copy failed' });
    };

    const thSpan = columnsPerMetric;

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
                        {displayAudit.before && <TableHead className="text-center text-sm border">{config.beforeLabel}</TableHead>}
                        {displayAudit.after && <TableHead className="text-center text-sm border">{config.afterLabel}</TableHead>}
                        {displayAudit.improvement && (
                            <TableHead className="text-center text-sm border">Improvement</TableHead>
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
        // Errors always surface; warnings are opt-in.
        const messages: PageSpeedInsightResultMessage[] = getPageSpeedInsightResultMessages(r1, r2)
            .filter(m => m.isError || config.showWarnings);

        if (messages.length === 0) return null;
        // Multi-run rows carry the full text per run, so the URL cell shows an
        // icon + count only — the detail lives in the Individual Runs table.
        const hasRunHistory = !!(r1?.runHistory?.length || r2?.runHistory?.length);
        if (!hasRunHistory) return <CollapsibleMessages messages={messages} forceExpanded={true} />;

        const errorCount = messages.filter(m => m.isError).length;
        const warningCount = messages.length - errorCount;
        const label = [
            errorCount > 0 ? `${errorCount} error(s)` : '',
            warningCount > 0 ? `${warningCount} warning(s)` : '',
        ].filter(Boolean).join(' / ');
        return (
            <Hint label={`${label} across the runs - expand this URL to see which run each one came from`}>
                <span className={`ml-1 mt-1 inline-flex items-center gap-0.5 ${errorCount > 0 ? 'text-error' : 'text-warning'}`}>
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span className="text-[10px] font-medium">{errorCount > 0 ? errorCount : warningCount}</span>
                </span>
            </Hint>
        );
    };

    const cellValue = (slot: AuditSlot, metric: PageSpeedMetrics | undefined): React.ReactNode => {
        // A per-cell spinner reads as a hang once a URL is auditing for minutes
        // (runs is now up to 10). A bar the width of the value it stands in for
        // keeps the column from resizing when the number lands.
        if (slot === null) return <Skeleton className="mx-auto h-4 w-12" />;
        if (slot === undefined) return <span>-</span>;
        // Show metric when available — even on partial run failure the average is still valid
        if (metric?.displayValue) return metric.displayValue;
        if (slotHasError(slot)) return <span className="text-destructive/50 text-xs">—</span>;
        return '-';
    };

    // `false` is the slot for an audit that threw outright — no result to inspect.
    // Everything else defers to the shared predicates, so the badge below and the
    // retry loop above cannot drift apart on what counts as a failure.
    const slotHasError = (slot: AuditSlot) => slot === false || (!!slot && resultHasError(slot));

    // A partial failure still yields usable aggregates, so only a slot whose every
    // run errored reads as "Audit failed." — the rest just carry the error badge.
    const slotAllRunsFailed = (slot: AuditSlot): boolean => slot === false || (!!slot && allRunsFailed(slot));

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
            <Hint label={isRetrying ? 'Retrying this URL...' : 'This audit failed - retry just the failed runs and re-aggregate'}>
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
            </Hint>
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
            <Hint label="Audit this URL again and replace this result">
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
            </Hint>
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

    const scoreColor = (score: number | null): string => {
        if (score === null) return 'text-muted-foreground';
        if (score >= 0.9) return 'text-success';
        if (score >= 0.5) return 'text-warning';
        return 'text-error';
    };

    const severityIcon = (score: number | null): React.ReactNode => {
        if (score === null) return <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
        if (score < 0.5) return <Triangle className="h-3.5 w-3.5 fill-red-500 text-error shrink-0" />;
        if (score < 0.9) return <Square className="h-3.5 w-3.5 fill-orange-500 text-warning shrink-0" />;
        return <Circle className="h-3.5 w-3.5 fill-green-500 text-success shrink-0" />;
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
        if ((details.headings?.length ?? 0) > 0 && Array.isArray(details.items) && details.items.length > 0) return true;
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
                    <span className={`break-all ${longest ? 'text-error' : 'text-foreground'}`}>
                        {depth > 0 && <span className="mr-1 text-muted-foreground">└</span>}
                        {tail}
                        {host && <span className="text-muted-foreground"> ({host})</span>}
                    </span>
                    <span className="ml-auto whitespace-nowrap text-muted-foreground">
                        {t !== undefined && <span className={`font-medium ${longest ? 'text-error' : 'text-foreground'}`}>{Math.round(t).toLocaleString()} ms</span>}
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

    const INSIGHT_BADGE: Record<InsightChange['status'], { label: string; className: string }> = {
        new: { label: 'New', className: 'border-error/40 bg-error/10 text-error' },
        worse: { label: 'Worse', className: 'border-warning/40 bg-warning/10 text-warning' },
        fixed: { label: 'Fixed', className: 'border-success/40 bg-success/10 text-success' },
    };

    const renderInsightRow = (o: PageSpeedOpportunity, idPrefix: string, occurrence?: { runs: number[]; total: number }, change?: InsightChange): React.ReactNode => {
        const key = `${idPrefix}-${o.auditKey ?? o.title}`;
        const open = expandedInsights.has(key);
        const savings = formatSavings(o);
        const hasDetail = !!o.description || hasRenderableDetails(o.details);
        const showRuns = occurrence && occurrence.total > 1 && occurrence.runs.length < occurrence.total;
        const metrics = o.metricSavings ? Object.keys(o.metricSavings) : [];
        return (
            <div key={key} className="border-b border-border last:border-0">
                <Hint label={hasDetail ? (open ? 'Hide what Lighthouse found' : 'Show what Lighthouse found and the resources it affects') : ''} className="w-full">
                <button
                    onClick={() => hasDetail && toggleInsight(key)}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-left ${hasDetail ? 'hover:bg-muted/40 cursor-pointer' : 'cursor-default'}`}
                >
                    {severityIcon(o.score)}
                    <span className="text-xs font-medium text-foreground">{o.title}</span>
                    {change && (
                        <Hint label={change.detail}>
                            <span className={`rounded border px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${INSIGHT_BADGE[change.status].className}`}>
                                {INSIGHT_BADGE[change.status].label}
                            </span>
                        </Hint>
                    )}
                    {savings && <span className={`text-xs ${scoreColor(o.score)}`}>— {savings}</span>}
                    {metrics.map(m => (
                        <span key={m} className="text-[9px] uppercase tracking-wide px-1 py-px rounded border border-border text-muted-foreground">{m}</span>
                    ))}
                    {showRuns && <span className="text-[10px] text-muted-foreground">({formatRunsSeen(occurrence!.runs, occurrence!.total)})</span>}
                    {hasDetail && (
                        <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                    )}
                </button>
                </Hint>
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
        changes?: Record<string, InsightChange>,
    ): React.ReactNode => {
        if (!items.length) return null;
        const groupKey = `group-${idPrefix}`;
        const open = expandedInsights.has(groupKey);
        // What the release changed reads first: new, then worse, then fixed, then the rest.
        const RANK: Record<InsightChange['status'], number> = { new: 0, worse: 1, fixed: 2 };
        const rank = (o: PageSpeedOpportunity) => { const c = changes?.[insightKey(o)]; return c ? RANK[c.status] : 3; };
        const ordered = changes ? [...items].sort((a, b) => rank(a) - rank(b)) : items;
        const counts = (['new', 'worse', 'fixed'] as const)
            .map(status => [status, items.filter(o => changes?.[insightKey(o)]?.status === status).length] as const)
            .filter(([, n]) => n > 0);
        return (
            <div className="mt-3">
                <Hint label={open ? `Hide these ${items.length} items` : `Show these ${items.length} items`} side="right">
                <button
                    onClick={() => toggleInsight(groupKey)}
                    className="flex items-center gap-1 mb-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground hover:text-foreground"
                >
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                    {heading} ({items.length})
                    {counts.map(([status, n]) => (
                        <span key={status} className={`ml-1 rounded border px-1 text-[9px] font-semibold uppercase ${INSIGHT_BADGE[status].className}`}>
                            {n} {INSIGHT_BADGE[status].label}
                        </span>
                    ))}
                </button>
                </Hint>
                {open && (
                    <div className="border border-border rounded-md overflow-hidden bg-background">
                        {ordered.map(o => renderInsightRow(o, idPrefix, occurrences?.[insightKey(o)], changes?.[insightKey(o)]))}
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
        changes?: Record<string, InsightChange>,
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
                {renderInsightGroup('PAGESPEED INSIGHTS', visible, `${idPrefix}-o`, occurrences, changes)}
            </div>
        );
    };

    const renderInsights = (result: PageSpeedInsightResult, idPrefix: string, label?: string, changes?: Record<string, InsightChange>): React.ReactNode =>
        renderInsightsList((result.opportunities ?? []).filter(o => o.type === 'opportunity'), idPrefix, label, undefined, changes);

    // Merge each run's insights into one set: dedupe by audit, keep the worst-scoring instance,
    // and track how many of the runs each audit appeared in.
    const consolidateRunInsights = consolidateInsights;

    const renderConsolidatedInsights = (history: PageSpeedInsightResult[], idPrefix: string, label?: string, changes?: Record<string, InsightChange>): React.ReactNode => {
        const { opportunities, occurrences } = consolidateRunInsights(history);
        return renderInsightsList(opportunities, idPrefix, label, occurrences, changes);
    };

    // NEW / WORSE for the After insights and FIXED for the Before ones — comparison only.
    const insightChanges = (index: number): ReturnType<typeof diffInsights> | undefined => {
        const r1 = getSlot1(index) || undefined;
        const r2 = getSlot2(index) || undefined;
        if (!config.comparisonMode || !r1 || !r2) return undefined;
        const setOf = (r: PageSpeedInsightResult): InsightSet => r.runHistory?.length
            ? consolidateInsights(r.runHistory)
            : { opportunities: (r.opportunities ?? []).filter(o => o.type === 'opportunity') };
        return diffInsights(setOf(r1), setOf(r2), { before: config.beforeLabel, after: config.afterLabel });
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

        // Which metrics actually got worse past the configured threshold — feeds the
        // evidence ranking so the audits that plausibly caused the regression survive
        // truncation instead of being crowded out by unrelated ones.
        const regressedMetrics = (() => {
            const defs = [
                ['SI', 'speedIndex'], ['LCP', 'largestContentfulPaint'], ['CLS', 'cumulativeLayoutShift'],
                ['TBT', 'totalBlockingTime'], ['FCP', 'firstContentfulPaint'],
            ] as const;
            return defs
                .filter(([, key]) => {
                    const b = r1?.[key]?.numericValue ?? 0;
                    const a = r2?.[key]?.numericValue ?? 0;
                    return b > 0 && a > b * (1 + config.improvementThreshold / 100);
                })
                .map(([label]) => label);
        })();

        // The resource-level account of what changed on the page — this is the causal
        // evidence the model needs to explain WHY a metric moved.
        const evidenceSection = buildEvidenceDiffSection(
            r1, r2,
            { before: config.beforeLabel, after: config.afterLabel },
            {
                regressedMetrics,
                shownMetrics: {
                    SI: displayAudit.SI, LCP: displayAudit.LCP, CLS: displayAudit.CLS,
                    TBT: displayAudit.TBT, FCP: displayAudit.FCP,
                },
                pageOrigin: (() => { try { return new URL(url).origin; } catch { return undefined; } })(),
            },
        );

        // The fewest worst After runs whose removal clears each regressed metric.
        const degradingSection = (() => {
            const found = findDegradingRuns(r1, r2, shownMetricKeys(), config.aggregation);
            const lines = shownMetricKeys().flatMap(key => {
                const d = found[key];
                if (!d) return [];
                const runs = [...d.runs].sort((x, y) => x - y).map(i => `#${i + 1} (${h2?.[i]?.[key]?.displayValue})`).join(', ');
                return [`- ${METRIC_LABELS[key]}: ${runs}. Without them the ${config.afterLabel} ${config.aggregation} is ${formatShown(key, d.without)} vs ${config.beforeLabel}'s ${d.target.displayValue}.`];
            });
            if (!lines.length) return '';
            return [
                '',
                `### ${config.afterLabel} runs driving the regression`,
                `For each regressed metric, the fewest worst ${config.afterLabel} runs whose removal brings the score back to ${config.beforeLabel} or better:`,
                lines.join('\n'),
                'Interpretation: one or two flagged runs while the rest overlap Before point to outliers (noise). Many flagged runs, or runs flagged on several metrics, point to a consistent change.',
                '',
            ].join('\n');
        })();

        // Which PageSpeed Insights findings the release introduced, worsened or fixed.
        const insightChangeSection = (() => {
            const changes = insightChanges(index);
            if (!changes) return '';
            const titleOf = (side: PageSpeedInsightResult | undefined, key: string) => {
                const list = side?.runHistory?.length ? consolidateInsights(side.runHistory).opportunities : (side?.opportunities ?? []);
                return list.find(o => insightKey(o) === key)?.title ?? key;
            };
            const lines = [
                ...Object.entries(changes.after).map(([key, c]) => `- ${c.status.toUpperCase()}: ${titleOf(r2, key)}. ${c.detail}`),
                ...Object.entries(changes.before).map(([key, c]) => `- FIXED: ${titleOf(r1, key)}. ${c.detail}`),
            ];
            if (!lines.length) return '';
            return ['', `### PageSpeed Insights changes (${config.beforeLabel} → ${config.afterLabel})`, lines.join('\n'), ''].join('\n');
        })();

        // Is each metric's change real, and why did the flagged runs spike?
        const forensicsSection = (() => {
            if (!r1?.runHistory || !r2?.runHistory) return '';
            const keys = shownMetricKeys();
            const verdicts = keys.map(key => {
                const v = metricVerdict(r1, r2, key, config.aggregation);
                return `- ${METRIC_LABELS[key]}: ${VERDICT_LABELS[v.verdict]}. ${describeVerdict(v)}`;
            });
            const flagged = flaggedAfterRuns(r1, r2, keys, config.aggregation);
            const origin = pageOriginOf(index);
            const causes = flagged.map(i =>
                `- Run #${i + 1}: ${explainSpike(i, r2, flagged, origin).map(c => `${c.label}. ${c.detail}`).join(' ')}`);
            const warm = detectWarmUp(r1, r2, keys, config.aggregation);
            return [
                '',
                '### Run forensics (is the change real?)',
                `Verdict per metric. "Slower in X% of run pairs" is Mann-Whitney U / (n1*n2): 71% or more = consistent regression, 29% or less = consistent improvement, in between = overlapping runs (noise).`,
                verdicts.join('\n'),
                ...(causes.length ? ['', `Why each flagged ${config.afterLabel} run spiked (compared with a typical ${config.afterLabel} run):`, causes.join('\n')] : []),
                ...(warm ? ['', `Warm-up pattern: runs ${runRange(warm.runs)} were slow, then steady. Likely a cold CDN/server cache after deploy, not a code change.`] : []),
                'Interpretation: treat "likely noise" / "within noise" metrics as unchanged. Only "real regression" metrics warrant a code-level explanation.',
                '',
            ].join('\n');
        })();

        return [
            `URL: ${url}`,
            `Strategy: ${config.strategy}`,
            `Runs: ${config.runs}${isMultiRun ? ` (${config.aggregation})` : ''}${config.warmUpRun ? ' (+1 discarded warm-up run per URL)' : ''}${isMultiRun && h1 ? ` — ${h1.length} completed` : ''}`,
            '',
            slot(config.beforeLabel, r1, h1),
            slot(config.afterLabel, r2, h2),
            evidenceSection,
            matchedSection,
            degradingSection,
            forensicsSection,
            insightChangeSection,
        ].join('\n');
    };

    const buildAllUrlsSummary = (): string => {
        const blocks = config.urls
            .map((_, i) => (getSlot1(i) && getSlot2(i) ? buildAnalysisSummary(i) : null))
            .filter(Boolean);
        return `Comparison across ${blocks.length} URL(s).\n\n${blocks.join('\n\n---\n\n')}`;
    };

    // Individual-runs metrics table. Insights are consolidated separately, below the table.
    const renderRunHistory = (history: PageSpeedInsightResult[], index: number, slotKey: '1' | '2'): React.ReactNode => {
        // The fewest worst After runs whose removal clears a regressed metric — the runs
        // that turn the Improvement negative. Only the After table can drag a comparison down.
        const degrading = slotKey === '2' && config.comparisonMode
            ? findDegradingRuns(getSlot1(index) || undefined, getSlot2(index) || undefined, shownMetricKeys(), config.aggregation)
            : {};
        // Why each flagged run spiked, vs a typical After run.
        const flagged = slotKey === '2' && config.comparisonMode ? flaggedRunIndexes(index) : [];
        const afterResult = getSlot2(index) || undefined;
        const spikeCauses = (runIdx: number) =>
            afterResult && flagged.includes(runIdx) ? explainSpike(runIdx, afterResult, flagged, pageOriginOf(index)) : [];
        const metricCell = (key: ComparableMetricKey, run: PageSpeedInsightResult, runIdx: number): React.ReactNode => {
            const d = degrading[key];
            if (!d?.runs.has(runIdx)) {
                return <td className="text-center py-1 px-2">{historyMetricValue(run[key])}</td>;
            }
            return (
                <td className="text-center py-1 px-2 font-semibold text-error">
                    <Hint label={`Drives the ${METRIC_LABELS[key]} regression. Without run${d.runs.size > 1 ? 's' : ''} ${[...d.runs].sort((x, y) => x - y).map(i => `#${i + 1}`).join(', ')} the ${config.afterLabel} ${config.aggregation} would be ${formatShown(key, d.without)}, no worse than ${config.beforeLabel}'s ${d.target.displayValue}.`}>
                        <span className="inline-flex items-center gap-0.5">
                            {historyMetricValue(run[key])}
                            <ArrowUp className="h-3 w-3" />
                        </span>
                    </Hint>
                </td>
            );
        };
        // Run + shown metrics + the trailing re-run column (hidden while copying as image).
        const runColCount = 1
            + [displayAudit.SI, displayAudit.LCP, displayAudit.CLS, displayAudit.TBT, displayAudit.FCP].filter(Boolean).length
            + (copying ? 0 : 1);
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
                        const runKey = `${slotKey}-${index}-${runIdx}`;
                        const rerunning = rerunningRuns.has(runKey);
                        // Warnings/errors belonging to THIS run — shown inline instead of piling up on the
                        // URL cell. Errors always surface; warnings are opt-in.
                        const runMessages = getPageSpeedInsightResultMessages(run, undefined)
                            .filter(m => m.isError || config.showWarnings);
                        const runErrorCount = runMessages.filter(m => m.isError).length;
                        const runWarningCount = runMessages.length - runErrorCount;
                        // Copying as image flattens everything open so the snapshot keeps the detail.
                        const messagesOpen = copying || expandedRunMessages.has(runKey);
                        const badgeLabel = [
                            runErrorCount > 0 ? `${runErrorCount} error(s)` : '',
                            runWarningCount > 0 ? `${runWarningCount} warning(s)` : '',
                        ].filter(Boolean).join(' / ');
                        return (
                            <React.Fragment key={runIdx}>
                            <tr className={`border-b border-border/50 ${messagesOpen && runMessages.length > 0 ? '' : 'last:border-0'}${Object.values(degrading).some(d => d.runs.has(runIdx)) ? ' bg-error/10' : ''}`}>
                                <td className="py-1 px-2 text-muted-foreground whitespace-nowrap w-px">
                                    {(() => {
                                        // After runs a re-audit could not replace because PSI replayed a stored audit.
                                        const cached = slotKey === '2' ? reauditNotice[`2-${index}`]?.cachedRuns[runIdx] : undefined;
                                        const when = run.fetchTime ? ` - ${formatRunTime(run.fetchTime)}` : '';
                                        return (
                                            <Hint label={cached
                                                ? `Run #${runIdx + 1}${when}. PageSpeed returned a cached audit for ${cached.repeated} of ${cached.attempts} re-audit attempts, so this run was not freshly re-measured.`
                                                : `Run #${runIdx + 1}${when}`}>
                                                <span className={cached ? 'font-semibold text-warning' : ''}>#{runIdx + 1}</span>
                                            </Hint>
                                        );
                                    })()}
                                    {(() => {
                                        const causes = spikeCauses(runIdx);
                                        if (!causes.length) return null;
                                        return (
                                            <Hint label={causes.map(c => c.detail).join(' ')}>
                                                <span className="ml-1.5 inline-block rounded border border-error/40 px-1 align-middle text-[10px] font-medium leading-4 text-error">
                                                    {causes[0]!.label}{causes.length > 1 ? ` +${causes.length - 1}` : ''}
                                                </span>
                                            </Hint>
                                        );
                                    })()}
                                    {runMessages.length > 0 && (
                                        <Hint label={messagesOpen ? `Hide the ${badgeLabel} from run #${runIdx + 1}` : `Show the ${badgeLabel} from run #${runIdx + 1}`}>
                                            <button
                                                onClick={() => toggleRunMessages(runKey)}
                                                className={`ml-1.5 inline-flex items-center gap-0.5 align-middle rounded px-1 py-0.5 hover:bg-muted transition-colors ${runErrorCount > 0 ? 'text-error' : 'text-warning'}`}
                                            >
                                                <AlertTriangle className="h-3 w-3" />
                                                <span className="text-[10px] font-medium">{runMessages.length}</span>
                                                <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${messagesOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                            </button>
                                        </Hint>
                                    )}
                                </td>
                                {displayAudit.SI && metricCell('speedIndex', run, runIdx)}
                                {displayAudit.LCP && metricCell('largestContentfulPaint', run, runIdx)}
                                {displayAudit.CLS && metricCell('cumulativeLayoutShift', run, runIdx)}
                                {displayAudit.TBT && metricCell('totalBlockingTime', run, runIdx)}
                                {displayAudit.FCP && metricCell('firstContentfulPaint', run, runIdx)}
                                {!copying && (
                                    <td className="py-1 px-2 w-px whitespace-nowrap text-right" data-html2canvas-ignore="true">
                                        <Hint label={`Re-run only run #${runIdx + 1}, then re-aggregate this row`}>
                                            <button
                                                onClick={() => rerunSingleRun(index, runIdx, slotKey)}
                                                disabled={isAuditing || isRetryingAny || rerunning || isReauditingAny}
                                                className="inline-flex items-center justify-center p-1 rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors"
                                            >
                                                <RotateCw className={`h-3.5 w-3.5 text-primary ${rerunning ? 'animate-spin' : ''}`} />
                                            </button>
                                        </Hint>
                                    </td>
                                )}
                            </tr>
                            {runMessages.length > 0 && messagesOpen && (
                                <tr className="border-b border-border/50 last:border-0">
                                    <td colSpan={runColCount} className="px-2 pb-2">
                                        <div className="ml-4 space-y-1 border-l border-border pl-2">
                                            {runMessages.map((m, j) => (
                                                <p key={j} className={`text-xs ${m.isError ? 'text-error' : 'text-warning'}`}>* {m.message}</p>
                                            ))}
                                        </div>
                                    </td>
                                </tr>
                            )}
                            </React.Fragment>
                        );
                    })}
                </tbody>
            </table>
        );
    };

    // Calculate total column count for the history row's colSpan
    const totalColCount = (() => {
        const metricCount = [displayAudit.SI, displayAudit.LCP, displayAudit.CLS, displayAudit.TBT, displayAudit.FCP].filter(Boolean).length;
        return 1 + metricCount * columnsPerMetric; // 1 for URL column
    })();

    const cellMetrics = (
        show: boolean,
        slot1: AuditSlot,
        slot2: AuditSlot,
        metrics1: PageSpeedMetrics | undefined,
        metrics2: PageSpeedMetrics | undefined,
        key: ComparableMetricKey,
    ): React.ReactNode => (
        <>
            {show && (
                <>
                    {(displayAudit.singleResult || displayAudit.before) && (
                        <TableCell className="text-center border">
                            {cellValue(slot1, metrics1)}
                        </TableCell>
                    )}
                    {displayAudit.after && (
                        <TableCell className="text-center border">
                            {cellValue(slot2, metrics2)}
                        </TableCell>
                    )}
                    {displayAudit.improvement && (
                        <TableCell className="text-center border">
                            {metrics1 && metrics2
                                ? <div className="inline-flex items-center justify-center gap-1">{calculateImprovement(metrics1, metrics2)}{verdictChip(slot1 || undefined, slot2 || undefined, key)}</div>
                                : isAuditing
                                    ? <Skeleton className="mx-auto h-4 w-12" />
                                    : '-'}
                        </TableCell>
                    )}
                </>
            )}
        </>
    );

    const testEnvironment = describePageSpeedTestEnvironment(config.strategy, [...results1, ...results2]);

    return (
        <Card className={grouped ? 'my-4 mx-6 first:mt-6 last:mb-6 shadow-none' : 'my-4'} ref={elementRef}>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                        {config.strategy.toUpperCase()}
                        <Hint label={testEnvironment.detail}>
                            <span className="text-xs font-normal text-muted-foreground">
                                {testEnvironment.summary}
                            </span>
                        </Hint>
                    </div>
                    {!copying && showAnalyzeButton && (
                        <div className="flex items-center gap-2">
                            {config.comparisonMode && (
                                <>
                                    <Hint label={`Audit every URL ${config.runs > 1 ? `${config.runs} times ` : ''}${config.warmUpRun ? '(after 1 discarded warm-up run) ' : ''}on ${config.strategy} and fill the ${config.beforeLabel} columns`}>
                                        <Button variant="outline" onClick={audit1} disabled={isAuditing}>
                                            {auditing1 ? (
                                                <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
                                                    <Loader2 className="animate-spin" size={14} />
                                                    Analyzing {config.beforeLabel}
                                                </span>
                                            ) : (
                                                <><Play className="mr-1 h-4 w-4" />Analyze {config.beforeLabel}</>
                                            )}
                                        </Button>
                                    </Hint>
                                    <Hint label={`Audit every URL again and fill the ${config.afterLabel} columns - run this after deploying your change`}>
                                        <Button variant="outline" onClick={audit2} disabled={isAuditing}>
                                            {auditing2 ? (
                                                <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
                                                    <Loader2 className="animate-spin" size={14} />
                                                    Analyzing {config.afterLabel}
                                                </span>
                                            ) : (
                                                <><Play className="mr-1 h-4 w-4" />Analyze {config.afterLabel}</>
                                            )}
                                        </Button>
                                    </Hint>
                                </>
                            )}
                            {!config.comparisonMode && (
                                <Hint label={`Audit every URL ${config.runs > 1 ? `${config.runs} times ` : ''}${config.warmUpRun ? '(after 1 discarded warm-up run) ' : ''}on ${config.strategy}`}>
                                    <Button variant="outline" onClick={audit1} disabled={isAuditing}>
                                        {auditing1 ? (
                                            <span className="flex items-center gap-1 text-sm font-normal text-muted-foreground">
                                                <Loader2 className="animate-spin" size={14} />
                                                Analyzing...
                                            </span>
                                        ) : (
                                            <><Play className="mr-1 h-4 w-4" />Analyze</>
                                        )}
                                    </Button>
                                </Hint>
                            )}
                            {isAuditing && (
                                <Hint label="Stop this strategy's audit - URLs already measured keep their results">
                                    <Button variant="outline" onClick={() => abortControllerRef.current?.abort()}>
                                        <Ban className="mr-1 h-4 w-4" />Cancel
                                    </Button>
                                </Hint>
                            )}
                            {config.urls.some((_, i) => getSlot1(i) || getSlot2(i)) && (
                                <CopyForTeamsButton
                                    onCopy={copyForTeams}
                                    disabled={copying}
                                    hint={`Copy this ${config.strategy} table as rich text, ready to paste into Teams`}
                                    icon={<Copy className="mr-1 h-4 w-4" />}
                                />
                            )}
                            <Hint label="Copy this card to the clipboard as a PNG screenshot">
                                <Button variant="outline" onClick={onCopyAsImage} disabled={copying || isAuditing}>
                                    <ImageIcon className="mr-1 h-4 w-4" />Copy as Image
                                </Button>
                            </Hint>
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
                            {config.urls.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={99} className="py-10 text-center">
                                        <p className="text-sm font-medium text-foreground">No URLs to audit</p>
                                        <p className="mt-1 text-xs text-muted-foreground">
                                            Open Configuration and add a URL, or upload a .txt file with one URL per line.
                                        </p>
                                    </TableCell>
                                </TableRow>
                            )}
                            {config.urls.map((url, index) => {
                                const slot1 = getSlot1(index);
                                const slot2 = getSlot2(index);
                                const result1 = slot1 || undefined;
                                const result2 = slot2 || undefined;
                                const history1 = result1?.runHistory;
                                const history2 = result2?.runHistory;
                                const hasHistory = isMultiRun && (history1 || history2);
                                const hasInsights = !!(
                                    result1?.opportunities?.some(o => o.type === 'opportunity') ||
                                    result2?.opportunities?.some(o => o.type === 'opportunity')
                                );
                                // Single-run rows expand too, so each slot's Re-run is always reachable.
                                const hasSingleRun = !isMultiRun && !!(result1 || result2);
                                const hasDrawer = hasHistory || hasInsights || hasSingleRun;
                                const isExpanded = expandedHistory.has(index);

                                return (
                                    <React.Fragment key={index}>
                                        <TableRow>
                                            {/* sticky URL cell — same inset box-shadow trick */}
                                            <TableCell className={`sticky left-0 bg-background z-10 w-1/3 ${stickyBorder}`}>
                                                <div className="flex items-start gap-1">
                                                    {!copying && hasDrawer && (
                                                        <Hint label={isExpanded ? 'Hide the runs and insights for this URL' : 'Show the individual runs, Lighthouse insights and Claude analysis for this URL'}>
                                                        <button
                                                            onClick={() => toggleHistory(index)}
                                                            className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-muted transition-colors"
                                                        >
                                                            <ChevronDown
                                                                className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                                                            />
                                                        </button>
                                                        </Hint>
                                                    )}
                                                    <div className="flex-1">
                                                        <a href={url} target="_blank" rel="noopener noreferrer" className="break-all">
                                                            {url}
                                                        </a>
                                                        {getResultMessageForUrl(slot1, slot2)}
                                                        {!copying && ((showSide1 && slotHasError(slot1)) || (showSide2 && slotHasError(slot2))) && (
                                                            <div className="flex items-center gap-1 mt-1">
                                                                {((showSide1 && slotAllRunsFailed(slot1)) || (showSide2 && slotAllRunsFailed(slot2))) && (
                                                                    <span className="text-xs text-destructive">Audit failed.</span>
                                                                )}
                                                                {showSide1 && retryButton(index, slot1, setResults1, '1')}
                                                                {showSide2 && retryButton(index, slot2, setResults2, '2')}
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </TableCell>

                                            {cellMetrics(displayAudit.SI, slot1, slot2, result1?.speedIndex, result2?.speedIndex, 'speedIndex')}
                                            {cellMetrics(displayAudit.LCP, slot1, slot2, result1?.largestContentfulPaint, result2?.largestContentfulPaint, 'largestContentfulPaint')}
                                            {cellMetrics(displayAudit.CLS, slot1, slot2, result1?.cumulativeLayoutShift, result2?.cumulativeLayoutShift, 'cumulativeLayoutShift')}
                                            {cellMetrics(displayAudit.TBT, slot1, slot2, result1?.totalBlockingTime, result2?.totalBlockingTime, 'totalBlockingTime')}
                                            {cellMetrics(displayAudit.FCP, slot1, slot2, result1?.firstContentfulPaint, result2?.firstContentfulPaint, 'firstContentfulPaint')}
                                        </TableRow>

                                        {/* Details drawer row */}
                                        {hasDrawer && isExpanded && (
                                            <TableRow className="bg-muted/30">
                                                <TableCell colSpan={totalColCount} className="p-0">
                                                    <div className="px-4 py-3">
                                                        {/* Run spread: Before vs After runs on one axis — overlap = noise */}
                                                        {config.comparisonMode && history1 && history2 && showSide1 && showSide2 && (() => {
                                                            const cardKey = `spread-${index}`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className="mb-3 rounded-md border border-border bg-background p-3">
                                                                <Hint label={cardOpen ? 'Collapse the run spread' : 'Expand to see every Before and After run on one axis'} className="w-full">
                                                                <button onClick={() => toggleRunCard(cardKey)} className="flex w-full items-center gap-1 text-left mb-1.5">
                                                                    <p className="text-xs font-medium text-muted-foreground">Run spread — overlapping lanes mean noise, separated lanes mean a real change</p>
                                                                    <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                </button>
                                                                </Hint>
                                                                {cardOpen && (
                                                                    <RunSpreadStrip
                                                                        before={result1!}
                                                                        after={result2!}
                                                                        keys={shownMetricKeys()}
                                                                        labels={METRIC_LABELS}
                                                                        beforeLabel={config.beforeLabel}
                                                                        afterLabel={config.afterLabel}
                                                                        aggregation={config.aggregation}
                                                                    />
                                                                )}
                                                            </div>
                                                            );
                                                        })()}

                                                        {/* Slot 1: runs table + consolidated insights across those runs */}
                                                        {history1 && showSide1 && (() => {
                                                            const cardKey = `runs-${index}-1`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className={`rounded-md border border-border bg-background p-3 ${history2 ? 'mb-3' : ''}`}>
                                                                <Hint label={cardOpen ? 'Collapse the individual runs' : 'Expand to see each run and re-run any one of them'} className="w-full">
                                                                <button onClick={() => toggleRunCard(cardKey)} className="flex w-full items-center gap-1 text-left mb-1.5">
                                                                    <p className="text-xs font-medium text-muted-foreground">{displayAudit.singleResult ? 'Individual Runs' : `${config.beforeLabel} — Individual Runs`}</p>
                                                                    <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                </button>
                                                                </Hint>
                                                                {cardOpen && (
                                                                    <>
                                                                        {renderRunHistory(history1, index, '1')}
                                                                        {renderConsolidatedInsights(history1, `${index}-1`, undefined, insightChanges(index)?.before)}
                                                                    </>
                                                                )}
                                                            </div>
                                                            );
                                                        })()}

                                                        {/* Slot 2 (comparison mode) */}
                                                        {history2 && showSide2 && (() => {
                                                            const cardKey = `runs-${index}-2`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            const progress = reauditProgress[`2-${index}`];
                                                            const reauditing = progress !== undefined;
                                                            // Comparison mode only, and only while there are flagged (red) runs.
                                                            const flaggedCount = config.comparisonMode ? flaggedRunIndexes(index).length : 0;
                                                            return (
                                                            <div className="rounded-md border border-border bg-background p-3">
                                                                <div className="mb-1.5 flex items-center gap-1">
                                                                    <Hint label={cardOpen ? 'Collapse the individual runs' : 'Expand to see each run and re-run any one of them'} className="flex-1">
                                                                    <button onClick={() => toggleRunCard(cardKey)} className="flex w-full items-center gap-1 text-left">
                                                                        <p className="text-xs font-medium text-muted-foreground">{config.afterLabel} — Individual Runs</p>
                                                                    </button>
                                                                    </Hint>
                                                                    {!copying && (flaggedCount > 0 || reauditing) && (
                                                                        <Hint label={reauditing
                                                                            ? `Re-auditing run #${progress.run}, attempt ${progress.attempt} of ${REAUDIT_MAX_ATTEMPTS} — click to stop and keep the closest runs found`
                                                                            : `Re-audit the ${flaggedCount} flagged run${flaggedCount === 1 ? '' : 's'} (up to ${REAUDIT_MAX_ATTEMPTS} attempts each) until ${config.afterLabel} is no longer worse than ${config.beforeLabel}`}>
                                                                            <button
                                                                                onClick={() => reauditFlaggedRuns(index)}
                                                                                disabled={isAuditing || isRetryingAny || (isReauditingAny && !reauditing)}
                                                                                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none transition-colors ${reauditing ? 'text-primary' : 'text-error hover:text-foreground'}`}
                                                                                data-html2canvas-ignore="true"
                                                                            >
                                                                                <RotateCcw className={`h-3.5 w-3.5 text-primary ${reauditing ? 'animate-spin' : ''}`} />
                                                                                {reauditing
                                                                                    ? <span className="tabular-nums">#{progress.run} · {progress.attempt}/{REAUDIT_MAX_ATTEMPTS}</span>
                                                                                    : <span>Re-audit ({flaggedCount})</span>}
                                                                            </button>
                                                                        </Hint>
                                                                    )}
                                                                    <Hint label={cardOpen ? 'Collapse the individual runs' : 'Expand to see each run and re-run any one of them'}>
                                                                    <button onClick={() => toggleRunCard(cardKey)} className="inline-flex items-center p-0.5">
                                                                        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                    </button>
                                                                    </Hint>
                                                                </div>
                                                                {(() => {
                                                                    const notice = reauditNotice[`2-${index}`];
                                                                    if (!reauditing && !notice) return null;
                                                                    const tone = reauditing ? 'info' : notice!.tone;
                                                                    const styles = {
                                                                        success: { box: 'border-success/40 bg-success/10', icon: CircleCheck, color: 'text-success' },
                                                                        info: { box: 'border-info/40 bg-info/10', icon: Info, color: 'text-info' },
                                                                        warning: { box: 'border-warning/40 bg-warning/10', icon: CircleAlert, color: 'text-warning' },
                                                                    }[tone];
                                                                    const Icon = styles.icon;
                                                                    return (
                                                                        <div role="status" aria-live="polite" className={`mb-2 flex items-start gap-2 rounded-md border px-2 py-1.5 text-xs ${styles.box}`}>
                                                                            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${styles.color} ${reauditing ? 'animate-pulse' : ''}`} />
                                                                            <div className="flex-1">
                                                                                <span>
                                                                                    {reauditing
                                                                                        ? `Re-auditing flagged run #${progress.run}, attempt ${progress.attempt} of ${REAUDIT_MAX_ATTEMPTS}. Click the re-audit button again to stop.`
                                                                                        : notice!.text}
                                                                                </span>
                                                                                {!reauditing && notice!.details.length > 0 && (
                                                                                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                                                                                        {notice!.details.map(line => <li key={line}>{line}</li>)}
                                                                                    </ul>
                                                                                )}
                                                                            </div>
                                                                            {!reauditing && !copying && (
                                                                                <Hint label="Dismiss">
                                                                                    <button onClick={() => dismissReauditNotice(`2-${index}`)} className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Dismiss" data-html2canvas-ignore="true">
                                                                                        <X className="h-3 w-3" />
                                                                                    </button>
                                                                                </Hint>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })()}
                                                                {cardOpen && (() => {
                                                                    const warm = config.comparisonMode && !reauditing
                                                                        ? detectWarmUp(result1, result2, shownMetricKeys(), config.aggregation)
                                                                        : null;
                                                                    if (!warm) return null;
                                                                    return (
                                                                        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-info/40 bg-info/10 px-2 py-1.5 text-xs">
                                                                            <Snowflake className="h-3.5 w-3.5 shrink-0 text-info" />
                                                                            <span className="flex-1">
                                                                                Run{warm.runs.length > 1 ? 's' : ''} {runRange(warm.runs)} {warm.runs.length > 1 ? 'were' : 'was'} slow, then results settled. This looks like a cold cache after deploy, not a code change.
                                                                                {!config.warmUpRun && ' Turn on Warm-up run in Configuration to skip it next time.'}
                                                                            </span>
                                                                            {!copying && (
                                                                                <button
                                                                                    onClick={() => reauditFlaggedRuns(index)}
                                                                                    disabled={isAuditing || isRetryingAny || isReauditingAny}
                                                                                    className="rounded border border-border px-1.5 py-0.5 text-[11px] font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                                                    data-html2canvas-ignore="true"
                                                                                >
                                                                                    Re-audit {warm.runs.length > 1 ? 'them' : 'it'}
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })()}
                                                                {cardOpen && (
                                                                    <>
                                                                        {renderRunHistory(history2, index, '2')}
                                                                        {renderConsolidatedInsights(history2, `${index}-2`, undefined, insightChanges(index)?.after)}
                                                                    </>
                                                                )}
                                                            </div>
                                                            );
                                                        })()}

                                                        {/* Single-run slots (no run history): per-slot label + Re-run, then insights */}
                                                        {!history1 && result1 && showSide1 && (() => {
                                                            const cardKey = `single-${index}-1`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className="mt-3 rounded-md border border-border bg-background p-3">
                                                                <div className="mb-1.5 flex items-center gap-2">
                                                                    <Hint label={cardOpen ? 'Collapse these details' : 'Expand the Lighthouse insights for this result'} className="flex-1">
                                                                    <button onClick={() => toggleRunCard(cardKey)} className="flex flex-1 items-center gap-2 text-left">
                                                                        <p className="text-xs font-semibold text-foreground">{displayAudit.singleResult ? 'Details' : config.beforeLabel}</p>
                                                                        <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                    </button>
                                                                    </Hint>
                                                                    {singleRunRerunButton(index, setResults1, '1')}
                                                                </div>
                                                                {cardOpen && renderInsights(result1, `${index}-1`, undefined, insightChanges(index)?.before)}
                                                            </div>
                                                            );
                                                        })()}

                                                        {!history2 && result2 && showSide2 && (() => {
                                                            const cardKey = `single-${index}-2`;
                                                            const cardOpen = !collapsedRunCards.has(cardKey);
                                                            return (
                                                            <div className="mt-3 rounded-md border border-border bg-background p-3">
                                                                <div className="mb-1.5 flex items-center gap-2">
                                                                    <Hint label={cardOpen ? 'Collapse these details' : 'Expand the Lighthouse insights for this result'} className="flex-1">
                                                                    <button onClick={() => toggleRunCard(cardKey)} className="flex flex-1 items-center gap-2 text-left">
                                                                        <p className="text-xs font-semibold text-foreground">{config.afterLabel}</p>
                                                                        <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${cardOpen ? 'rotate-180' : ''}`} data-html2canvas-ignore="true" />
                                                                    </button>
                                                                    </Hint>
                                                                    {singleRunRerunButton(index, setResults2, '2')}
                                                                </div>
                                                                {cardOpen && renderInsights(result2, `${index}-2`, undefined, insightChanges(index)?.after)}
                                                            </div>
                                                            );
                                                        })()}

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
            </CardContent>
        </Card>
    );
});

export default PageSpeedResults;