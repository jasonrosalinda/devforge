import React, { useState } from 'react';
import { usePageSpeedInsight } from '../../hooks/usePageSpeedInsight';
import { Loader2, Monitor, Smartphone } from 'lucide-react';
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button, Toast } from '../ui';
import type { PageSpeedInsightResult, PageSpeedMetrics, PageSpeedConfiguration, PageSpeedInsightResultMessage } from '@shared/types/pageSpeedInsight.types';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { displayPageSpeedAudit, getPageSpeedInsightResultMessages } from '@/lib/pageSpeedUtils';

export const PageSpeedResults: React.FC<{ config: PageSpeedConfiguration }> = ({ config }) => {
    const { audit } = usePageSpeedInsight(config);
    const { elementRef, copyAsImage } = useCopyElementAsImage({
        fileNamePrefix: `pagespeed-result-${config.strategy}-${Date.now()}`,
    });
    const [copying, setCopying] = useState(false);
    const displayAudit = displayPageSpeedAudit(config);
    const [results1, setResults1] = useState<PageSpeedInsightResult[]>([]);
    const [results2, setResults2] = useState<PageSpeedInsightResult[]>([]);
    const [auditing1, setAuditing1] = useState<boolean>(false);
    const [auditing2, setAuditing2] = useState<boolean>(false);
    const showAnalyzeButton = config.urls.length > 0;
    const toast = Toast();
    const isAuditing = auditing1 || auditing2;

    const audit1 = async () => {
        setAuditing1(true);
        setResults1([]);
        const results = await runAudit();
        setResults1(results);
        setAuditing1(false);
    }

    const audit2 = async () => {
        setAuditing2(true);
        setResults2([]);
        const results = await runAudit();
        setResults2(results);
        setAuditing2(false);
    }

    const runAudit = async (): Promise<PageSpeedInsightResult[]> => {
        const results: PageSpeedInsightResult[] = [];
        await Promise.all(
            config.urls.map(async url => {
                const result = await audit(url);
                results.push(result);
            })
        );
        return results;
    }

    const calculateImprovement = (before: number, after: number): React.ReactNode => {
        if (!before || !after) return (
            <div>
                -
            </div>
        );
        const improvement = ((before - after) / before) * 100;
        const formatted = improvement.toFixed(2);
        const color = improvement >= 0 ? 'text-green-500' :
            (Math.abs(improvement) > config.improvementThreshold) ? 'text-red-500' : 'text-orange-500';
        return (
            <div className={color}>
                {improvement > 0 ? `+${formatted}%` : `${formatted}%`}
            </div>
        )
    };

    const onCopyAsImage = async () => {
        setCopying(true);
        await new Promise(resolve => setTimeout(resolve, 1000));
        toast.promise(copyAsImage(), {
            loading: "Copying...",
            success: "Copied successfully",
            error: "Copy failed",
        });
        setCopying(false);
    };

    const thSpan = (!displayAudit.before || !displayAudit.after) ? 1 : (displayAudit.improvement ? 3 : 2);

    const tableHead = (label: string): React.ReactNode => {
        return (
            <TableHead colSpan={thSpan} className="text-center border">{label}</TableHead>
        );
    }
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
    }

    const getResult1ForUrl = (url: string): PageSpeedInsightResult | undefined => {
        return results1.find(r => r.url === url);
    }

    const getResult2ForUrl = (url: string): PageSpeedInsightResult | undefined => {
        return results2.find(r => r.url === url);
    }

    const getResultMessageForUrl = (result1: PageSpeedInsightResult | undefined, result2: PageSpeedInsightResult | undefined): React.ReactNode => {
        let messages: PageSpeedInsightResultMessage[] = getPageSpeedInsightResultMessages(result1, result2);
        return (
            messages.map((message, index) => (
                <p key={index} className={`text-xs ${message.isError ? 'text-red-500' : 'text-orange-500'} mt-1`}>
                    * {message.message}
                </p>
            ))
        );
    }

    const cellMetrics = (show: boolean, metrics1: PageSpeedMetrics | undefined, metrics2: PageSpeedMetrics | undefined) => {
        return (
            <>
                {show && (
                    <>
                        <TableCell className="text-center border">
                            {auditing1 ?
                                <Loader2 className="animate-spin mx-auto" size={20} /> :
                                cellValue(metrics1)}
                        </TableCell>
                        {!displayAudit.singleResult && (
                            <TableCell className="text-center border">
                                {auditing2 ?
                                    <Loader2 className="animate-spin mx-auto" size={20} /> :
                                    cellValue(metrics2)}
                            </TableCell>
                        )}
                        {!displayAudit.singleResult && displayAudit.improvement && (
                            <TableCell className="text-center border">
                                {isAuditing ?
                                    <Loader2 className="animate-spin mx-auto" size={20} /> :
                                    metrics1 && metrics2 ? calculateImprovement(metrics1.numericValue, metrics2.numericValue) : '-'}
                            </TableCell>
                        )}
                    </>
                )}
            </>
        );
    }

    const cellValue = (metric: PageSpeedMetrics | undefined): string => {
        return metric?.displayValue ?? '-';
    };

    return (
        <Card className="my-4" ref={elementRef}>
            <CardHeader>
                <CardTitle className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        {config.strategy == 'mobile' ? <Smartphone size={20} /> : <Monitor size={20} />}
                        {config.strategy.toUpperCase()}
                    </div>
                    {!copying && showAnalyzeButton && (
                        <div className="flex items-center gap-2">
                            {config.comparisonMode && (
                                <>
                                    <Button variant="outline" onClick={audit1} disabled={isAuditing}>Analyze {config.beforeLabel}</Button>
                                    <Button variant="outline" onClick={audit2} disabled={isAuditing}>Analyze {config.afterLabel}</Button>
                                </>
                            )}
                            {!config.comparisonMode && (
                                <Button variant="outline" onClick={audit1} disabled={isAuditing}>Analyze</Button>
                            )}
                            <Button variant="outline" onClick={onCopyAsImage} disabled={copying || isAuditing}>Copy as Image</Button>
                        </div>
                    )}

                </CardTitle>
            </CardHeader>
            <CardContent>

                <div className="overflow-auto rounded-md border scrollable-content">
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead rowSpan={2} className="border text-center sticky left-0 bg-background mr-2">
                                    URL
                                </TableHead>
                                {displayAudit.SI && tableHead('SI')}
                                {displayAudit.LCP && tableHead('LCP')}
                                {displayAudit.CLS && tableHead('CLS')}
                                {displayAudit.TBT && tableHead('TBT')}
                                {displayAudit.FCP && tableHead('FCP')}
                            </TableRow>
                            {(displayAudit.before && displayAudit.after) && (
                                <TableRow>
                                    {tableSubHead()}
                                </TableRow>
                            )}
                        </TableHeader>
                        <TableBody>
                            {config.urls.map((url, index) => {
                                const result1 = getResult1ForUrl(url);
                                const result2 = getResult2ForUrl(url);

                                return (
                                    <TableRow key={index} className="border">
                                        <TableCell className="border sticky left-0 bg-background z-10 w-1/3">
                                            <a href={url} target="_blank" rel="noopener noreferrer" className='break-all'>{url}</a>
                                            {getResultMessageForUrl(result1, result2)}
                                        </TableCell>

                                        {cellMetrics(displayAudit.SI, result1?.speedIndex, result2?.speedIndex)}
                                        {cellMetrics(displayAudit.LCP, result1?.largestContentfulPaint, result2?.largestContentfulPaint)}
                                        {cellMetrics(displayAudit.CLS, result1?.cumulativeLayoutShift, result2?.cumulativeLayoutShift)}
                                        {cellMetrics(displayAudit.TBT, result1?.totalBlockingTime, result2?.totalBlockingTime)}
                                        {cellMetrics(displayAudit.FCP, result1?.firstContentfulPaint, result2?.firstContentfulPaint)}

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