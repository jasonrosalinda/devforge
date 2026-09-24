import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    encodeBase64,
    decodeBase64,
    escapeHtml,
    unescapeHtml,
    hashText,
    uuidV4,
    uuidV7,
    HASH_ALGORITHMS,
    type HashAlgorithm,
} from "@/lib/toolbox/encoders";
import { CopyButton, ErrorNote, OutputBox, ToolPanel } from "./toolbox-shared";

type Mode = "base64" | "url" | "html";

const MODE_LABELS: Record<Mode, string> = { base64: "Base64", url: "URL", html: "HTML" };

function transform(mode: Mode, text: string, decode: boolean, urlSafe: boolean): { output: string; error: string | null } {
    try {
        if (mode === "base64") {
            return { output: decode ? decodeBase64(text) : encodeBase64(text, urlSafe), error: null };
        }
        if (mode === "url") {
            return { output: decode ? decodeURIComponent(text) : encodeURIComponent(text), error: null };
        }
        return { output: decode ? unescapeHtml(text) : escapeHtml(text), error: null };
    } catch (error) {
        return { output: "", error: (error as Error).message };
    }
}

function EncodeDecodePanel() {
    const [mode, setMode] = useState<Mode>("base64");
    const [text, setText] = useState("");
    const [decode, setDecode] = useState(false);
    const [urlSafe, setUrlSafe] = useState(false);

    const result = useMemo(
        () => (text ? transform(mode, text, decode, urlSafe) : { output: "", error: null }),
        [mode, text, decode, urlSafe],
    );

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="flex flex-wrap items-center gap-2">
                {(Object.keys(MODE_LABELS) as Mode[]).map((value) => (
                    <Button
                        key={value}
                        variant={mode === value ? "default" : "outline"}
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setMode(value)}
                    >
                        {MODE_LABELS[value]}
                    </Button>
                ))}

                <span className="mx-1 h-5 w-px bg-border" />

                <Button
                    variant={decode ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setDecode((value) => !value)}
                >
                    {decode ? "Decoding" : "Encoding"}
                </Button>

                {mode === "base64" && !decode && (
                    <Button
                        variant={urlSafe ? "default" : "outline"}
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setUrlSafe((value) => !value)}
                    >
                        URL-safe
                    </Button>
                )}
            </div>

            {result.error && <ErrorNote>{result.error}</ErrorNote>}

            <div className="grid gap-3 md:grid-cols-2 flex-1 min-h-0">
                <ToolPanel title="Input">
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        placeholder={decode ? "Paste encoded text" : "Paste plain text"}
                        spellCheck={false}
                        className="font-mono text-xs flex-1 min-h-0 resize-none"
                    />
                </ToolPanel>
                <ToolPanel title="Output" actions={<CopyButton value={result.output} />}>
                    <OutputBox value={result.output} placeholder="Result appears here" />
                </ToolPanel>
            </div>
        </div>
    );
}

function HashPanel() {
    const [text, setText] = useState("");
    const [digests, setDigests] = useState<Partial<Record<HashAlgorithm, string>>>({});

    useEffect(() => {
        if (!text) {
            setDigests({});
            return;
        }

        let cancelled = false;
        Promise.all(HASH_ALGORITHMS.map(async (algorithm) => [algorithm, await hashText(text, algorithm)] as const))
            .then((entries) => {
                if (!cancelled) setDigests(Object.fromEntries(entries));
            });

        return () => {
            cancelled = true;
        };
    }, [text]);

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder="Text to hash"
                spellCheck={false}
                className="font-mono text-xs h-24 resize-none"
            />

            <p className="text-[11px] text-muted-foreground">
                MD5 is not offered — the browser's crypto API does not implement it, and it is unfit for anything
                security-related anyway.
            </p>

            <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-auto">
                {HASH_ALGORITHMS.map((algorithm) => (
                    <ToolPanel
                        key={algorithm}
                        title={algorithm}
                        actions={<CopyButton value={digests[algorithm] ?? ""} label={`Copy ${algorithm}`} />}
                    >
                        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono break-all">
                            {digests[algorithm] ?? <span className="text-muted-foreground">—</span>}
                        </p>
                    </ToolPanel>
                ))}
            </div>
        </div>
    );
}

function UuidPanel() {
    const [version, setVersion] = useState<"v4" | "v7">("v4");
    const [count, setCount] = useState(5);
    const [ids, setIds] = useState<string[]>([]);

    const generate = () => {
        const make = version === "v4" ? uuidV4 : uuidV7;
        setIds(Array.from({ length: count }, () => make()));
    };

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="flex flex-wrap items-center gap-2">
                {(["v4", "v7"] as const).map((value) => (
                    <Button
                        key={value}
                        variant={version === value ? "default" : "outline"}
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setVersion(value)}
                    >
                        UUID {value}
                    </Button>
                ))}

                {([1, 5, 10, 25] as const).map((value) => (
                    <Button
                        key={value}
                        variant={count === value ? "secondary" : "ghost"}
                        size="sm"
                        className="h-8 text-xs"
                        onClick={() => setCount(value)}
                    >
                        ×{value}
                    </Button>
                ))}

                <Button size="sm" className="h-8 text-xs gap-1.5" onClick={generate}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Generate
                </Button>
            </div>

            <p className="text-[11px] text-muted-foreground">
                {version === "v4"
                    ? "Random. Use where ordering does not matter."
                    : "Time-ordered — sorts by creation time, which makes it a friendlier database key than v4."}
            </p>

            <ToolPanel title="Generated" actions={<CopyButton value={ids.join("\n")} label="Copy all" />} className="flex-1">
                <OutputBox value={ids.join("\n")} placeholder="Press Generate" />
            </ToolPanel>
        </div>
    );
}

export default function EncodersTool() {
    return (
        <Tabs defaultValue="encode" className="flex flex-col h-full min-h-0">
            <TabsList className="self-start">
                <TabsTrigger value="encode">Encode / decode</TabsTrigger>
                <TabsTrigger value="hash">Hash</TabsTrigger>
                <TabsTrigger value="uuid">UUID</TabsTrigger>
            </TabsList>
            <TabsContent value="encode" className="flex-1 min-h-0">
                <EncodeDecodePanel />
            </TabsContent>
            <TabsContent value="hash" className="flex-1 min-h-0">
                <HashPanel />
            </TabsContent>
            <TabsContent value="uuid" className="flex-1 min-h-0">
                <UuidPanel />
            </TabsContent>
        </Tabs>
    );
}
