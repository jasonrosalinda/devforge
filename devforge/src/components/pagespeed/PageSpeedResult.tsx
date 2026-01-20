import React, { useState } from 'react';
import { usePageSpeedInsight } from '../../hooks/usePageSpeedInsight';
import { Trash2, Loader2, Plus, X, ChevronFirst, ChevronLast, RotateCcw, Clipboard } from 'lucide-react';
import { CardModule } from '../ui/CardModule';
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';

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
    const [selected, setSelected] = useState<string[]>(['SI', 'LCP', 'CLS']);
    const [showIMP, setShowIMP] = useState(false);
    const [copying, setCopying] = useState(false);
    const [beforeLabel, setBeforeLabel] = useState('');
    const [afterLabel, setAfterLabel] = useState('');

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

    const formatMetricValue = (value: number | null | undefined): string => {
        return value !== null && value !== undefined ? value.toFixed(3) : '-';
    };

    const getResultForUrl = (url: string) => {
        return result.find(r => r.url === url);
    };

    const handleCheck = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.checked) {
            setSelected([...selected, e.target.id]);
        } else {
            setSelected(selected.filter(item => item !== e.target.id));
        }
    };

    const onClearUrls = () => {
        setUrls(['']);
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

    const showSI = selected.includes('SI');
    const showLCP = selected.includes('LCP');
    const showCLS = selected.includes('CLS');
    const showTBT = selected.includes('TBT');
    const showFCP = selected.includes('FCP');
    const thSpan = showIMP ? 3 : 2;

    return (
        <CardModule
            header={
                <div className="flex items-start gap-4 flex-wrap justify-between w-full">
                    <div className="flex flex-col items-start gap-2 flex-1 justify-start max-w-xl">
                        <div className="flex items-center gap-2">
                            <button className="p-2 text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title="Add Url"
                                onClick={addUrlField}>
                                <Plus size={18} />
                            </button>
                            <div className="h-6 w-px bg-gray-600 mx-2"></div>
                            <button className="p-2 text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Run pre-release"
                                onClick={runAllBefore}
                                disabled={!config.apiKey || urls.every(url => !url.trim())}>
                                <ChevronFirst size={18} />
                            </button>
                            <button className="p-2 text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                title="Run post-release"
                                onClick={runAllAfter}
                                disabled={!config.apiKey || urls.every(url => !url.trim())}>
                                <ChevronLast size={18} />
                            </button>
                            <div className="h-6 w-px bg-gray-600 mx-2"></div>
                            <button className="p-2 text-white hover:bg-red-900/50 rounded-lg transition-colors"
                                title="Reset page speed generation" onClick={reset}>
                                <RotateCcw size={18} />
                            </button>
                            <button className="p-2 text-white hover:bg-red-900/50 rounded-lg transition-colors"
                                title="Remove all urls" onClick={onClearUrls}>
                                <Trash2 size={18} />
                            </button>

                            <button
                                onClick={onCopyAsImage}
                                disabled={copying} title="Copy results as image"
                                className="p-2 text-white hover:bg-gray-800 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {copying && <Loader2 size={18} className="animate-spin mx-auto text-white" />}
                                {!copying && <Clipboard size={18} />}
                            </button>

                        </div>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={beforeLabel}
                                onChange={(e) => setBeforeLabel(e.target.value)}
                                placeholder="Enter before label"
                                className="w-full max-w-xs px-4 py-2 border border-gray-700 bg-gray-800 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none placeholder:text-gray-500"
                            />
                            <input
                                type="text"
                                value={afterLabel}
                                onChange={(e) => setAfterLabel(e.target.value)}
                                placeholder="Enter after label"
                                className="w-full max-w-xs px-4 py-2 border border-gray-700 bg-gray-800 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none placeholder:text-gray-500"
                            />
                        </div>
                    </div>

                    <div className="flex flex-col items-end gap-2 flex-1 justify-end max-w-xl">
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                value={config.apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                size={30}
                                placeholder="Enter your PageSpeed API key"
                                className="w-full max-w-sm px-4 py-2 border border-gray-700 bg-gray-800 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none placeholder:text-gray-500"
                            />
                            <select
                                value={config.strategy}
                                onChange={(e) => setStrategy(e.target.value)}
                                className="w-32 px-3 py-2 border border-gray-700 bg-gray-800 text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none bg-gray-800"
                            >
                                <option value="mobile">Mobile</option>
                                <option value="desktop">Desktop</option>
                            </select>
                        </div>
                        <div className="flex items-center gap-2">

                            <div className="flex items-center gap-5">
                                <div>
                                    <input id="SI" type="checkbox" className="accent-gray-700" onChange={handleCheck} checked={selected.includes('SI')} />
                                    <label htmlFor="SI" title="Speed Index" className="ml-2">SI</label>
                                </div>
                                <div>
                                    <input id="LCP" type="checkbox" className="accent-gray-700" onChange={handleCheck} checked={selected.includes('LCP')} />
                                    <label htmlFor="LCP" title="Largest Contentful Paint" className="ml-2">LCP</label>
                                </div>
                                <div>
                                    <input id="CLS" type="checkbox" className="accent-gray-700" onChange={handleCheck} checked={selected.includes('CLS')} />
                                    <label htmlFor="CLS" title="Cumulative Layout Shift" className="ml-2">CLS</label>
                                </div>
                                <div>
                                    <input id="TBT" type="checkbox" className="accent-gray-700" onChange={handleCheck} checked={selected.includes('TBT')} />
                                    <label htmlFor="TBT" title="Total Blocking Time" className="ml-2">TBT</label>
                                </div>
                                <div>
                                    <input id="FCP" type="checkbox" className="accent-gray-700" onChange={handleCheck} checked={selected.includes('FCP')} />
                                    <label htmlFor="FCP" title="First Contentful Paint" className="ml-2">FCP</label>
                                </div>
                            </div>

                            <div className="h-6 w-px bg-gray-600 mx-2"></div>
                            <input id="IMP" type="checkbox" className="accent-gray-700" onChange={(e) => setShowIMP(e.target.checked)}
                                checked={showIMP} />
                            <label htmlFor="IMP" title="Show Improvement" className="ml-2">Improvement</label>

                        </div>
                    </div>

                </div>
            }
            body={
                <div className="overflow-auto p-2">
                    <table ref={elementRef} className="w-full border-collapse rounded-lg border">
                        <thead className="bg-gray-800 text-white">
                            <tr>
                                {/* URL Header - Highest z-index and solid bg */}
                                <th className="px-4 py-3 text-left border-r border-gray-700 sticky left-0 bg-gray-800 z-30 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]">
                                    URL
                                </th>
                                {showSI && (
                                    <th colSpan={thSpan} className="px-4 py-3 text-center border-r border-gray-700">Speed Index</th>
                                )}
                                {showLCP && (
                                    <th colSpan={thSpan} className="px-4 py-3 text-center border-r border-gray-700">LCP</th>
                                )}
                                {showCLS && (
                                    <th colSpan={thSpan} className="px-4 py-3 text-center border-r border-gray-700">CLS</th>
                                )}
                                {showTBT && (
                                    <th colSpan={thSpan} className="px-4 py-3 text-center border-r border-gray-700">TBT</th>
                                )}
                                {showFCP && (
                                    <th colSpan={thSpan} className="px-4 py-3 text-center border-r border-gray-700">FCP</th>
                                )}
                            </tr>
                            <tr className="bg-gray-700">
                                {/* Sticky Spacer Cell */}
                                <th className="px-4 py-2 border-r border-gray-600 sticky left-0 bg-gray-700 z-30 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.3)]"></th>
                                {[...Array(selected.length)].map((_, i) => (
                                    <React.Fragment key={i}>
                                        <th className="px-4 py-2 text-center text-sm border-r border-gray-600">{beforeLabel || 'Before'}</th>
                                        <th className="px-4 py-2 text-center text-sm border-r border-gray-600">{afterLabel || 'After'}</th>
                                        {showIMP && (
                                            <th className="px-4 py-2 text-center text-sm border-r border-gray-600">Improvement</th>
                                        )}
                                    </React.Fragment>
                                ))}
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {urls.map((url, index) => {
                                const urlResult = getResultForUrl(url);
                                return (
                                    <tr key={index} className="hover:bg-gray-50">
                                        {/* URL Body Cell - Sticky with solid white bg */}
                                        <td className="px-4 py-3 border-r border-gray-200 sticky left-0 bg-white z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.1)]">
                                            <div className="flex items-center gap-2">
                                                {copying && (
                                                    <p className="text-sm text-gray-700">{url}</p>
                                                )}

                                                {!copying && (
                                                    <>
                                                        <input
                                                            type="url"
                                                            value={url}
                                                            onChange={(e) => updateUrl(index, e.target.value)}
                                                            placeholder="https://example.com"
                                                            className="w-full min-w-[250px] px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm bg-white"
                                                        />
                                                        <button
                                                            onClick={() => removeUrlField(index)}
                                                            className="p-2 hover:bg-red-50 rounded-lg transition-colors group"
                                                            title="Remove URL"
                                                        >
                                                            <X size={18} className="text-red-500 group-hover:scale-110 transition-transform" />
                                                        </button>
                                                    </>
                                                )}

                                            </div>
                                            {(urlResult?.before?.errorResponse || urlResult?.before?.runWarnings) && (
                                                <p className="text-xs text-red-500 mt-1">
                                                    * {urlResult?.before?.errorResponse?.message || urlResult?.before?.runWarnings}
                                                </p>
                                            )}
                                        </td>

                                        {/* Speed Index */}
                                        {showSI && (
                                            <>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingBefore ? <Loader2 className="animate-spin mx-auto text-blue-500" size={20} /> : formatMetricValue(urlResult?.before?.speedIndex)}
                                                </td>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingAfter ? <Loader2 className="animate-spin mx-auto text-purple-500" size={20} /> : formatMetricValue(urlResult?.after?.speedIndex)}
                                                </td>
                                                {showIMP && (
                                                    <td className="px-4 py-3 text-center border-r border-gray-200 font-medium">
                                                        {urlResult?.before?.speedIndex && urlResult?.after?.speedIndex ? calculateImprovement(urlResult.before.speedIndex, urlResult.after.speedIndex) : '-'}
                                                    </td>
                                                )}
                                            </>
                                        )}

                                        {/* LCP */}
                                        {showLCP && (
                                            <>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingBefore ? <Loader2 className="animate-spin mx-auto text-blue-500" size={20} /> : formatMetricValue(urlResult?.before?.largestContentfulPaint)}
                                                </td>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingAfter ? <Loader2 className="animate-spin mx-auto text-purple-500" size={20} /> : formatMetricValue(urlResult?.after?.largestContentfulPaint)}
                                                </td>
                                                {showIMP && (
                                                    <td className="px-4 py-3 text-center border-r border-gray-200 font-medium">
                                                        {urlResult?.before?.largestContentfulPaint && urlResult?.after?.largestContentfulPaint ? calculateImprovement(urlResult.before.largestContentfulPaint, urlResult.after.largestContentfulPaint) : '-'}
                                                    </td>
                                                )}
                                            </>
                                        )}

                                        {/* CLS */}
                                        {showCLS && (
                                            <>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingBefore ? <Loader2 className="animate-spin mx-auto text-blue-500" size={20} /> : formatMetricValue(urlResult?.before?.cumulativeLayoutShift)}
                                                </td>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingAfter ? <Loader2 className="animate-spin mx-auto text-purple-500" size={20} /> : formatMetricValue(urlResult?.after?.cumulativeLayoutShift)}
                                                </td>
                                                {showIMP && (
                                                    <td className="px-4 py-3 text-center border-r border-gray-200 font-medium">
                                                        {urlResult?.before?.cumulativeLayoutShift && urlResult?.after?.cumulativeLayoutShift ? calculateImprovement(urlResult.before.cumulativeLayoutShift, urlResult.after.cumulativeLayoutShift) : '-'}
                                                    </td>
                                                )}
                                            </>
                                        )}

                                        {/* TBT */}
                                        {showTBT && (
                                            <>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingBefore ? <Loader2 className="animate-spin mx-auto text-blue-500" size={20} /> : formatMetricValue(urlResult?.before?.totalBlockingTime)}
                                                </td>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingAfter ? <Loader2 className="animate-spin mx-auto text-purple-500" size={20} /> : formatMetricValue(urlResult?.after?.totalBlockingTime)}
                                                </td>
                                                {showIMP && (
                                                    <td className="px-4 py-3 text-center border-r border-gray-200 font-medium">
                                                        {urlResult?.before?.totalBlockingTime && urlResult?.after?.totalBlockingTime ? calculateImprovement(urlResult.before.totalBlockingTime, urlResult.after.totalBlockingTime) : '-'}
                                                    </td>
                                                )}
                                            </>
                                        )}

                                        {/* FCP */}
                                        {showFCP && (
                                            <>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingBefore ? <Loader2 className="animate-spin mx-auto text-blue-500" size={20} /> : formatMetricValue(urlResult?.before?.firstContentfulPaint)}
                                                </td>
                                                <td className="px-4 py-3 text-center border-r border-gray-200">
                                                    {urlResult?.generatingAfter ? <Loader2 className="animate-spin mx-auto text-purple-500" size={20} /> : formatMetricValue(urlResult?.after?.firstContentfulPaint)}
                                                </td>
                                                {showIMP && (
                                                    <td className="px-4 py-3 text-center border-r border-gray-200 font-medium">
                                                        {urlResult?.before?.firstContentfulPaint && urlResult?.after?.firstContentfulPaint ? calculateImprovement(urlResult.before.firstContentfulPaint, urlResult.after.firstContentfulPaint) : '-'}
                                                    </td>
                                                )}
                                            </>
                                        )}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            }>
        </CardModule>
    );
};

export default PageSpeedResults;