// Release Pilot — renders a parsed Confluence runbook as a shadcn table,
// preserving the original cell formatting (bold, nested lists, expand drawers,
// inline screenshots). Clicking any image opens a lightbox; each row can be
// opened in a Drawer for a larger view.

import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';

import type { ParsedRunbook, RunbookImage, RunbookCell, RunbookRow, StatusColor } from '@/lib/parse-runbook';
import { StatusPill } from './statusPill';

interface RunbookTableProps {
  data: ParsedRunbook;
  typedRows: RunbookRow[];
  onImageClick: (img: RunbookImage) => void;
}

// Fallback colour when a cell has status-like text but no Confluence lozenge.
function keywordColor(text: string): StatusColor {
  const t = text.toLowerCase();
  if (/(done|complete|success|pass|ok\b|deployed)/.test(t)) return 'green';
  if (/(fail|error|blocked|cancel|reject)/.test(t)) return 'red';
  if (/(pending|progress|wip|todo|hold|wait)/.test(t)) return 'yellow';
  return 'grey';
}

// Tailwind child-selectors that style raw Confluence HTML to match the app theme.
export const RICH =
  'text-xs leading-relaxed break-words ' +
  '[&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
  '[&_strong]:font-semibold [&_b]:font-semibold ' +
  '[&_ul]:list-disc [&_ul]:pl-4 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 [&_ol]:my-1 ' +
  '[&_li]:my-0.5 [&_li>ul]:mt-0.5 ' +
  '[&_h1]:font-semibold [&_h1]:text-sm [&_h2]:font-semibold [&_h2]:text-sm [&_h3]:font-semibold ' +
  '[&_a]:text-info [&_a]:underline ' +
  '[&_table]:my-1 [&_td]:border [&_td]:border-border [&_td]:px-1.5 [&_td]:py-0.5 [&_th]:border [&_th]:border-border [&_th]:px-1.5 ' +
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono ' +
  '[&_details]:my-2 [&_details]:rounded-md [&_details]:border [&_details]:border-border [&_details]:overflow-hidden ' +
  '[&_summary]:flex [&_summary]:cursor-pointer [&_summary]:select-none [&_summary]:list-none [&_summary]:items-center [&_summary]:gap-1.5 [&_summary]:px-3 [&_summary]:py-2 [&_summary]:text-xs [&_summary]:font-medium [&_summary]:text-muted-foreground [&_summary]:bg-muted/40 [&_summary:hover]:bg-muted/70 ' +
  '[&_details>*:not(summary)]:px-3 [&_details>*:not(summary)]:py-2 ' +
  '[&_.expand-container]:my-2 [&_.expand-container]:rounded-md [&_.expand-container]:border [&_.expand-container]:border-border [&_.expand-container]:p-2 ' +
  '[&_.expand-control]:font-medium [&_.expand-control]:text-muted-foreground ' +
  '[&_img]:my-2 [&_img]:max-h-56 [&_img]:rounded [&_img]:border [&_img]:border-border [&_img]:cursor-zoom-in';

// Resolve a cell's status pill: prefer the Confluence lozenge colour, else fall
// back to keyword matching for status-column cells that are plain text.
function cellStatus(cell: RunbookCell, isStatusCol: boolean): { text: string; color: StatusColor } | null {
  if (!isStatusCol) return null;
  if (cell.status) return cell.status;
  if (cell.text) return { text: cell.text, color: keywordColor(cell.text) };
  return null;
}

// Date/Time columns are the ones Confluence authors merge with rowspan; a
// continuation row parses as blank, and authors also just retype the same value
// on the next row. Both mean "same as above", so rebuild the merge here.
// Returns per row: the rowSpan to render, or 0 when the row above covers it.
// `breaksRun` force-starts a new run at that row (used to stop a Time run from
// spanning a date change, which would leave the two columns visually crossed).
function mergeSpans(rows: RunbookCell[][], col: number, breaksRun?: (r: number) => boolean): number[] {
  const spans = new Array<number>(rows.length).fill(1);
  if (col < 0) return spans;
  let anchor = -1;
  rows.forEach((cells, r) => {
    const text = (cells[col]?.text ?? '').trim();
    const anchorText = anchor >= 0 ? (rows[anchor]?.[col]?.text ?? '').trim() : '';
    // Blank continues the run; a repeat of the anchor's value folds into it.
    if (anchor >= 0 && !breaksRun?.(r) && (text === '' || text === anchorText)) {
      spans[r] = 0;
      spans[anchor] = (spans[anchor] ?? 1) + 1;
    } else {
      anchor = r;
    }
  });
  return spans;
}

// When raw HTML is clicked, open the lightbox if the target was an <img>.
function makeImageClickHandler(onImageClick: (img: RunbookImage) => void) {
  return (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      const img = target as HTMLImageElement;
      onImageClick({ src: img.src, name: img.getAttribute('alt') || 'screenshot' });
    }
  };
}

export function RunbookTable({ data, typedRows, onImageClick }: RunbookTableProps) {
  const onImg = makeImageClickHandler(onImageClick);
  const statusIdx = data.columns.findIndex(c => /status/i.test(c));
  const picsIdx   = data.columns.findIndex(c => /pic|person|owner/i.test(c));
  // "Time" only — never "Start Time" / "End Time", which are per-row values.
  const dateIdx   = data.columns.findIndex(c => /^\s*date/i.test(c));
  const timeIdx   = data.columns.findIndex(c => /^\s*time/i.test(c));
  const dateSpans = mergeSpans(data.rows, dateIdx);
  const timeSpans = mergeSpans(data.rows, timeIdx, r => r > 0 && dateSpans[r] !== 0);

  return (
    <div className="flex flex-col gap-2">

    <div className="rounded-lg border border-border overflow-hidden">
      <div className="overflow-auto max-h-[calc(100vh-380px)]">
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-muted">
          <TableRow className="bg-muted/40">
            {data.columns.map((col, i) => (
              <TableHead key={i} className="text-xs font-semibold align-top">{col}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.rows.map((cells, r) => {
            return (
              <TableRow key={r} className="align-top">
                {cells.map((cell, c) => {
                  const span = c === dateIdx ? dateSpans[r] : c === timeIdx ? timeSpans[r] : 1;
                  if (span === 0) return null; // covered by a merged cell above
                  const status = cellStatus(cell, c === statusIdx);
                  const isPics = c === picsIdx;
                  const pics = isPics ? typedRows[r]?.pics ?? [] : [];
                  const merged = (span ?? 1) > 1;
                  return (
                    <TableCell
                      key={c}
                      {...(merged ? { rowSpan: span } : {})}
                      className={merged ? 'align-middle' : 'align-top'}
                    >
                      {status ? (
                        <StatusPill text={status.text} color={status.color} />
                      ) : isPics ? (
                        <span className="text-xs">
                          {pics.map(p => p.split(' ')[0]).join(' / ')}
                        </span>
                      ) : (
                        <div className={`runbook-cell ${RICH}`} onClick={onImg} dangerouslySetInnerHTML={{ __html: cell.html }} />
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      </div>
    </div>
    </div>
  );
}
