import { useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { diffLines, DEFAULT_MAX_LINES, type DiffRow } from "@/lib/toolbox/textDiff";
import { ToolPanel, WarningNote } from "./toolbox-shared";

const ROW_STYLES: Record<DiffRow["type"], string> = {
    same: "",
    add: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    del: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
};

const ROW_SIGNS: Record<DiffRow["type"], string> = { same: " ", add: "+", del: "-" };

export default function TextDiff() {
    const [left, setLeft] = useState("");
    const [right, setRight] = useState("");
    const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
    const [ignoreCase, setIgnoreCase] = useState(false);

    const result = useMemo(
        () => diffLines(left, right, { ignoreWhitespace, ignoreCase }),
        [left, right, ignoreWhitespace, ignoreCase],
    );

    const hasInput = left.trim().length > 0 || right.trim().length > 0;

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    variant={ignoreWhitespace ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setIgnoreWhitespace((value) => !value)}
                >
                    Ignore whitespace
                </Button>
                <Button
                    variant={ignoreCase ? "default" : "outline"}
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setIgnoreCase((value) => !value)}
                >
                    Ignore case
                </Button>

                {hasInput && (
                    <div className="flex items-center gap-1.5 ml-auto">
                        <Badge variant="outline" className="font-normal text-emerald-600 dark:text-emerald-400">
                            +{result.stats.added}
                        </Badge>
                        <Badge variant="outline" className="font-normal text-rose-600 dark:text-rose-400">
                            −{result.stats.removed}
                        </Badge>
                        <Badge variant="secondary" className="font-normal">
                            {result.stats.unchanged} unchanged
                        </Badge>
                    </div>
                )}
            </div>

            {result.truncated && (
                <WarningNote>
                    Only the first {DEFAULT_MAX_LINES.toLocaleString()} lines of each side were compared.
                </WarningNote>
            )}

            <div className="grid gap-3 md:grid-cols-2 h-40 shrink-0">
                <ToolPanel title="Original">
                    <Textarea
                        value={left}
                        onChange={(event) => setLeft(event.target.value)}
                        placeholder="Original text"
                        spellCheck={false}
                        className="font-mono text-xs flex-1 min-h-0 resize-none"
                    />
                </ToolPanel>
                <ToolPanel title="Changed">
                    <Textarea
                        value={right}
                        onChange={(event) => setRight(event.target.value)}
                        placeholder="Changed text"
                        spellCheck={false}
                        className="font-mono text-xs flex-1 min-h-0 resize-none"
                    />
                </ToolPanel>
            </div>

            <ToolPanel title="Difference" className="flex-1">
                <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/40">
                    {!hasInput ? (
                        <p className="p-3 text-xs text-muted-foreground">Paste text into both sides to compare.</p>
                    ) : (
                        <table className="w-full text-xs font-mono">
                            <tbody>
                                {result.rows.map((row, index) => (
                                    <tr key={index} className={ROW_STYLES[row.type]}>
                                        <td className="w-10 select-none px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                                            {row.leftLine ?? ""}
                                        </td>
                                        <td className="w-10 select-none px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                                            {row.rightLine ?? ""}
                                        </td>
                                        <td className="w-4 select-none py-0.5 text-center">{ROW_SIGNS[row.type]}</td>
                                        <td className="px-2 py-0.5 whitespace-pre-wrap break-all">{row.text || " "}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            </ToolPanel>
        </div>
    );
}
