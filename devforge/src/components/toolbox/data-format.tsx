import { useMemo, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { convertData, detectFormat, DATA_FORMATS, type DataFormat } from "@/lib/toolbox/dataFormat";
import { CopyButton, ErrorNote, OutputBox, ToolPanel, WarningNote } from "./toolbox-shared";

const LABELS: Record<DataFormat, string> = { json: "JSON", yaml: "YAML", xml: "XML" };

export default function DataFormatTool() {
    const [input, setInput] = useState("");
    const [from, setFrom] = useState<DataFormat>("json");
    const [to, setTo] = useState<DataFormat>("yaml");
    const [minify, setMinify] = useState(false);

    const result = useMemo(
        () => (input.trim() ? convertData(input, from, to, { minify }) : { output: "", error: null, warnings: [] }),
        [input, from, to, minify],
    );

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

            {result.error && (
                <ErrorNote>
                    {result.error.line !== undefined
                        ? `Line ${result.error.line}, column ${result.error.column}: ${result.error.message}`
                        : result.error.message}
                </ErrorNote>
            )}

            {result.warnings.map((warning) => (
                <WarningNote key={warning}>{warning}</WarningNote>
            ))}

            <div className="grid gap-3 md:grid-cols-2 flex-1 min-h-0">
                <ToolPanel title={`Input — ${LABELS[from]}`}>
                    <Textarea
                        value={input}
                        onChange={(event) => setInput(event.target.value)}
                        placeholder={`Paste ${LABELS[from]} here`}
                        spellCheck={false}
                        className="font-mono text-xs flex-1 min-h-0 resize-none"
                    />
                </ToolPanel>

                <ToolPanel
                    title={`Output — ${LABELS[to]}`}
                    actions={<CopyButton value={result.output} label="Copy output" />}
                >
                    <OutputBox value={result.output} placeholder="Converted output appears here" />
                </ToolPanel>
            </div>
        </div>
    );
}
