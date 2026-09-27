import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Check, Copy, Download, ImageUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
    ICO_SIZES,
    OUTPUT_FORMATS,
    buildEmbedSvg,
    encodeIco,
    fitSize,
    formatBytes,
    outputFileName,
    sizeChange,
    traceSize,
    traceToSvg,
    type OutputFormat,
    type Size,
    type TraceDetail,
} from "@/lib/toolbox/imageConvert";
import { ErrorNote, ToolPanel } from "./toolbox-shared";

type Source = { image: HTMLImageElement; url: string; name: string; bytes: number; type: string } & Size;

type Result = { blob: Blob; url: string; svgText?: string } & Size;

type Settings = {
    format: OutputFormat;
    /** 0.1–1, JPEG/WebP only. */
    quality: number;
    /** JPEG has no alpha; transparent pixels are painted this colour. */
    background: string;
    width?: number | undefined;
    height?: number | undefined;
    lockAspect: boolean;
    icoSizes: number[];
    svgMode: "trace" | "embed";
    colors: number;
    detail: TraceDetail;
};

const DEFAULT_SETTINGS: Settings = {
    format: "png",
    quality: 0.9,
    background: "#ffffff",
    lockAspect: true,
    icoSizes: [16, 32, 48],
    svgMode: "trace",
    colors: 16,
    detail: "medium",
};

const COLOR_COUNTS = [2, 4, 8, 16, 32, 64];

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/bmp,image/x-icon,image/vnd.microsoft.icon,image/avif,image/svg+xml";

/** Transparent areas read as transparent, not as the page background. */
const CHECKERBOARD: CSSProperties = {
    backgroundImage: "conic-gradient(hsl(var(--muted)) 25%, transparent 0 50%, hsl(var(--muted)) 0 75%, transparent 0)",
    backgroundSize: "16px 16px",
};

async function loadSource(file: File): Promise<Source> {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    try {
        await image.decode();
    } catch {
        URL.revokeObjectURL(url);
        throw new Error(`Could not read "${file.name || "the pasted file"}" as an image.`);
    }
    // An SVG with only a viewBox has no intrinsic size; give it one to rasterise at.
    return {
        image,
        url,
        name: file.name,
        bytes: file.size,
        type: file.type,
        width: image.naturalWidth || 512,
        height: image.naturalHeight || 512,
    };
}

function drawCanvas(image: HTMLImageElement, size: Size, background?: string): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, size.width, size.height);
    }
    ctx.drawImage(image, 0, 0, size.width, size.height);
    return canvas;
}

/** Icons are square: fit the image inside and leave the rest transparent. */
function drawSquare(image: HTMLImageElement, source: Size, side: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    const scale = side / Math.max(source.width, source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    ctx.drawImage(image, (side - w) / 2, (side - h) / 2, w, h);
    return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("The browser could not encode this image - try a smaller size."))),
            mime,
            quality,
        );
    });
}

async function convert(source: Source, settings: Settings): Promise<Omit<Result, "url">> {
    const format = OUTPUT_FORMATS.find((f) => f.value === settings.format)!;
    const size = fitSize(source, settings);

    if (settings.format === "ico") {
        const sizes = [...settings.icoSizes].sort((a, b) => a - b);
        const pngs = await Promise.all(sizes.map(async (side) => ({
            size: side,
            png: new Uint8Array(await (await canvasToBlob(drawSquare(source.image, source, side), "image/png")).arrayBuffer()),
        })));
        const largest = sizes[sizes.length - 1]!;
        return { blob: new Blob([encodeIco(pngs)], { type: format.mime }), width: largest, height: largest };
    }

    if (settings.format === "svg") {
        let svgText: string;
        if (settings.svgMode === "embed") {
            // Keep a JPEG source as JPEG inside the SVG; re-encoding a photo as PNG balloons it.
            const mime = source.type === "image/jpeg" ? "image/jpeg" : "image/png";
            svgText = buildEmbedSvg(drawCanvas(source.image, size).toDataURL(mime, 0.92), size.width, size.height);
        } else {
            const traced = traceSize(size);
            const ctx = drawCanvas(source.image, traced).getContext("2d")!;
            svgText = traceToSvg(ctx.getImageData(0, 0, traced.width, traced.height), { colors: settings.colors, detail: settings.detail }, size);
        }
        return { blob: new Blob([svgText], { type: format.mime }), svgText, ...size };
    }

    const canvas = drawCanvas(source.image, size, settings.format === "jpeg" ? settings.background : undefined);
    const blob = await canvasToBlob(canvas, format.mime, format.lossy ? settings.quality : undefined);
    return { blob, ...size };
}

function OptionalNumberInput({ value, onChange, placeholder }: {
    value: number | undefined;
    onChange: (value: number | undefined) => void;
    placeholder: string;
}) {
    return (
        <Input
            type="number"
            min={1}
            value={value ?? ""}
            placeholder={placeholder}
            onChange={(event) => onChange(event.target.value === "" ? undefined : Number(event.target.value))}
            className="h-8 w-24 text-xs tabular-nums"
        />
    );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
            {children}
        </div>
    );
}

function Toggle<T extends string | number>({ options, value, onChange }: {
    options: { value: T; label: string }[];
    value: T;
    onChange: (value: T) => void;
}) {
    return (
        <div className="flex flex-wrap gap-1">
            {options.map((option) => (
                <Button
                    key={option.value}
                    variant={option.value === value ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    aria-pressed={option.value === value}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </Button>
            ))}
        </div>
    );
}

function Preview({ title, url, meta, actions }: { title: string; url?: string | undefined; meta?: string | undefined; actions?: ReactNode }) {
    return (
        <ToolPanel title={meta ? `${title} · ${meta}` : title} actions={actions} className="min-h-64">
            <div className="flex flex-1 min-h-48 items-center justify-center overflow-auto rounded-md border p-2" style={CHECKERBOARD}>
                {url
                    ? <img src={url} alt={title} className="max-h-[50vh] max-w-full object-contain" />
                    : <span className="text-xs text-muted-foreground">—</span>}
            </div>
        </ToolPanel>
    );
}

export default function ImageConverter() {
    const rootRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [source, setSource] = useState<Source | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
    const [converting, setConverting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const [copied, setCopied] = useState(false);

    const set = (patch: Partial<Settings>) => setSettings((current) => ({ ...current, ...patch }));

    const openFile = useCallback(async (file: File | undefined) => {
        if (!file) return;
        try {
            const next = await loadSource(file);
            setSource((previous) => {
                if (previous) URL.revokeObjectURL(previous.url);
                return next;
            });
            setSettings((current) => ({ ...current, width: undefined, height: undefined }));
            setError(null);
        } catch (err) {
            setError((err as Error).message);
        }
    }, []);

    // Paste an image from anywhere on the page - but only while this tab is the one showing,
    // and not when the paste is text going into a field.
    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            if (rootRef.current?.closest("[hidden]")) return;
            const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
            if (!file) return;
            event.preventDefault();
            void openFile(file);
        };
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
    }, [openFile]);

    // Re-convert shortly after the last change; a stale run's output is thrown away.
    useEffect(() => {
        if (!source) return;
        if (settings.format === "ico" && settings.icoSizes.length === 0) {
            setResult((previous) => {
                if (previous) URL.revokeObjectURL(previous.url);
                return null;
            });
            return;
        }
        let cancelled = false;
        const timer = setTimeout(async () => {
            setConverting(true);
            // Let the spinner paint before a long trace blocks the thread.
            await new Promise((resolve) => setTimeout(resolve, 16));
            try {
                const output = await convert(source, settings);
                if (cancelled) return;
                const url = URL.createObjectURL(output.blob);
                setResult((previous) => {
                    if (previous) URL.revokeObjectURL(previous.url);
                    return { ...output, url };
                });
                setError(null);
            } catch (err) {
                if (!cancelled) setError((err as Error).message);
            } finally {
                if (!cancelled) setConverting(false);
            }
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [source, settings]);

    // Release the last object URLs when the tab closes.
    const urlsRef = useRef<string[]>([]);
    urlsRef.current = [source?.url, result?.url].filter((u): u is string => !!u);
    useEffect(() => () => urlsRef.current.forEach((url) => URL.revokeObjectURL(url)), []);

    const onDrop = (event: DragEvent) => {
        event.preventDefault();
        setDragging(false);
        void openFile(event.dataTransfer.files[0]);
    };

    const download = () => {
        if (!result || !source) return;
        const a = document.createElement("a");
        a.href = result.url;
        a.download = outputFileName(source.name, settings.format);
        a.click();
    };

    const copy = async () => {
        if (!result) return;
        try {
            if (result.svgText) await navigator.clipboard.writeText(result.svgText);
            else await navigator.clipboard.write([new ClipboardItem({ "image/png": result.blob })]);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
            Toast().success(result.svgText ? "SVG markup copied" : "Image copied");
        } catch {
            Toast().error("Could not access the clipboard");
        }
    };

    const format = OUTPUT_FORMATS.find((f) => f.value === settings.format)!;
    const canCopy = settings.format === "svg" || settings.format === "png";
    const target = source ? fitSize(source, settings) : null;

    return (
        <div ref={rootRef} className="flex flex-col gap-3 h-full min-h-0">
            <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(event) => {
                    void openFile(event.target.files?.[0]);
                    event.target.value = "";
                }}
            />

            <div
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && fileInputRef.current?.click()}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-md border border-dashed px-4 text-left transition-colors hover:bg-muted/40",
                    source ? "py-2" : "py-8 justify-center",
                    dragging && "border-primary bg-primary/5",
                )}
            >
                <ImageUp className="h-5 w-5 shrink-0 text-muted-foreground" />
                {source ? (
                    <span className="min-w-0 text-xs">
                        <span className="font-medium">{source.name || "Pasted image"}</span>
                        <span className="text-muted-foreground"> · {source.width}×{source.height} · {formatBytes(source.bytes)} · click, drop or paste to replace</span>
                    </span>
                ) : (
                    <span className="text-sm">
                        Drop an image, click to choose one, or paste with Ctrl+V
                        <span className="block text-[11px] text-muted-foreground">PNG, JPEG, WebP, GIF, BMP, ICO, AVIF or SVG — converted on this machine, nothing is uploaded.</span>
                    </span>
                )}
            </div>

            {error && <ErrorNote>{error}</ErrorNote>}

            <div className="flex flex-col gap-2 rounded-md border p-3">
                <Row label="Convert to">
                    <Toggle options={OUTPUT_FORMATS} value={settings.format} onChange={(value) => set({ format: value })} />
                </Row>

                {format.lossy && (
                    <Row label="Quality">
                        <Slider
                            value={[Math.round(settings.quality * 100)]}
                            min={10}
                            max={100}
                            step={1}
                            onValueChange={([value]) => set({ quality: value! / 100 })}
                            className="w-48"
                        />
                        <span className="w-10 text-xs tabular-nums">{Math.round(settings.quality * 100)}%</span>
                    </Row>
                )}

                {settings.format === "jpeg" && (
                    <Row label="Background">
                        <input
                            type="color"
                            value={settings.background}
                            onChange={(event) => set({ background: event.target.value })}
                            className="h-8 w-10 cursor-pointer rounded border bg-transparent"
                            aria-label="Background colour"
                        />
                        <span className="text-[11px] text-muted-foreground">JPEG has no transparency; see-through pixels get this colour.</span>
                    </Row>
                )}

                {settings.format === "ico" ? (
                    <Row label="Sizes">
                        {ICO_SIZES.map((side) => (
                            <div key={side} className="flex items-center gap-1.5">
                                <Checkbox
                                    id={`ico-${side}`}
                                    checked={settings.icoSizes.includes(side)}
                                    onCheckedChange={(checked) => set({
                                        icoSizes: checked === true
                                            ? [...settings.icoSizes, side]
                                            : settings.icoSizes.filter((s) => s !== side),
                                    })}
                                />
                                <Label htmlFor={`ico-${side}`} className="text-xs font-normal">{side}px</Label>
                            </div>
                        ))}
                        {settings.icoSizes.length === 0 && (
                            <span className="text-[11px] text-muted-foreground">Pick at least one size.</span>
                        )}
                    </Row>
                ) : (
                    <Row label="Resize">
                        <OptionalNumberInput value={settings.width} onChange={(width) => set({ width })} placeholder={source ? String(source.width) : "Width"} />
                        <span className="text-xs text-muted-foreground">×</span>
                        <OptionalNumberInput value={settings.height} onChange={(height) => set({ height })} placeholder={source ? String(source.height) : "Height"} />
                        <span className="text-xs text-muted-foreground">px</span>
                        <div className="ml-2 flex items-center gap-1.5">
                            <Checkbox id="image-lock-aspect" checked={settings.lockAspect} onCheckedChange={(checked) => set({ lockAspect: checked === true })} />
                            <Label htmlFor="image-lock-aspect" className="text-xs font-normal">Keep aspect ratio</Label>
                        </div>
                        {target && (settings.width !== undefined || settings.height !== undefined) && (
                            <span className="text-[11px] text-muted-foreground">→ {target.width}×{target.height}</span>
                        )}
                    </Row>
                )}

                {settings.format === "svg" && (
                    <>
                        <Row label="SVG mode">
                            <Toggle
                                options={[{ value: "trace", label: "Trace" }, { value: "embed", label: "Embed" }]}
                                value={settings.svgMode}
                                onChange={(svgMode) => set({ svgMode })}
                            />
                            <span className="text-[11px] text-muted-foreground">
                                {settings.svgMode === "trace"
                                    ? "Real vector paths — best for logos, icons and flat art. Photos come out posterised."
                                    : "Exact pixels wrapped in an SVG — lossless, but it won't scale or edit like a vector."}
                            </span>
                        </Row>
                        {settings.svgMode === "trace" && (
                            <Row label="Trace">
                                <Select value={String(settings.colors)} onValueChange={(value) => set({ colors: Number(value) })}>
                                    <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {COLOR_COUNTS.map((count) => (
                                            <SelectItem key={count} value={String(count)} className="text-xs">{count} colours</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                <Select value={settings.detail} onValueChange={(value) => set({ detail: value as TraceDetail })}>
                                    <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="low" className="text-xs">Low detail</SelectItem>
                                        <SelectItem value="medium" className="text-xs">Medium detail</SelectItem>
                                        <SelectItem value="high" className="text-xs">High detail</SelectItem>
                                    </SelectContent>
                                </Select>
                                {target && traceSize(target).width !== target.width && (
                                    <span className="text-[11px] text-muted-foreground">Traced at {traceSize(target).width}×{traceSize(target).height} to keep it quick.</span>
                                )}
                            </Row>
                        )}
                    </>
                )}
            </div>

            {source && (
                <div className="grid gap-3 md:grid-cols-2">
                    <Preview title="Original" url={source.url} meta={`${source.width}×${source.height} · ${formatBytes(source.bytes)}`} />
                    <Preview
                        title={`${format.label}`}
                        url={result?.url}
                        meta={result
                            ? `${result.width}×${result.height} · ${formatBytes(result.blob.size)} (${sizeChange(source.bytes, result.blob.size)})`
                            : undefined}
                        actions={
                            <div className="flex items-center gap-1">
                                {converting && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                                {canCopy && (
                                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={copy} disabled={!result || converting}>
                                        {copied ? <Check className="mr-1 h-3.5 w-3.5" /> : <Copy className="mr-1 h-3.5 w-3.5" />}
                                        {settings.format === "svg" ? "Copy SVG" : "Copy"}
                                    </Button>
                                )}
                                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={download} disabled={!result || converting}>
                                    <Download className="mr-1 h-3.5 w-3.5" />
                                    Download
                                </Button>
                            </div>
                        }
                    />
                </div>
            )}
        </div>
    );
}
