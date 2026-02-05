import React, { useState } from 'react';
import { usePageSpeedInsight } from '../../hooks/usePageSpeedInsight';
import { Trash2, Loader2, Plus, X, RotateCcw, Clipboard, Play, Settings2 } from 'lucide-react';
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Button, Input } from '../ui';
import type { PageSpeedInsightResult, PageSpeedMetricDetails, PageSpeedMetrics } from '@/types/pageSpeedInsight.types';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';

export const PageSpeedResults: React.FC = () => {
    const [urls, setUrls] = useState<string[]>(['']);

    const {
        config,
        result,
        generateBefore,
        generateAfter,
        setApiKey,
        setStrategy,
        removeResult,
        reset
    } = usePageSpeedInsight();

    const { elementRef, copyAsImage, isCopying } = useCopyElementAsImage({
        fileNamePrefix: `pagespeed-result-${Date.now()}`,
    });
    const [selected, setSelected] = useState<string[]>(['SI', 'LCP', 'CLS', 'TBT', 'FCP']);
    const [showIMP, setShowIMP] = useState(true);
    const [showBefore, setShowBefore] = useState(true);
    const [showAfter, setShowAfter] = useState(true);
    const [copying, setCopying] = useState(false);
    const [beforeLabel, setBeforeLabel] = useState('');
    const [afterLabel, setAfterLabel] = useState('');
    const [generation, setGeneration] = useState(1);
    const isAfterGeneration = (generation & 1) === 0;
    const beforeGenerationLabel = beforeLabel || 'Before';
    const afterGenerationLabel = afterLabel || 'After';
    const runLabel = !isAfterGeneration ?
        `Run ${beforeGenerationLabel}` :
        `Run ${afterGenerationLabel}`;

    const addUrlField = () => {
        setUrls([...urls, '']);
    };

    const updateUrl = (index: number, value: string) => {
        const newUrls = [...urls];
        newUrls[index] = value;
        setUrls(newUrls);
    };

    const removeUrlField = (index: number) => {
        const newUrls = urls.filter((_, i) => i !== index);
        setUrls(newUrls);

        // Also remove from results if exists
        const removedUrl = urls[index];
        if (removedUrl) {
            removeResult(removedUrl);
        }

        if (urls.length === 0) {
            setGeneration(1);
        }
    };

    const runAllBefore = async () => {
        const validUrls = urls.filter(url => url.trim() !== '');
        for (const url of validUrls) {
            await generateBefore(url);
        }
    };

    const runAllAfter = async () => {
        const validUrls = urls.filter(url => url.trim() !== '');
        for (const url of validUrls) {
            await generateAfter(url);
        }
    };

    const calculateImprovement = (before: number, after: number): string => {
        if (!before || !after) return '-';
        const improvement = ((before - after) / before) * 100;
        const formatted = improvement.toFixed(2);
        return improvement > 0 ? `+${formatted}%` : `${formatted}%`;
    };

    const getCellValue = (metric: PageSpeedMetricDetails | undefined): string => {
        return metric?.displayValue ?? '-';
    };

    const getResultForUrl = (url: string) => {
        return result.find(r => r.url === url);
    };

    const onCheckedChange = (checked: boolean, id: string) => {
        if (checked) {
            setSelected([...selected, id]);
        } else {
            setSelected(selected.filter(item => item !== id));
        }
    };

    const onClearUrls = () => {
        setUrls(['']);
        setGeneration(1);
    };

    const onCopyAsImage = async () => {
        setCopying(true);
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
            await copyAsImage();
        } catch (error) {
            console.error("Failed to copy image:", error);
        } finally {
            setCopying(false);
        }
    };

    const run = async () => {
        if (!isAfterGeneration) {
            await runAllBefore();
        }
        else {
            await runAllAfter();
        }
        setGeneration(generation + 1);
    }

    const getMessages = (metrics?: PageSpeedMetrics | null): string | null => {
        const messages: string[] = [];

        if (metrics?.errorResponse?.message?.trim()) {
            messages.push(metrics.errorResponse.message.trim());
        }

        if (metrics?.runWarnings) {
            if (Array.isArray(metrics.runWarnings)) {
                // If it's an array, join them
                const warnings = metrics.runWarnings.filter(w => w?.trim()).join(', ');
                if (warnings) messages.push(warnings);
            } else if (typeof metrics.runWarnings === 'string') {
                // If it's a string
                const warning = metrics.runWarnings.trim();
                if (warning) messages.push(warning);
            }
        }

        return messages.length > 0 ? messages.join(' | ') : null;
    }

    const showSI = selected.includes('SI');
    const showLCP = selected.includes('LCP');
    const showCLS = selected.includes('CLS');
    const showTBT = selected.includes('TBT');
    const showFCP = selected.includes('FCP');
    const thSpan = (!showBefore || !showAfter) ? 1 : (showIMP ? 3 : 2);

    const cellMetrics = (result: PageSpeedInsightResult | undefined, show: boolean, before: PageSpeedMetricDetails | undefined, after: PageSpeedMetricDetails | undefined) => {
        return (
            <>
                {show && (
                    <>
                        {showBefore && (
                            <TableCell className="text-center border">
                                {result?.generatingBefore ?
                                    <Loader2 className="animate-spin mx-auto" size={20} /> :
                                    getCellValue(before)}
                            </TableCell>
                        )}
                        {showAfter && (
                            <TableCell className="text-center border">
                                {result?.generatingAfter ?
                                    <Loader2 className="animate-spin mx-auto" size={20} /> :
                                    getCellValue(after)}
                            </TableCell>
                        )}
                        {showBefore && showAfter && showIMP && (
                            <TableCell className="text-center border">
                                {before && after ? calculateImprovement(before.numericValue, after.numericValue) : '-'}
                            </TableCell>
                        )}
                    </>
                )}
            </>
        );
    }

    return (
        <>
            <div className="flex w-full justify-end mb-5">
                <div className="flex gap-2 items-center">
                    <Input type="text" value={config.apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        size={50} placeholder="Enter your PageSpeed API key"
                    />
                    <Select defaultValue={config.strategy} onValueChange={setStrategy} >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                            <SelectGroup>
                                <SelectItem value="mobile">Mobile</SelectItem>
                                <SelectItem value="desktop">Desktop</SelectItem>
                            </SelectGroup>
                        </SelectContent>
                    </Select>
                    <Button variant="outline" size="sm" title="Run page speed insight"
                        onClick={run}
                        disabled={!config.apiKey || urls.every(url => !url.trim())}>
                        <Play size={18} /> {runLabel}
                    </Button>
                    <div className="h-6 w-px bg-gray-600 mx-2"></div>
                    <Button variant="outline" size="sm" title="Reset page speed results"
                        onClick={reset}>
                        <RotateCcw size={18} /> Reset
                    </Button>
                </div>
            </div>

            <div className="flex w-full items-center justify-between">
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" title="Add Url"
                        onClick={addUrlField}>
                        <Plus size={18} /> Add
                    </Button>
                    <Button variant="outline" size="sm" title="Remove all urls"
                        onClick={onClearUrls}>
                        <Trash2 size={18} /> Clear
                    </Button>

                </div>
                <div className="flex justify-end items-center gap-2">
                    <Input type="text" value={beforeLabel}
                        onChange={(e) => setBeforeLabel(e.target.value)}
                        placeholder="Enter before label"
                    />
                    <Button variant="outline" size="sm" title={`Run ${beforeLabel}`}
                        disabled={!config.apiKey || urls.every(url => !url.trim())} onClick={() => runAllBefore()}>
                        <Play size={18} />
                    </Button>
                    <Input type="text" value={afterLabel}
                        onChange={(e) => setAfterLabel(e.target.value)}
                        placeholder="Enter after label"
                    />
                    <Button variant="outline" size="sm" title={`Run ${afterLabel}`}
                        disabled={!config.apiKey || urls.every(url => !url.trim())} onClick={() => runAllAfter()}>
                        <Play size={18} />
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="outline"
                                size="sm"
                                className="ml-auto hidden h-8 lg:flex"
                            >
                                <Settings2 />
                                View
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-[150px]">
                            <DropdownMenuLabel>Metrics</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem key="SI" className="capitalize" checked={selected.includes('SI')} onCheckedChange={(value) => onCheckedChange(value, 'SI')}>
                                SI
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem key="LCP" className="capitalize" checked={selected.includes('LCP')} onCheckedChange={(value) => onCheckedChange(value, 'LCP')}>
                                LCP
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem key="CLS" className="capitalize" checked={selected.includes('CLS')} onCheckedChange={(value) => onCheckedChange(value, 'CLS')}>
                                CLS
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem key="TBT" className="capitalize" checked={selected.includes('TBT')} onCheckedChange={(value) => onCheckedChange(value, 'TBT')}>
                                TBT
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem key="FCP" className="capitalize" checked={selected.includes('FCP')} onCheckedChange={(value) => onCheckedChange(value, 'FCP')}>
                                FCP
                            </DropdownMenuCheckboxItem>

                            <DropdownMenuSeparator />
                            <DropdownMenuCheckboxItem key="Before" className="capitalize" checked={showBefore}
                                onCheckedChange={(value) => setShowBefore(value)}>
                                {beforeGenerationLabel}
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem key="After" className="capitalize" checked={showAfter}
                                onCheckedChange={(value) => setShowAfter(value)}>
                                {afterGenerationLabel}
                            </DropdownMenuCheckboxItem>
                            <DropdownMenuCheckboxItem key="IMP" className="capitalize" checked={showIMP} onCheckedChange={(value) => setShowIMP(value)}>
                                Improvement
                            </DropdownMenuCheckboxItem>

                        </DropdownMenuContent>
                    </DropdownMenu>

                    <div className="h-6 w-px bg-gray-600 mx-2"></div>
                    <Button variant="outline" size="sm" onClick={onCopyAsImage}
                        disabled={copying} title="Copy results as image">
                        {copying && (
                            <>
                                <Loader2 size={18} className="animate-spin mx-auto text-white" /> Copying...
                            </>
                        )}
                        {!copying && (
                            <>
                                <Clipboard size={18} className="mx-auto" /> Copy as image
                            </>
                        )}
                    </Button>
                </div>
            </div>
            <div className="overflow-hidden rounded-md border">
                <Table ref={elementRef}>
                    <TableHeader>
                        <TableRow>
                            <TableHead rowSpan={2} className="border text-center sticky left-0 bg-background">
                                URL
                            </TableHead>
                            {showSI && (
                                <TableHead colSpan={thSpan} className="text-center border">Speed Index</TableHead>
                            )}
                            {showLCP && (
                                <TableHead colSpan={thSpan} className="text-center border">LCP</TableHead>
                            )}
                            {showCLS && (
                                <TableHead colSpan={thSpan} className="text-center border">CLS</TableHead>
                            )}
                            {showTBT && (
                                <TableHead colSpan={thSpan} className="text-center border">TBT</TableHead>
                            )}
                            {showFCP && (
                                <TableHead colSpan={thSpan} className="text-center border">FCP</TableHead>
                            )}
                        </TableRow>
                        {(showBefore && showAfter) && (
                            <TableRow>
                                {[...Array(selected.length)].map((_, i) => (
                                    <React.Fragment key={i}>
                                        <TableHead className="text-center text-sm border">{beforeGenerationLabel}</TableHead>
                                        <TableHead className="text-center text-sm border">{afterGenerationLabel}</TableHead>
                                        {showIMP && (
                                            <TableHead className="text-center text-sm border">Improvement</TableHead>
                                        )}
                                    </React.Fragment>
                                ))}
                            </TableRow>
                        )}
                    </TableHeader>
                    <TableBody>
                        {urls.map((url, index) => {
                            const urlResult = getResultForUrl(url);
                            const beforeMsg = getMessages(urlResult?.before);
                            const afterMsg = getMessages(urlResult?.after);
                            return (
                                <TableRow key={index} className="border">
                                    <TableCell className="border sticky left-0 bg-background z-10">
                                        <div className="flex items-center gap-2">
                                            {copying && (
                                                <label>{url}</label>
                                            )}

                                            {!copying && (
                                                <div className="relative w-full">

                                                    <Input
                                                        type="text"
                                                        placeholder="https://example.com"
                                                        value={url}
                                                        onChange={(e) => updateUrl(index, e.target.value)}
                                                        className="w-full min-w-[250px]"
                                                    />
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="absolute right-1 top-1/2 transform -translate-y-1/2 h-7 w-7 p-0"
                                                        onClick={() => removeUrlField(index)}
                                                    >
                                                        <X className="h-4 w-4" />
                                                    </Button>

                                                </div>
                                            )}

                                        </div>
                                        {(() => {
                                            return beforeMsg && (
                                                <p className="text-xs text-red-500 mt-1">
                                                    * {beforeMsg}
                                                </p>
                                            );
                                        })()}

                                        {(() => {
                                            return afterMsg && (
                                                <p className="text-xs text-red-500 mt-1">
                                                    * {afterMsg}
                                                </p>
                                            );
                                        })()}
                                    </TableCell>

                                    {cellMetrics(urlResult, showSI, urlResult?.before?.speedIndex, urlResult?.after?.speedIndex)}
                                    {cellMetrics(urlResult, showLCP, urlResult?.before?.largestContentfulPaint, urlResult?.after?.largestContentfulPaint)}
                                    {cellMetrics(urlResult, showCLS, urlResult?.before?.cumulativeLayoutShift, urlResult?.after?.cumulativeLayoutShift)}
                                    {cellMetrics(urlResult, showTBT, urlResult?.before?.totalBlockingTime, urlResult?.after?.totalBlockingTime)}
                                    {cellMetrics(urlResult, showFCP, urlResult?.before?.firstContentfulPaint, urlResult?.after?.firstContentfulPaint)}

                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>

        </>
    );
};

export default PageSpeedResults;