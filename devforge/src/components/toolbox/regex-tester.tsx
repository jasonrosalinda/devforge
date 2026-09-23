import { useMemo, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { lintDotNetDifferences, runRegex, MAX_MATCHES } from "@/lib/toolbox/regexLint";
import { ErrorNote, ToolPanel, WarningNote } from "./toolbox-shared";

const FLAGS = [
    { flag: "g", label: "global — every match, not just the first" },
    { flag: "i", label: "ignore case" },
    { flag: "m", label: "multiline — ^ and $ match line boundaries" },
    { flag: "s", label: "dotall — . matches newlines" },
    { flag: "u", label: "unicode" },
];

/** Splits the subject into plain and matched runs so matches can be tinted in place. */
function highlight(input: string, ranges: { index: number; length: number }[]): ReactNode[] {
    const parts: ReactNode[] = [];
    let cursor = 0;

    ranges.forEach((range, i) => {
        if (range.index > cursor) parts.push(input.slice(cursor, range.index));
        parts.push(
            <mark key={i} className="rounded-sm bg-primary/25 text-foreground">
                {input.slice(range.index, range.index + range.length) || "​"}
            </mark>,
        );
        cursor = range.index + range.length;
    });

    if (cursor < input.length) parts.push(input.slice(cursor));
    return parts;
}

export default function RegexTester() {
    const [pattern, setPattern] = useState("");
    const [flags, setFlags] = useState("g");
    const [subject, setSubject] = useState("");

    const result = useMemo(
        () => (pattern ? runRegex(pattern, flags, subject) : { matches: [], error: null, truncated: false }),
        [pattern, flags, subject],
    );
    const warnings = useMemo(() => (pattern ? lintDotNetDifferences(pattern) : []), [pattern]);

    const toggleFlag = (flag: string) =>
        setFlags((current) => (current.includes(flag) ? current.replace(flag, "") : current + flag));

    return (
        <div className="flex flex-col gap-3 h-full min-h-0">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    value={pattern}
                    onChange={(event) => setPattern(event.target.value)}
                    placeholder="Pattern, without delimiters — e.g. ^(?<id>\d{3})-\w+$"
                    spellCheck={false}
                    className="font-mono text-xs flex-1 min-w-[16rem]"
                />
                <div className="flex items-center gap-1">
                    {FLAGS.map(({ flag, label }) => (
                        <Hint key={flag} label={label}>
                            <Button
                                variant={flags.includes(flag) ? "default" : "outline"}
                                size="sm"
                                className="h-8 w-8 p-0 font-mono text-xs"
                                onClick={() => toggleFlag(flag)}
                            >
                                {flag}
                            </Button>
                        </Hint>
                    ))}
                </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
                Runs on the JavaScript engine, with warnings where .NET's engine behaves differently.
            </p>

            {result.error && <ErrorNote>{result.error}</ErrorNote>}

            {warnings.map((warning) => (
                <WarningNote key={warning.construct}>
                    <span className="font-medium">{warning.construct}</span> — {warning.message}
                </WarningNote>
            ))}

            <div className="grid gap-3 md:grid-cols-2 flex-1 min-h-0">
                <ToolPanel title="Test string">
                    <Textarea
                        value={subject}
                        onChange={(event) => setSubject(event.target.value)}
                        placeholder="Text to match against"
                        spellCheck={false}
                        className="font-mono text-xs flex-1 min-h-0 resize-none"
                    />
                </ToolPanel>

                <ToolPanel
                    title="Matches"
                    actions={
                        <Badge variant="secondary" className="font-normal">
                            {result.matches.length}
                            {result.truncated ? "+" : ""}
                        </Badge>
                    }
                >
                    <div className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted/40 p-3 text-xs font-mono whitespace-pre-wrap break-all">
                        {subject ? highlight(subject, result.matches) : <span className="text-muted-foreground">—</span>}
                    </div>
                </ToolPanel>
            </div>

            {result.truncated && (
                <WarningNote>Stopped after {MAX_MATCHES.toLocaleString()} matches.</WarningNote>
            )}

            {result.matches.length > 0 && (
                <div className="max-h-48 overflow-auto rounded-md border">
                    <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                            <tr className="text-left text-muted-foreground">
                                <th className="px-3 py-1.5 font-medium">#</th>
                                <th className="px-3 py-1.5 font-medium">Index</th>
                                <th className="px-3 py-1.5 font-medium">Match</th>
                                <th className="px-3 py-1.5 font-medium">Groups</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {result.matches.slice(0, 200).map((match, i) => (
                                <tr key={`${match.index}-${i}`}>
                                    <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{i + 1}</td>
                                    <td className="px-3 py-1.5 tabular-nums">{match.index}</td>
                                    <td className="px-3 py-1.5 font-mono break-all">{match.text || "(empty)"}</td>
                                    <td className="px-3 py-1.5">
                                        {match.groups.length === 0 ? (
                                            <span className="text-muted-foreground">—</span>
                                        ) : (
                                            <div className="flex flex-wrap gap-1">
                                                {match.groups.map((group) => (
                                                    <Badge key={group.name} variant="outline" className="font-normal font-mono">
                                                        {group.name}: {group.value ?? "undefined"}
                                                    </Badge>
                                                ))}
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
