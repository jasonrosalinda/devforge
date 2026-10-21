import { Copy, Loader2, Play, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Hint } from '@/components/ui/hint';
import { Toast } from '@/components/ui/toast';

/** The query Claude wrote, editable. Ctrl+Enter runs it as written — no Claude call. */
export function KqlEditor({
    kql, onChange, onRun, running, explanation, repaired,
}: {
    kql: string;
    onChange: (kql: string) => void;
    onRun: () => void;
    running: boolean;
    explanation?: string;
    repaired?: boolean;
}) {
    const toast = Toast();
    const rows = Math.min(16, Math.max(4, kql.split('\n').length + 1));

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">KQL</span>
                {repaired && (
                    <Hint label="The first query was rejected by App Insights; Claude fixed it and this version ran.">
                        <Badge variant="outline" className="gap-1 border-warning/40 bg-warning/10 text-[10px] font-normal text-warning">
                            <Wrench className="h-3 w-3" /> repaired
                        </Badge>
                    </Hint>
                )}
                <div className="flex-1" />
                <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { void navigator.clipboard.writeText(kql); toast.success('Copied KQL'); }}
                    disabled={!kql}
                >
                    <Copy /> Copy
                </Button>
                <Hint label="Run the query as written (Ctrl+Enter)">
                    <Button variant="outline" size="sm" onClick={onRun} disabled={!kql.trim() || running}>
                        {running ? <Loader2 className="animate-spin" /> : <Play />} Run
                    </Button>
                </Hint>
            </div>
            <textarea
                value={kql}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!running && kql.trim()) onRun(); }
                }}
                rows={rows}
                spellCheck={false}
                aria-label="KQL query"
                className="w-full resize-y rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {explanation && <p className="text-sm text-muted-foreground">{explanation}</p>}
        </div>
    );
}
