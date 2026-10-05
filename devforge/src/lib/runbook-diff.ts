// What a save will change, for the review dialog: rows added / removed, and
// each changed cell as readable text. Rows are matched by their editor key, so
// moving or inserting rows doesn't show every row below as "changed". A value
// merged from the row above is reported once, on the row that holds it.

import { colIndex, effectiveCell, type EditDoc, type EditSection } from '@/lib/runbook-model';
import { cellText } from '@/lib/runbook-storage';
import { cellDate } from '@/lib/runbook-schedule';

export interface RunbookChange {
  section: string;
  kind: 'added' | 'removed' | 'changed';
  row: number;          // 1-based, in the saved table (removed: in the original)
  activity: string;
  column?: string;
  before?: string;
  after?: string;
}

function shown(section: EditSection, r: number, c: number): string {
  const inner = effectiveCell(section, r, c).inner;
  return section.columns[c]!.kind === 'date' ? (cellDate(inner) ?? cellText(inner)) : cellText(inner);
}

function contentNote(before: string, after: string): string {
  const shots = (xml: string) => (xml.match(/<ac:image\b/g) ?? []).length;
  const d = shots(after) - shots(before);
  if (d) return `(${d > 0 ? '+' : '−'}${Math.abs(d)} screenshot${Math.abs(d) === 1 ? '' : 's'})`;
  return '(links or formatting changed)';
}

const activityOf = (section: EditSection, r: number) => {
  const c = colIndex(section, 'activity');
  return c >= 0 ? shown(section, r, c) : '';
};

export function diffRunbook(before: EditDoc, after: EditDoc): RunbookChange[] {
  const out: RunbookChange[] = [];
  after.sections.forEach((sec, s) => {
    const old = before.sections[s];
    if (!old) return;
    const oldIndex = new Map(old.rows.map((row, i) => [row.key, i]));
    const kept = new Set<string>();

    sec.rows.forEach((row, r) => {
      const o = oldIndex.get(row.key);
      if (o === undefined) {
        out.push({ section: sec.heading, kind: 'added', row: r + 1, activity: activityOf(sec, r) });
        return;
      }
      kept.add(row.key);
      sec.columns.forEach((col, c) => {
        if (row.cells[c]!.sameAsAbove && old.rows[o]!.cells[c]!.sameAsAbove) return;
        const was = shown(old, o, c);
        const now = shown(sec, r, c);
        if (was !== now) {
          out.push({ section: sec.heading, kind: 'changed', row: r + 1, activity: activityOf(sec, r), column: col.label, before: was, after: now });
          return;
        }
        // Same text, different content: screenshots, links or formatting changed.
        const oldInner = effectiveCell(old, o, c).inner;
        const newInner = effectiveCell(sec, r, c).inner;
        if (oldInner !== newInner) {
          out.push({ section: sec.heading, kind: 'changed', row: r + 1, activity: activityOf(sec, r), column: col.label, before: was, after: `${now} ${contentNote(oldInner, newInner)}` });
        }
      });
    });

    old.rows.forEach((row, o) => {
      if (!kept.has(row.key)) out.push({ section: old.heading, kind: 'removed', row: o + 1, activity: activityOf(old, o) });
    });
  });
  return out;
}
