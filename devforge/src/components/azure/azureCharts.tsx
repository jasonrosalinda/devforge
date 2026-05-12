// components/azure/AzureCharts.tsx
import { useState, useCallback } from "react";
import { useAzureGallery } from "@/hooks/useAzureCapture";
import ChartLightbox from "../azure/azureChartLightbox";
import type { AzureTileImage } from "@/hooks/useAzureCapture";
import { Toast } from "../ui";
import { useCopyElementAsImage } from '../../hooks/useCopyElementAsImage';
const DASHBOARDS = [] as const;
import { Search, RefreshCcw, Copy, SlidersHorizontal, BarChart2, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface AzureChartsProps {
    jumpTo?: string | null;
}

export default function AzureCharts({ jumpTo }: AzureChartsProps) {
    const { sessions, selected, images, stats, sessionUrl, loading, loadSession, clearSessions } = useAzureGallery(jumpTo);
    const [lightbox, setLightbox] = useState<AzureTileImage | null>(null);
    const [showStats, setShowStats] = useState(false);
    const [hiddenChartsMap, setHiddenChartsMap] = useState<Record<string, string[]>>(() => {
        try { return JSON.parse(localStorage.getItem('azure-hidden-charts') || '{}'); } catch { return {}; }
    });
    const [showFilter, setShowFilter] = useState(false);
    const [copying, setCopying] = useState(false);
    const toast = Toast();

    const hiddenSet = new Set(sessionUrl ? hiddenChartsMap[sessionUrl] || [] : []);
    const visibleImages = images.filter(img => !hiddenSet.has(img.title || img.name));

    const toggleChart = useCallback((id: string) => {
        if (!sessionUrl) return;
        setHiddenChartsMap(prev => {
            const list = prev[sessionUrl] || [];
            const nextList = list.includes(id) ? list.filter(v => v !== id) : [...list, id];
            const nextMap = { ...prev, [sessionUrl]: nextList };
            localStorage.setItem('azure-hidden-charts', JSON.stringify(nextMap));
            return nextMap;
        });
    }, [sessionUrl]);

    const { elementRef, copyAsImage } = useCopyElementAsImage({
        fileNamePrefix: `azure-dashboard-charts-${Date.now()}`,
    });

    const onCopy = async () => {
        setCopying(true);
        toast.promise(copyAsImage(), {
            loading: "Copying...",
            success: "Copied successfully",
            error: "Copy failed",
        });
        setCopying(false);
    };

    return (
        <>
            <div className="flex gap-4 min-h-0 h-full">

                {/* ── Session sidebar ───────────────────────────────────── */}
                <div className="w-44 shrink-0 flex flex-col">
                    <div className="flex items-center justify-between mb-3">
                        <span className="text-[10px] text-slate-500 tracking-widest uppercase">
                            Sessions
                        </span>
                        {sessions.length > 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                className="h-5 px-1 text-[9px] text-red-500 hover:text-red-400 hover:bg-red-500/10"
                                onClick={() => { if (confirm('Clear all sessions?')) clearSessions(); }}
                            >
                                <Trash2 className="w-3 h-3 mr-1" />
                                Clear
                            </Button>
                        )}
                    </div>

                    {sessions.length === 0 && (
                        <p className="text-xs text-slate-500 leading-relaxed">
                            No captures yet.<br />Run a capture first.
                        </p>
                    )}

                    <ScrollArea className="flex-1">
                        <div className="flex flex-col gap-0.5">
                            {sessions.map(s => (
                                <SessionItem
                                    key={s.id}
                                    session={s.id}
                                    label={DASHBOARDS.find(d => d.url === s.url)?.label || s.url}
                                    active={selected === s.id}
                                    onClick={() => loadSession(s.id)}
                                />
                            ))}
                        </div>
                    </ScrollArea>
                </div>

                <Separator orientation="vertical" className="bg-slate-800" />

                {/* ── Tile grid ─────────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto min-w-0">
                    {!selected && <EmptyState />}

                    {selected && (
                        <>
                            {/* Header */}
                            <div className="flex items-center justify-between mb-4">
                                <div>
                                    {sessionUrl && (
                                        <div className="text-[15px] font-bold text-slate-200">
                                            {DASHBOARDS.find(d => d.url === sessionUrl)?.label || sessionUrl}
                                        </div>
                                    )}
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-[11px] text-slate-500">{selected}</span>
                                        {images.length > 0 && (
                                            <Badge variant="outline" className="text-[10px] text-cyan-400 border-cyan-400/30 bg-cyan-400/5 px-1.5 py-0">
                                                {images.length} tiles
                                            </Badge>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    {stats && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={() => setShowStats(p => !p)}
                                            className={cn(
                                                "h-7 px-3 text-[11px] border-slate-700 bg-transparent",
                                                showStats
                                                    ? "border-blue-500 text-blue-400 bg-blue-500/10"
                                                    : "text-slate-400 hover:text-slate-200 hover:border-slate-600"
                                            )}
                                        >
                                            <BarChart2 className="w-3 h-3 mr-1.5" />
                                            {showStats ? 'Hide Stats' : 'Stats'}
                                        </Button>
                                    )}

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setShowFilter(p => !p)}
                                        className={cn(
                                            "h-7 px-3 text-[11px] border-slate-700 bg-transparent",
                                            showFilter
                                                ? "border-blue-500 text-blue-400 bg-blue-500/10"
                                                : "text-slate-400 hover:text-slate-200 hover:border-slate-600"
                                        )}
                                    >
                                        <SlidersHorizontal className="w-3 h-3 mr-1.5" />
                                        Filter
                                        {hiddenSet.size > 0 && (
                                            <Badge className="ml-1.5 text-[9px] px-1 py-0 h-4 bg-blue-500/20 text-blue-400 border-0">
                                                {hiddenSet.size}
                                            </Badge>
                                        )}
                                    </Button>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => loadSession(selected)}
                                        className="h-7 px-3 text-[11px] border-slate-700 bg-transparent text-slate-400 hover:text-slate-200 hover:border-slate-600"
                                    >
                                        <RefreshCcw className="w-3 h-3 mr-1.5" />
                                        Reload
                                    </Button>

                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={onCopy}
                                        disabled={copying}
                                        className={cn(
                                            "h-7 px-3 text-[11px] border-slate-700 bg-transparent",
                                            copying
                                                ? "border-blue-500 text-blue-400 bg-blue-500/10"
                                                : "text-slate-400 hover:text-slate-200 hover:border-slate-600"
                                        )}
                                    >
                                        <Copy className="w-3 h-3 mr-1.5" />
                                        {copying ? 'Copying...' : 'Copy'}
                                    </Button>
                                </div>
                            </div>

                            {/* Stats panel */}
                            {showStats && stats && (
                                <div className="bg-slate-900/80 border border-slate-800 rounded-lg p-4 mb-4">
                                    <div className="text-[10px] text-blue-400 tracking-widest uppercase mb-2">
                                        STATISTIC.TXT
                                    </div>
                                    <pre className="text-[11.5px] text-cyan-400 leading-relaxed whitespace-pre-wrap m-0">
                                        {stats}
                                    </pre>
                                </div>
                            )}

                            {/* Filter panel */}
                            {showFilter && images.length > 0 && (
                                <ChartFilterPanel
                                    images={images}
                                    hiddenCharts={hiddenSet}
                                    onToggle={toggleChart}
                                />
                            )}

                            {/* Loading */}
                            {loading && (
                                <p className="text-slate-500 text-sm">⏳ Loading tiles...</p>
                            )}

                            {/* Empty */}
                            {!loading && images.length === 0 && (
                                <p className="text-slate-500 text-sm">No PNG files found in this session.</p>
                            )}

                            {/* Chart list */}
                            {!loading && visibleImages.length > 0 && (
                                <div ref={elementRef} className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                                    {visibleImages.map((img) => (
                                        <ChartListItem
                                            key={img.name}
                                            image={img}
                                            onZoom={setLightbox}
                                        />
                                    ))}
                                </div>
                            )}

                            {/* All filtered out */}
                            {!loading && images.length > 0 && visibleImages.length === 0 && (
                                <p className="text-slate-500 text-sm">
                                    All charts are hidden. Adjust the filter to show charts.
                                </p>
                            )}
                        </>
                    )}
                </div>
            </div>

            {lightbox && (
                <ChartLightbox image={lightbox} onClose={() => setLightbox(null)} />
            )}
        </>
    );
}

// ── Internal components ───────────────────────────────────────────────────────
function ChartFilterPanel({ images, hiddenCharts, onToggle }: {
    images: AzureTileImage[];
    hiddenCharts: Set<string>;
    onToggle: (name: string) => void;
}) {
    return (
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-4 mb-4">
            <p className="text-[10px] text-blue-400 tracking-widest uppercase mb-3">
                Show / Hide Charts
            </p>
            <div className="flex flex-wrap gap-2">
                {images.map(img => {
                    const id = img.title || img.name;
                    const visible = !hiddenCharts.has(id);
                    return (
                        <label
                            key={id}
                            className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded-md border cursor-pointer select-none",
                                "text-[11px] transition-all duration-100",
                                visible
                                    ? "border-slate-700 bg-blue-500/10 text-slate-200"
                                    : "border-slate-800 bg-transparent text-slate-500"
                            )}
                        >
                            <Checkbox
                                checked={visible}
                                onCheckedChange={() => onToggle(id)}
                                className="w-3.5 h-3.5 border-slate-600 data-[state=checked]:bg-blue-500 data-[state=checked]:border-blue-500"
                            />
                            {img.title || img.name
                                .replace(/\.png$/i, '')
                                .replace(/_/g, ' ')
                                .replace(/\b\w/g, c => c.toUpperCase())}
                        </label>
                    );
                })}
            </div>
        </div>
    );
}

function ChartListItem({ image, onZoom }: {
    image: AzureTileImage;
    onZoom: (image: AzureTileImage) => void;
}) {
    const [hovered, setHovered] = useState(false);

    const displayTitle = image.title
        || image.name.replace(/\.png$/i, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    return (
        <div className="flex flex-col gap-1">
            <div
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onClick={() => onZoom(image)}
                className={cn(
                    "relative rounded-lg overflow-hidden cursor-zoom-in border transition-colors duration-150",
                    hovered ? "border-blue-500" : "border-slate-800"
                )}
            >
                <img src={image.src} alt={displayTitle} className="w-full block" />
                {hovered && (
                    <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                        <Search className="w-6 h-6 text-white drop-shadow" />
                    </div>
                )}
            </div>

            {image.legends && image.legends.length > 0 && (
                <div className="flex flex-wrap gap-2 px-1 py-1">
                    {image.legends.map((legend, idx) => (
                        <div
                            key={idx}
                            className="flex items-center gap-1.5 text-[11px] bg-blue-500/5 border border-slate-800 px-2 py-1 rounded-md"
                        >
                            <span className="text-slate-600">●</span>
                            <span className="font-medium text-slate-200">{legend.metric}</span>
                            <span className="text-blue-400 font-semibold">{legend.value}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function SessionItem({ session, label, active, onClick }: {
    session: string;
    label?: string | null;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <div
            onClick={onClick}
            className={cn(
                "px-2.5 py-2 rounded-md cursor-pointer text-[11px] leading-relaxed",
                "border-l-2 transition-all duration-100",
                active
                    ? "bg-slate-900 border border-slate-700 border-l-blue-500 text-slate-200"
                    : "border-transparent text-slate-500 hover:text-slate-400 hover:bg-slate-900/40"
            )}
        >
            <div className="flex justify-between items-center gap-1">
                <span>{session.slice(0, 10)}</span>
                {label && (
                    <span className={cn(
                        "text-[9px] px-1 rounded max-w-[70px] truncate",
                        active ? "text-blue-400 bg-blue-500/10" : "text-slate-600"
                    )}>
                        {label}
                    </span>
                )}
            </div>
            <div className="text-slate-700 text-[10px]">
                {session.slice(11, 19).replace(/-/g, ':')}
            </div>
        </div>
    );
}

function EmptyState() {
    return (
        <div className="flex flex-col items-center justify-center h-60 text-center">
            <p className="text-sm text-slate-500 leading-relaxed">
                Run a capture first,<br />then select a session to view tiles.
            </p>
        </div>
    );
}