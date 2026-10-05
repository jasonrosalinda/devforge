// One runbook section as an editable time-series table. Planned Start / End are
// shown as computed (Start = Time, End = Start + Duration) and never typed.
// Activity cells holding mentions, screenshots, drawers or tables are shown
// read-only — plain-text editing would lose them — with an opt-in to replace.

import { memo } from 'react';
import { ArrowDown, ArrowUp, Copy, CornerLeftUp, Link2, Link2Off, MoreVertical, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { STATUS_CLASS } from '@/components/release-pilot/statusPill';
import type { StatusColor } from '@/lib/parse-runbook';
import {
  colIndex, deleteRow, duplicateRow, effectiveCell, insertRow, moveRow, setCell, setSameAsAbove, type EditSection,
} from '@/lib/runbook-model';
import { cellText } from '@/lib/runbook-storage';
import {
  cellDate, setCellDate, labelToInputTime, inputTimeToLabel, retimeRow, type RowTimes,
} from '@/lib/runbook-schedule';
import {
  STATUS_OPTIONS, buildPics, cellToText, getStatus, picsOf, setStatus, textToCell,
} from '@/lib/runbook-cells';
import { PicPicker } from './picPicker';
import { cellPreviewHtml } from '@/lib/runbook-richtext/preview';

const NO_STATUS = '__none__';
const LOZENGE: Record<string, StatusColor> = { Grey: 'grey', Blue: 'blue', Green: 'green', Red: 'red', Yellow: 'yellow', Purple: 'purple' };

interface SectionTableProps {
  section: EditSection;
  times: RowTimes[];
  names: Map<string, string>;
  anchorRow: number | null;
  onChange: (next: EditSection) => void;
  searchUsers: (q: string) => Promise<{ accountId: string; displayName: string }[]>;
  onLearnName: (accountId: string, name: string) => void;
  onOpenRich: (r: number, c: number) => void;
}

function MergeToggle({ merged, onToggle, what }: { merged: boolean; onToggle: () => void; what: string }) {
  return (
    <Hint label={merged ? `Give this row its own ${what}` : `Use the ${what} of the row above`}>
      <button type="button" onClick={onToggle} aria-label={merged ? `Split ${what}` : `Same ${what} as above`}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
        {merged ? <Link2Off className="h-3 w-3" /> : <Link2 className="h-3 w-3" />}
      </button>
    </Hint>
  );
}

export const RunbookSectionTable = memo(function RunbookSectionTable({
  section, times, names, anchorRow, onChange, searchUsers, onLearnName, onOpenRich,
}: SectionTableProps) {
  if (!section.editable) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-warning">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        This table has cells merged across columns, so devForge leaves it as it is. Edit it in Confluence.
      </div>
    );
  }

  const col = (kind: Parameters<typeof colIndex>[1]) => colIndex(section, kind);
  const set = (r: number, c: number, inner: string) => onChange(setCell(section, r, c, inner));
  const shown = (r: number, c: number) => effectiveCell(section, r, c).inner;

  function renderCell(r: number, c: number) {
    const kind = section.columns[c]!.kind;
    const own = section.rows[r]!.cells[c]!;
    const inner = shown(r, c);
    const t = times[r]!;

    switch (kind) {
      case 'date':
        return (
          <div className="flex items-center gap-1">
            {own.sameAsAbove && r > 0
              ? <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><CornerLeftUp className="h-3 w-3" />{cellDate(inner) ?? '—'}</span>
              : <Input type="date" value={cellDate(inner) ?? ''} className="h-7 w-[8.5rem] px-1.5 text-xs"
                  onChange={e => e.target.value && set(r, c, setCellDate(own.inner, e.target.value))} />}
            {r > 0 && <MergeToggle what="date" merged={own.sameAsAbove} onToggle={() => onChange(setSameAsAbove(section, r, c, !own.sameAsAbove))} />}
          </div>
        );
      case 'time': {
        const note = cellText(inner).replace(/^\s*\d{1,2}:\d{2}\s*[AaPp][Mm]\s*/, '');
        return (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              {own.sameAsAbove && r > 0
                ? <span className="flex items-center gap-1 text-[11px] text-muted-foreground"><CornerLeftUp className="h-3 w-3" />{t.startLabel ?? '—'}</span>
                : <Input type="time" value={labelToInputTime(cellText(inner))} className="h-7 w-[6.5rem] px-1.5 text-xs"
                    onChange={e => { const l = inputTimeToLabel(e.target.value); if (l) onChange(retimeRow(section, r, l)); }} />}
              {r > 0 && <MergeToggle what="time" merged={own.sameAsAbove} onToggle={() => onChange(setSameAsAbove(section, r, c, !own.sameAsAbove))} />}
            </div>
            {note && !own.sameAsAbove && <span className="text-[10px] leading-tight text-muted-foreground">{note}</span>}
          </div>
        );
      }
      case 'startTime':
        return <span className="text-xs tabular-nums">{t.startLabel ?? '—'}</span>;
      case 'endTime':
        return (
          <span className="inline-flex items-center gap-1 text-xs tabular-nums">
            {t.endLabel ?? '—'}
            {t.endsNextDay && <span className="rounded bg-muted px-1 text-[9px] font-semibold text-muted-foreground">+1d</span>}
            {t.issues.length > 0 && (
              <Hint label={t.issues.join(' ')}><TriangleAlert className="h-3 w-3 text-warning" /></Hint>
            )}
          </span>
        );
      case 'duration':
        return (
          <Input key={`${section.rows[r]!.key}-dur-${inner}`} defaultValue={cellText(inner)} placeholder="15m"
            className="h-7 w-20 px-1.5 text-xs" onBlur={e => { if (e.target.value !== cellText(inner)) set(r, c, textToCell(e.target.value)); }} />
        );
      case 'status': {
        const s = getStatus(inner);
        const options = s && !STATUS_OPTIONS.some(o => o.text === s.text) ? [...STATUS_OPTIONS, { text: s.text, colour: s.colour }] : STATUS_OPTIONS;
        return (
          <Select value={s?.text ?? NO_STATUS} onValueChange={v => set(r, c, setStatus(own.inner, v === NO_STATUS ? null : v))}>
            <SelectTrigger className="h-7 w-[7.5rem] px-1.5 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_STATUS} className="text-xs text-muted-foreground">— none —</SelectItem>
              {options.map(o => (
                <SelectItem key={o.text} value={o.text} className="text-xs">
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[LOZENGE[o.colour] ?? 'grey']}`}>{o.text}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      }
      case 'pics':
        return (
          <PicPicker pics={picsOf(inner)} names={names} search={searchUsers} onLearnName={onLearnName}
            onChange={p => set(r, c, buildPics(p))} />
        );
      case 'activity':
      case 'logbook': {
        const empty = !cellToText(inner) && !/<ac:image|<ac:structured-macro|<ri:user|<time|<table/.test(inner);
        const open = () => onOpenRich(r, c);
        return (
          <div role="button" tabIndex={0} title="Click to edit"
            onClick={e => {
              // Links open in the browser and drawers toggle; anything else edits the cell.
              if ((e.target as HTMLElement).closest('a, summary')) return;
              open();
            }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
            className="block w-full cursor-pointer rounded border border-transparent px-1.5 py-1 text-left hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            {empty
              ? <span className="text-xs text-muted-foreground">{kind === 'activity' ? 'Activity…' : 'Add notes or screenshots…'}</span>
              // Sanitized by cellPreviewHtml: no scripts, frames, handlers or javascript: links.
              : <div className="prose-runbook cell-preview break-words" dangerouslySetInnerHTML={{ __html: cellPreviewHtml(inner, names) }} />}
          </div>
        );
      }
      default:
        return <span className="text-xs text-muted-foreground">{cellText(inner)}</span>;
    }
  }

  const last = section.rows.length - 1;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-muted/50">
            {section.columns.map((c, i) => (
              <th key={i} className={`border-b px-2 py-1.5 text-left font-semibold ${c.kind === 'startTime' || c.kind === 'endTime' ? 'text-muted-foreground' : ''}`}>
                {c.label}
                {(c.kind === 'startTime' || c.kind === 'endTime') && <span className="ml-1 font-normal">(auto)</span>}
              </th>
            ))}
            <th className="w-8 border-b" aria-label="Row actions" />
          </tr>
        </thead>
        <tbody>
          {section.rows.map((row, r) => (
            <tr key={row.key} className={`align-top ${anchorRow === r ? 'bg-brand/5' : ''}`}>
              {section.columns.map((c, ci) => (
                <td key={ci} className={`border-b px-2 py-1.5 ${c.kind === 'activity' ? 'min-w-[16rem]' : ''}`}>{renderCell(r, ci)}</td>
              ))}
              <td className="border-b px-1 py-1.5">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" aria-label="Row actions" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => onChange(insertRow(section, r - 1))}><Plus className="mr-2 h-3.5 w-3.5" /> Insert above</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onChange(insertRow(section, r))}><Plus className="mr-2 h-3.5 w-3.5" /> Insert below</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onChange(duplicateRow(section, r))}><Copy className="mr-2 h-3.5 w-3.5" /> Duplicate</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={r === 0} onClick={() => onChange(moveRow(section, r, r - 1))}><ArrowUp className="mr-2 h-3.5 w-3.5" /> Move up</DropdownMenuItem>
                    <DropdownMenuItem disabled={r === last} onClick={() => onChange(moveRow(section, r, r + 1))}><ArrowDown className="mr-2 h-3.5 w-3.5" /> Move down</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={section.rows.length === 1} className="text-destructive focus:text-destructive" onClick={() => onChange(deleteRow(section, r))}>
                      <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete row
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
});
