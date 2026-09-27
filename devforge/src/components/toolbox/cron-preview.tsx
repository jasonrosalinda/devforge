import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { parseCron, describeCron, nextRuns } from "@/lib/toolbox/cron";
import { ErrorNote, ToolPanel, WarningNote } from "./toolbox-shared";

const RUN_COUNT = 10;

const UTC_FORMAT: Intl.DateTimeFormatOptions = {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
};

/** Plain-English summary and next fire times for an expression. Shared by the Explain and Create tabs. */
export function CronPreview({ expression }: { expression: string }) {
    const parsed = useMemo(() => parseCron(expression), [expression]);
    const runs = useMemo(
        () => (parsed.cron ? nextRuns(parsed.cron, new Date(), RUN_COUNT) : []),
        [parsed.cron],
    );

    const fieldHint = parsed.cron?.fieldCount === 6
        ? "6 fields — NCRONTAB (seconds minutes hours day month weekday)"
        : "5 fields — standard cron (minutes hours day month weekday)";

    return (
        <>
            {parsed.error ? (
                <ErrorNote>
                    {parsed.error.field ? `${parsed.error.field}: ` : ""}
                    {parsed.error.message}
                </ErrorNote>
            ) : (
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                    <p className="text-sm font-semibold">{describeCron(parsed.cron!)}</p>
                    <p className="text-[11px] text-muted-foreground">{fieldHint}</p>
                </div>
            )}

            {parsed.cron && runs.length === 0 && (
                <WarningNote>
                    This expression has no upcoming run in the next five years — check the day and month fields.
                </WarningNote>
            )}

            {runs.length > 0 && (
                <ToolPanel
                    title={`Next ${runs.length} runs`}
                    actions={<Badge variant="secondary" className="font-normal">Schedules run in UTC</Badge>}
                    className="flex-1"
                >
                    <div className="flex-1 min-h-0 overflow-auto rounded-md border">
                        <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                                <tr className="text-left text-muted-foreground">
                                    <th className="px-3 py-1.5 font-medium">#</th>
                                    <th className="px-3 py-1.5 font-medium">UTC</th>
                                    <th className="px-3 py-1.5 font-medium">Local</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y">
                                {runs.map((run, index) => (
                                    <tr key={run.toISOString()}>
                                        <td className="px-3 py-1.5 tabular-nums text-muted-foreground">{index + 1}</td>
                                        <td className="px-3 py-1.5 tabular-nums">
                                            {run.toLocaleString("en-GB", { ...UTC_FORMAT, timeZone: "UTC" })}
                                        </td>
                                        <td className="px-3 py-1.5 tabular-nums">{run.toLocaleString([], UTC_FORMAT)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </ToolPanel>
            )}
        </>
    );
}
