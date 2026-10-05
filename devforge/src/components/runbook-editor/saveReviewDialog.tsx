// What a save or create will write to Confluence, confirmed before anything is sent.

import { Loader2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import type { RunbookChange } from '@/lib/runbook-diff';

interface SaveReviewDialogProps {
  open: boolean;
  heading: string;
  target: string;                      // e.g. "Saves version 6 of “26 Oct …” in Confluence."
  confirmLabel: string;
  changes: RunbookChange[] | null;     // null: a new page — no diff, the whole page is written
  titleChange?: { before: string; after: string } | undefined;
  busy: boolean;
  error: string | null;
  children?: React.ReactNode;          // extra fields (title, parent page) for create
  canConfirm?: boolean;
  screenshots?: { upload: number; copy: number } | undefined;
  onConfirm: () => void;
  onClose: () => void;
}

const KIND_LABEL = { added: 'Added', removed: 'Removed', changed: 'Changed' } as const;

// One entry per row: a reschedule changes four or five cells of every row.
function groupByRow(changes: RunbookChange[]) {
  const groups: (Pick<RunbookChange, 'kind' | 'row' | 'activity'> & { cells: RunbookChange[] })[] = [];
  for (const c of changes) {
    const last = groups[groups.length - 1];
    if (last && last.kind === c.kind && last.row === c.row) last.cells.push(c);
    else groups.push({ kind: c.kind, row: c.row, activity: c.activity, cells: c.kind === 'changed' ? [c] : [] });
  }
  return groups;
}

export function SaveReviewDialog({
  open, heading, target, confirmLabel, changes, titleChange, busy, error, children, canConfirm = true, screenshots, onConfirm, onClose,
}: SaveReviewDialogProps) {
  const sections = changes ? [...new Set(changes.map(c => c.section))] : [];
  const nothing = changes !== null && changes.length === 0 && !titleChange;

  return (
    <Dialog open={open} onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>{target}</DialogDescription>
        </DialogHeader>

        {children}

        {screenshots && (screenshots.upload > 0 || screenshots.copy > 0) && (
          <p className="text-xs text-muted-foreground">
            Screenshots: {[screenshots.upload && `${screenshots.upload} to upload`, screenshots.copy && `${screenshots.copy} to copy from the source page`].filter(Boolean).join(', ')}.
          </p>
        )}

        {changes !== null && (
          <div className="max-h-[50vh] overflow-auto rounded-md border text-xs">
            {titleChange && (
              <div className="border-b px-3 py-2">
                <span className="font-semibold">Title</span>: <span className="text-muted-foreground line-through">{titleChange.before}</span> → {titleChange.after}
              </div>
            )}
            {nothing && <p className="px-3 py-3 text-muted-foreground">No changes to save.</p>}
            {sections.map(sec => (
              <div key={sec} className="border-b last:border-b-0">
                <p className="bg-muted/40 px-3 py-1.5 font-semibold">{sec}</p>
                <ul>
                  {groupByRow(changes!.filter(c => c.section === sec)).map((g, i) => (
                    <li key={i} className="flex gap-2 px-3 py-1.5">
                      <span className={`w-16 shrink-0 font-medium ${g.kind === 'removed' ? 'text-destructive' : g.kind === 'added' ? 'text-success' : 'text-info'}`}>
                        {KIND_LABEL[g.kind]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="line-clamp-1"><span className="text-muted-foreground">Row {g.row} · </span>{g.activity || '(no activity)'}</span>
                        {g.cells.map((c, j) => (
                          <span key={j} className="line-clamp-2 block text-[11px]">
                            <span className="text-muted-foreground">{c.column}:</span>{' '}
                            <span className="text-muted-foreground line-through">{c.before || '—'}</span> → <span className="font-medium">{c.after || '—'}</span>
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={onConfirm} disabled={busy || nothing || !canConfirm} className="gap-1.5">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
