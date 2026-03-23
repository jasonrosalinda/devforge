import React, { useState } from 'react';
import { usePageSpeedInsight } from '../../hooks/usePageSpeedInsight';
import { Loader2, Monitor, Smartphone } from 'lucide-react';
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button, Toast } from '../ui';
import type { PageSpeedInsightResult, PageSpeedMetrics, PageSpeedConfiguration, PageSpeedInsightResultMessage } from '@shared/types/pageSpeedInsight.types';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { displayPageSpeedAudit, getPageSpeedInsightResultMessages } from '@/lib/pageSpeedUtils';
import { isNullOrEmpty } from '@shared/utils/stringHelper';

type AuditSlot = PageSpeedInsightResult | null | false | undefined;

interface PageSpeedResultsProps {
    config: PageSpeedConfiguration;
    onAuditingChange?: (isAuditing: boolean) => void;
}

// Inset box-shadow fakes borders on sticky cells — real borders get painted
// under the sticky background, but box-shadow renders above it.
// right + bottom edges only (left edge is the table boundary)
const stickyBorder = 'shadow-[inset_-1px_-1px_0_hsl(var(--border))]';

export const PageSpeedResults: React.FC<PageSpeedResultsProps> = ({ config, onAuditingChange }) => {
    const { audit, clearCache } = usePageSpeedInsight(config);
    const { elementRef, copyAsImage } = useCopyElementAsImage({
        fileNamePrefix: `pagespeed-result-${config.strategy}-${Date.now()}`,
    });

    const [copying, setCopying] = useState(false);
    const [results1, setResults1] = useState<AuditSlot[]>([]);
    const [results2, setResults2] = useState<AuditSlot[]>([]);
    const [auditing1, setAuditing1] = useState(false);
    const [auditing2, setAuditing2] = useState(false);

    const displayAudit = displayPageSpeedAudit(config);
    const showAnalyzeButton = config.urls.length > 0 && (!config.browserMode ? !isNullOrEmpty(config.apiKey) : true);
    const toast = Toast();
    const isAuditing = auditing1 || auditing2;
    const hasSubHead = !!(displayAudit.before && displayAudit.after);

    const setAuditingWithCallback = (
        setter: React.Dispatch<React.SetStateAction<boolean>>,
        value: boolean,
        otherAuditing: boolean,
    ) => {
        setter(value);
        onAuditingChange?.(value || otherAuditing);
    };

    const runAudit = async (
        setResults: React.Dispatch<React.SetStateAction<AuditSlot[]>>,
        setAuditing: React.Dispatch<React.SetStateAction<boolean>>,
        otherAuditing: boolean,
    ): Promise<void> => {
        setAuditingWithCallback(setAuditing, true, otherAuditing);
        setResults(new Array(config.urls.length).fill(null));
        await clearCache();

        for (const [index, url] of config.urls.entries()) {
            try {
                const result = await audit(url);
                setResults(prev => {
                    const next = [...prev];
                    next[index] = result;
                    return next;
                });
            } catch (error) {
                console.error(`Audit failed for ${url}:`, error);
                setResults(prev => {
                    const next = [...prev];
                    next[index] = false;
                    return next;
                });
            }
        }

        setAuditingWithCallback(setAuditing, false, otherAuditing);
    };

    const audit1 = () => runAudit(setResults1, setAuditing1, auditing2);
    const audit2 = () => runAudit(setResults2, setAuditing2, auditing1);

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
        return messages.map((message, index) => (
            <p key={index} className={`text-xs ${message.isError ? 'text-red-500' : 'text-orange-500'} mt-1`}>
                * {message.message}
            </p>
        ));
    };

    const cellValue = (slot: AuditSlot, metric: PageSpeedMetrics | undefined): React.ReactNode => {
        if (slot === null) return <Loader2 className="animate-spin mx-auto" size={20} />;
        if (slot === false) return <span className="text-red-500 text-xs">Error</span>;
        if (slot === undefined) return <span>-</span>;
        return metric?.displayValue ?? '-';
    };

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
                        {config.strategy === 'mobile' ? <Smartphone size={20} /> : <Monitor size={20} />}
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

                                return (
                                    <TableRow key={index}>
                                        {/* sticky URL cell — same inset box-shadow trick */}
                                        <TableCell className={`sticky left-0 bg-background z-10 w-1/3 ${stickyBorder}`}>
                                            <a href={url} target="_blank" rel="noopener noreferrer" className="break-all">
                                                {url}
                                            </a>
                                            {getResultMessageForUrl(slot1, slot2)}
                                        </TableCell>

                                        {cellMetrics(displayAudit.SI, slot1, slot2, result1?.speedIndex, result2?.speedIndex)}
                                        {cellMetrics(displayAudit.LCP, slot1, slot2, result1?.largestContentfulPaint, result2?.largestContentfulPaint)}
                                        {cellMetrics(displayAudit.CLS, slot1, slot2, result1?.cumulativeLayoutShift, result2?.cumulativeLayoutShift)}
                                        {cellMetrics(displayAudit.TBT, slot1, slot2, result1?.totalBlockingTime, result2?.totalBlockingTime)}
                                        {cellMetrics(displayAudit.FCP, slot1, slot2, result1?.firstContentfulPaint, result2?.firstContentfulPaint)}
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                </div>
            </CardContent>
        </Card>
    );
};

export default PageSpeedResults;