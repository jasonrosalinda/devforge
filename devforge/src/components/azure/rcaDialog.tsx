import { marked } from 'marked';
import { Loader2, Download, Share2, RotateCw, AlertTriangle, ScanSearch, Check, FileText } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { splitQuickSummary } from './rcaHtml';

export type RcaStatus = 'running' | 'done' | 'error';

interface RcaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  status: RcaStatus;
  markdown: string;
  stages: string[];
  error: string | null;
  onExport: () => void;
  onExportPdf: () => void;
  onCopyTeams: () => void;
  onCopySummary: () => void;
  onRetry: () => void;
}

export function RcaDialog({
  open, onOpenChange, title, status, markdown, stages, error,
  onExport, onExportPdf, onCopyTeams, onCopySummary, onRetry,
}: RcaDialogProps) {
  // Lift the plain-English summary out of the body so it renders as a callout —
  // it is the part non-engineers read, and it is easy to miss inline.
  const { summary, body } = status === 'done' ? splitQuickSummary(markdown) : { summary: '', body: '' };
  const html = status === 'done' ? (marked.parse(body, { async: false }) as string) : '';
  const summaryHtml = summary ? (marked.parse(summary, { async: false }) as string) : '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ScanSearch className="h-4 w-4 text-[#58a6ff]" />
            RCA Report — {title}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-[200px] overflow-y-auto rounded-md border border-border bg-card/40 p-4 text-sm">
          {status === 'error' ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <p className="max-w-md text-sm text-destructive">{error || 'Something went wrong.'}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>
                <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Retry
              </Button>
            </div>
          ) : status === 'running' ? (
            <div className="flex flex-col gap-3">
              {stages.length === 0 && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Starting…
                </div>
              )}
              <ul className="flex flex-col gap-2">
                {stages.map((s, i) => {
                  // Last stage is in progress until Claude output starts streaming.
                  const active = i === stages.length - 1 && !markdown;
                  return (
                    <li key={i} className="flex items-start gap-2 text-xs leading-relaxed">
                      {active
                        ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[#58a6ff]" />
                        : <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#3fb950]" />}
                      <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{s}</span>
                    </li>
                  );
                })}
                {markdown && (
                  <li className="flex items-start gap-2 text-xs leading-relaxed">
                    <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[#58a6ff]" />
                    <span className="text-foreground">Generating analysis…</span>
                  </li>
                )}
              </ul>
              {markdown && (
                <pre className="mt-1 whitespace-pre-wrap border-t border-border pt-3 font-mono text-xs leading-relaxed text-foreground/80">
                  {markdown}
                </pre>
              )}
            </div>
          ) : (
            <>
              {summaryHtml && (
                <div className="rca-summary">
                  <div className="rca-summary-label">
                    <ScanSearch className="h-3.5 w-3.5" />
                    <span>Quick Summary</span>
                    <button
                      type="button"
                      className="rca-summary-copy"
                      onClick={onCopySummary}
                      title="Copy the Quick Summary formatted for Microsoft Teams"
                    >
                      <Share2 className="h-3 w-3" />
                      Copy for Teams
                    </button>
                  </div>
                  <div dangerouslySetInnerHTML={{ __html: summaryHtml }} />
                </div>
              )}
              <div className="rca-content" dangerouslySetInnerHTML={{ __html: html }} />
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={status !== 'done'} onClick={onExport}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> Export MD
          </Button>
          <Button variant="outline" size="sm" disabled={status !== 'done'} onClick={onExportPdf}>
            <FileText className="mr-1.5 h-3.5 w-3.5" /> PDF
          </Button>
          <Button variant="default" size="sm" disabled={status !== 'done'} onClick={onCopyTeams}>
            <Share2 className="mr-1.5 h-3.5 w-3.5" /> Copy for Teams
          </Button>
        </div>

        <style>{`
          .rca-summary {
            border: 1px solid rgba(88, 166, 255, .35); border-left: 3px solid #58a6ff;
            border-radius: 6px; background: rgba(88, 166, 255, .08);
            padding: 12px 14px; margin-bottom: 16px;
          }
          .rca-summary-label {
            display: flex; align-items: center; gap: 6px;
            font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
            color: #58a6ff; margin-bottom: 6px;
          }
          .rca-summary-copy {
            margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
            font: inherit; letter-spacing: .04em; color: #58a6ff;
            background: transparent; border: 1px solid rgba(88, 166, 255, .4);
            border-radius: 4px; padding: 2px 6px; cursor: pointer;
          }
          .rca-summary-copy:hover { background: rgba(88, 166, 255, .15); }
          .rca-summary p { font-size: 14px; line-height: 1.65; margin: 0; color: hsl(var(--foreground)); }
          .rca-summary p + p { margin-top: .5rem; }
          /* The summary leads with a verdict line, then a facts table. */
          .rca-summary table { width: auto; border-collapse: collapse; margin: .6rem 0; font-size: 12px; }
          .rca-summary th, .rca-summary td { border: 1px solid hsl(var(--border)); padding: 4px 9px; text-align: left; vertical-align: top; }
          .rca-summary th { background: hsl(var(--muted)); font-weight: 600; }
          .rca-summary td:first-child { white-space: nowrap; color: hsl(var(--muted-foreground)); }
          .rca-content { font-size: 13px; line-height: 1.6; color: hsl(var(--foreground)); }
          .rca-content > *:first-child { margin-top: 0; }
          .rca-content h1 { font-size: 1.25rem; font-weight: 700; margin: 0 0 .5rem; }
          .rca-content h2 { font-size: 1.05rem; font-weight: 700; margin: 1.25rem 0 .5rem; padding-bottom: .25rem; border-bottom: 1px solid hsl(var(--border)); }
          .rca-content h3 { font-size: .95rem; font-weight: 600; margin: 1rem 0 .35rem; }
          .rca-content p { margin: .5rem 0; }
          .rca-content ul, .rca-content ol { margin: .5rem 0; padding-left: 1.25rem; }
          .rca-content li { margin: .2rem 0; }
          .rca-content code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .85em; background: hsl(var(--muted)); padding: .1em .35em; border-radius: 4px; }
          .rca-content pre { background: hsl(var(--muted)); padding: .75rem; border-radius: 6px; overflow-x: auto; }
          .rca-content pre code { background: none; padding: 0; }
          .rca-content table { width: 100%; border-collapse: collapse; margin: .5rem 0; font-size: 12px; }
          .rca-content th, .rca-content td { border: 1px solid hsl(var(--border)); padding: 5px 8px; text-align: left; vertical-align: top; }
          .rca-content th { background: hsl(var(--muted)); font-weight: 600; }
          .rca-content a { color: #58a6ff; }
          .rca-content blockquote { border-left: 3px solid hsl(var(--border)); padding-left: .75rem; color: hsl(var(--muted-foreground)); margin: .5rem 0; }
          .rca-content hr { border: none; border-top: 1px solid hsl(var(--border)); margin: 1rem 0; }
        `}</style>
      </DialogContent>
    </Dialog>
  );
}
