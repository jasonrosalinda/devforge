import type React from "react";
import { renderSafeMarkdown } from "@/lib/safe-markdown";
import { AlertTriangle, ChevronDown, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui";
import { Hint } from "@/components/ui/hint";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type AnalysisState = { status: 'running' | 'done' | 'error'; markdown: string; error: string | null };

// Shared shell for Claude-written reports: PageSpeed's quick read and repository
// investigation, and App Investigation. Same four states, same streaming pane — only
// the labels differ.
export function AnalysisCard({
    state, heading, icon, open, onToggle, onRetry, retryHint, runningLabel, writingLabel, progress, onCancel, footer, onReportClick,
}: {
    state: AnalysisState;
    heading: string;
    icon: React.ReactNode;
    open: boolean;
    onToggle: () => void;
    onRetry: () => void;
    retryHint: string;
    runningLabel: string;
    writingLabel: string;
    progress?: string | undefined;
    onCancel?: (() => void) | undefined;
    footer?: React.ReactNode;
    /** Click handler on the rendered report, for delegated links such as code citations. */
    onReportClick?: ((e: React.MouseEvent<HTMLDivElement>) => void) | undefined;
}) {
    return (
        <Card className="my-4 mx-6 shadow-none">
            <CardHeader>
                <CardTitle>
                    <Hint label={open ? 'Collapse the analysis' : 'Expand the analysis'} className="w-full">
                        <button
                            onClick={onToggle}
                            className="flex w-full items-center gap-2 text-sm text-left hover:opacity-80 transition-opacity"
                        >
                            {icon}
                            {heading}
                            <ChevronDown className={`ml-auto h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                        </button>
                    </Hint>
                </CardTitle>
            </CardHeader>
            {open && (
                <CardContent className="text-xs">
                    {state.status === 'running' && (
                        <div className="flex flex-col gap-2">
                            <div className="flex items-center gap-2 text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                {state.markdown ? writingLabel : runningLabel}
                                {onCancel && (
                                    <Hint label="Stop the investigation">
                                        <Button variant="ghost" size="sm" className="ml-auto h-6 px-2" onClick={onCancel}>Cancel</Button>
                                    </Hint>
                                )}
                            </div>
                            {/* Tool activity, kept out of the report text so the finished
                                answer isn't interleaved with investigation noise. */}
                            {progress && (
                                <div className="truncate font-mono text-[11px] text-muted-foreground/80">{progress}</div>
                            )}
                            {state.markdown && (
                                <pre className="whitespace-pre-wrap border-t border-border pt-2 font-mono text-[11px] leading-relaxed text-foreground/80">{state.markdown}</pre>
                            )}
                        </div>
                    )}
                    {state.status === 'error' && (
                        <div className="flex flex-col items-start gap-2">
                            <div className="flex items-center gap-2 text-destructive">
                                <AlertTriangle className="h-4 w-4" />
                                <span>{state.error || 'Something went wrong.'}</span>
                            </div>
                            <Hint label={retryHint}>
                                <Button variant="outline" size="sm" onClick={onRetry}>
                                    <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
                                </Button>
                            </Hint>
                        </div>
                    )}
                    {state.status === 'done' && (
                        <div className="ps-analysis-content" onClick={onReportClick} dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(state.markdown) }} />
                    )}
                    {footer}
                </CardContent>
            )}
        </Card>
    );
}
