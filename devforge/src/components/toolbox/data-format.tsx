import { useRef, useState, useMemo, type DragEvent } from "react";
import { ArrowRight, FolderOpen, Globe, Loader2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { convertData, detectFormat, formatFromSource, parseData, DATA_FORMATS, type DataFormat } from "@/lib/toolbox/dataFormat";
import { CopyButton, ErrorNote, OutputBox, ToolPanel, WarningNote } from "./toolbox-shared";
import { DataTree } from "./data-tree";
import { SGT_ZONE, shiftTimestamps } from "@/lib/toolbox/timestamps";

const LABELS: Record<DataFormat, string> = { json: "JSON", yaml: "YAML", xml: "XML" };

/** Same cap as the main-process URL fetch: bigger files make the editor crawl. */
const MAX_BYTES = 5 * 1024 * 1024;

const sizeLabel = (bytes: number) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`);

/** Desktop: through the main process (no CORS). Browser build: a plain fetch, which only works when the site allows CORS. */
async function loadUrl(url: string): Promise<{ text: string; contentType: string; source: string }> {
    const api = window.electronAPI?.toolbox;
    if (api) {
        const res = await api.fetchText({ url });
        if (!res.ok) throw new Error(res.error);
        return { text: res.text, contentType: res.contentType, source: res.finalUrl };
    }
    let res: Response;
    try {
        res = await fetch(url, { credentials: "omit" });
    } catch {
        throw new Error("The browser blocked it (the site doesn't allow cross-origin reads). The desktop app can load it.");
    }
    if (!res.ok) throw new Error(`The server responded ${res.status}.`);
    return { text: await res.text(), contentType: res.headers.get("content-type") ?? "", source: url };
}

export default function DataFormatTool() {
    const [input, setInput] = useState("");
    const [from, setFrom] = useState<DataFormat>("json");
    const [to, setTo] = useState<DataFormat>("yaml");
    const [minify, setMinify] = useState(false);
    const [view, setView] = useState<"converted" | "tree">("converted");
    const [datesToSgt, setDatesToSgt] = useState(false);
    const [naiveAsUtc, setNaiveAsUtc] = useState(false);
    const [url, setUrl] = useState("");
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [loaded, setLoaded] = useState<string | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    /** Puts loaded text in the input and picks its format; the output side moves off it so something converts. */
    const accept = (text: string, source: string, contentType = "") => {
        const format = formatFromSource(source, contentType, text);
        setInput(text);
        if (format) {
            setFrom(format);
            if (format === to) setTo(format === "json" ? "yaml" : "json");
        }
        setLoaded(`Loaded ${source} (${sizeLabel(new Blob([text]).size)})`);
        setLoadError(null);
    };

    const openFile = async (file: File | undefined) => {
        if (!file) return;
        if (file.size > MAX_BYTES) { setLoadError(`${file.name} is larger than 5 MB.`); return; }
        try {
            accept(await file.text(), file.name);
        } catch (e) {
            setLoadError(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const fetchUrl = async () => {
        if (!url.trim() || loading) return;
        setLoading(true);
        setLoadError(null);
        try {
            const res = await loadUrl(url.trim());
            accept(res.text, res.source, res.contentType);
        } catch (e) {
            setLoadError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    };

    const onDrop = (event: DragEvent<HTMLTextAreaElement>) => {
        const file = event.dataTransfer.files[0];
        if (!file) return; // dropped text: let the textarea take it
        event.preventDefault();
        void openFile(file);
    };

    const result = useMemo(
        () => (input.trim() && view === "converted" ? convertData(input, from, to, { minify }) : { output: "", error: null, warnings: [] }),
        [input, from, to, minify, view],
    );
    // The tree reads the input as it is; converting isn't involved, so only parse errors count.
    const parsed = useMemo(
        () => (input.trim() && view === "tree" ? parseData(input, from) : null),
        [input, from, view],
    );
    // Dates → SGT rewrites the converted text after conversion, so it works the same for all three formats.
    const shifted = useMemo(
        () => (datesToSgt && result.output ? shiftTimestamps(result.output, { zone: SGT_ZONE, naiveAsUtc }) : null),
        [datesToSgt, naiveAsUtc, result.output],
    );
    const output = shifted?.text ?? result.output;
    const issue = view === "tree" ? parsed?.error ?? null : result.error;
    const warnings = view === "tree" ? parsed?.warnings ?? [] : result.warnings;

    // Picking the format by hand is the common case; this just saves the step
    // when the input obviously announces itself.
    const detected = detectFormat(input);
    const detectionMismatch = detected !== null && detected !== from;

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="flex flex-wrap items-center gap-2">
                <Select value={from} onValueChange={(value) => setFrom(value as DataFormat)}>
                    <SelectTrigger className="h-8 w-28 text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {DATA_FORMATS.map((format) => (
                            <SelectItem key={format} value={format}>{LABELS[format]}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <ArrowRight className="h-4 w-4 text-muted-foreground" />

                <Select value={to} onValueChange={(value) => setTo(value as DataFormat)}>
                    <SelectTrigger className="h-8 w-28 text-xs">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {DATA_FORMATS.map((format) => (
                            <SelectItem key={format} value={format}>{LABELS[format]}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                {to !== "xml" && (
                    <Button
                        variant={minify ? "default" : "outline"}
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setMinify((value) => !value)}
                    >
                        Minify
                    </Button>
                )}

                <Button
                    variant={datesToSgt ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    aria-pressed={datesToSgt}
                    title="Restate every timestamp that carries a zone (Z, +00:00, UTC, GMT…) in Singapore time: rewritten in the converted output, shown beside the value in the tree"
                    onClick={() => setDatesToSgt((value) => !value)}
                >
                    Dates → SGT
                </Button>
                {datesToSgt && (
                    <Button
                        variant={naiveAsUtc ? "secondary" : "ghost"}
                        size="sm"
                        className="h-8 text-xs"
                        aria-pressed={naiveAsUtc}
                        title="Also treat date-times with no zone (2026-11-09 02:23:00) as UTC, as App Insights and SQL exports often are"
                        onClick={() => setNaiveAsUtc((value) => !value)}
                    >
                        No zone = UTC
                    </Button>
                )}
                {shifted && view === "converted" && (
                    <span className="text-[11px] text-muted-foreground">{shifted.count} date{shifted.count === 1 ? "" : "s"} → SGT</span>
                )}

                {detectionMismatch && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs text-muted-foreground"
                        onClick={() => setFrom(detected)}
                    >
                        Looks like {LABELS[detected]} — switch?
                    </Button>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <input
                    ref={fileRef}
                    type="file"
                    accept=".json,.yaml,.yml,.xml,.config,.csproj,.props,.targets,.resx,.txt,application/json,application/xml,text/xml,text/yaml"
                    className="hidden"
                    onChange={(event) => { void openFile(event.target.files?.[0]); event.target.value = ""; }}
                />
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => fileRef.current?.click()}>
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    Open file…
                </Button>
                <form
                    className="flex flex-1 min-w-[16rem] items-center gap-2"
                    onSubmit={(event) => { event.preventDefault(); void fetchUrl(); }}
                >
                    <Input
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                        placeholder="https://… URL of a JSON, YAML or XML file"
                        aria-label="URL to load"
                        spellCheck={false}
                        className="h-8 text-xs font-mono"
                    />
                    <Button type="submit" variant="outline" size="sm" className="h-8 text-xs" disabled={!url.trim() || loading}>
                        {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Globe className="mr-1.5 h-3.5 w-3.5" />}
                        Load URL
                    </Button>
                </form>
            </div>

            {loadError && <ErrorNote>{loadError}</ErrorNote>}
            {loaded && !loadError && <p className="text-[11px] text-muted-foreground truncate">{loaded}</p>}

            {issue && (
                <ErrorNote>
                    {issue.line !== undefined
                        ? `Line ${issue.line}, column ${issue.column}: ${issue.message}`
                        : issue.message}
                </ErrorNote>
            )}

            {warnings.map((warning) => (
                <WarningNote key={warning}>{warning}</WarningNote>
            ))}

            <div className="grid gap-3 md:grid-cols-2 flex-1 min-h-0">
                <ToolPanel title={`Input — ${LABELS[from]}`}>
                    <Textarea
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        onDrop={onDrop}
                        placeholder={`Paste ${LABELS[from]} here, or drop a file`}
                        spellCheck={false}
                        className="font-mono text-xs flex-1 min-h-0 resize-none"
                    />
                </ToolPanel>

                <ToolPanel
                    title={view === "tree" ? `Tree view — ${LABELS[from]}` : `Output — ${LABELS[to]}`}
                    actions={
                        <div className="flex items-center gap-1">
                            <div role="group" aria-label="Output view" className="flex rounded-md border p-0.5">
                                {(["converted", "tree"] as const).map((v) => (
                                    <Button
                                        key={v}
                                        variant={view === v ? "secondary" : "ghost"}
                                        size="sm"
                                        className="h-6 px-2 text-[11px]"
                                        aria-pressed={view === v}
                                        onClick={() => setView(v)}
                                    >
                                        {v === "converted" ? "Converted" : "Tree view"}
                                    </Button>
                                ))}
                            </div>
                            {view === "converted" && <CopyButton value={output} label="Copy output" />}
                        </div>
                    }
                >
                    {view === "tree"
                        ? (parsed && !parsed.error
                            ? <DataTree value={parsed.value} dates={datesToSgt ? { zone: SGT_ZONE, naiveAsUtc } : null} />
                            : <OutputBox value="" placeholder="Paste, open or load a file to browse it as a tree" />)
                        : <OutputBox value={output} placeholder="Converted output appears here" />}
                </ToolPanel>
            </div>
        </div>
    );
}
