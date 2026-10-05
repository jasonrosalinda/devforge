// Runbook time rules for the editor:
//   Planned Start = Time (SGT)
//   Planned End   = Planned Start + Duration
// and "shift": move the whole runbook to a new deployment start by one offset,
// so gaps between activities and parallel activities stay as planned.
//
// Times are SGT wall-clock throughout (no DST), held as minutes since
// 1970-01-01 00:00 of that wall clock, so no time-zone conversion is involved.

import {
  colIndex, effectiveCell, ownerRow, stripIds, type EditDoc, type EditSection,
} from '@/lib/runbook-model';
import { cellText, replaceFirstTime } from '@/lib/runbook-storage';

const DAY = 1440;
const TIME_RE = /\b(1[0-2]|0?[1-9]):([0-5]\d)\s*([AaPp][Mm])\b/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Minutes of the day for the first "h:mm AM/PM" in the text, or null. */
export function parseTimeLabel(text: string): number | null {
  const m = text.match(TIME_RE);
  if (!m) return null;
  const h = parseInt(m[1]!, 10) % 12 + (m[3]!.toUpperCase() === 'PM' ? 12 : 0);
  return h * 60 + parseInt(m[2]!, 10);
}

export function formatTimeLabel(minutes: number): string {
  const m = ((Math.round(minutes) % DAY) + DAY) % DAY;
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Minutes in a duration label: "< 5m", "2h", "1h 30m", "1.5h", "45 mins". */
export function parseDuration(label: string): number | null {
  const t = label.toLowerCase();
  const h = t.match(/(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\b/);
  const m = t.match(/(\d+)\s*m(?:in(?:ute)?s?)?\b/);
  if (!h && !m) return null;
  return Math.round((h ? parseFloat(h[1]!) * 60 : 0) + (m ? parseInt(m[1]!, 10) : 0));
}

const ymdToDay = (ymd: string) => {
  const [y, mo, d] = ymd.split('-').map(Number);
  return Date.UTC(y!, mo! - 1, d!) / 86_400_000;
};
const dayToYmd = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

export function cellDate(inner: string): string | null {
  return inner.match(/<time\b[^>]*\bdatetime="(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
}

export function setCellDate(inner: string, ymd: string): string {
  if (/<time\b[^>]*\bdatetime="/.test(inner)) return inner.replace(/(<time\b[^>]*\bdatetime=")[^"]*/, `$1${ymd}`);
  return `<p><time datetime="${ymd}" /></p>`;
}

export interface RowTimes {
  date: string | null;     // day the activity starts
  startAbs: number | null; // wall-clock minutes since epoch
  endAbs: number | null;
  startLabel: string | null;
  endLabel: string | null;
  endsNextDay: boolean;
  duration: number | null;
  issues: string[];
}

/** Start / end of every row. A row whose Date is merged from above and whose
 *  time runs backwards by more than 12h is taken as the next day. */
export function rowSchedule(section: EditSection): RowTimes[] {
  const dateCol = colIndex(section, 'date');
  const timeCol = colIndex(section, 'time');
  const durCol = colIndex(section, 'duration');
  let prev: number | null = null;
  return section.rows.map((row, r) => {
    const issues: string[] = [];
    const ymd = dateCol >= 0 ? cellDate(effectiveCell(section, r, dateCol).inner) : null;
    const tod = timeCol >= 0 ? parseTimeLabel(cellText(effectiveCell(section, r, timeCol).inner)) : null;
    const durText = durCol >= 0 ? cellText(effectiveCell(section, r, durCol).inner) : '';
    const duration = parseDuration(durText);
    if (durText && duration === null) issues.push(`Duration "${durText}" is not a time span (use e.g. 15m, 2h, 1h 30m).`);

    let startAbs: number | null = null;
    if (ymd && tod !== null) {
      startAbs = ymdToDay(ymd) * DAY + tod;
      const dateInherited = dateCol >= 0 && row.cells[dateCol]!.sameAsAbove;
      while (dateInherited && prev !== null && startAbs < prev - DAY / 2) startAbs += DAY;
      prev = startAbs;
    }
    const endAbs = startAbs !== null && duration !== null ? startAbs + duration : null;
    return {
      date: startAbs !== null ? dayToYmd(Math.floor(startAbs / DAY)) : ymd,
      startAbs,
      endAbs,
      startLabel: startAbs !== null ? formatTimeLabel(startAbs) : null,
      endLabel: endAbs !== null ? formatTimeLabel(endAbs) : null,
      endsNextDay: startAbs !== null && endAbs !== null && Math.floor(endAbs / DAY) > Math.floor(startAbs / DAY),
      duration,
      issues,
    };
  });
}

export interface ScheduleChange {
  section: string;
  row: number;
  column: string;
  before: string;
  after: string;
}

const cloneDoc = (doc: EditDoc): EditDoc => structuredClone(doc);

// Writes `label` as the time in row r / column c, splitting the cell off a merge if needed.
function writeTime(section: EditSection, r: number, c: number, label: string) {
  const cell = section.rows[r]!.cells[c]!;
  if (cell.sameAsAbove) {
    const src = effectiveCell(section, r, c);
    section.rows[r]!.cells[c] = { tag: src.tag, open: src.open ? stripIds(src.open) : null, inner: stripIds(src.inner), sameAsAbove: false };
  }
  const own = section.rows[r]!.cells[c]!;
  own.inner = replaceFirstTime(own.inner, label);
}

/** Recomputes Planned Start (= Time) and Planned End (= Start + Duration) on every row. */
export function applySchedule(doc: EditDoc): { doc: EditDoc; changes: ScheduleChange[] } {
  const out = cloneDoc(doc);
  const changes: ScheduleChange[] = [];
  for (const section of out.sections) {
    if (!section.editable) continue;
    const times = rowSchedule(section);
    const targets = [
      { c: colIndex(section, 'startTime'), value: (t: RowTimes) => t.startAbs },
      { c: colIndex(section, 'endTime'), value: (t: RowTimes) => t.endAbs },
    ];
    times.forEach((t, r) => {
      for (const { c, value } of targets) {
        const abs = value(t);
        if (c < 0 || abs === null) continue;
        const before = cellText(effectiveCell(section, r, c).inner);
        if (parseTimeLabel(before) === ((abs % DAY) + DAY) % DAY) continue;
        const after = formatTimeLabel(abs);
        writeTime(section, r, c, after);
        changes.push({ section: section.heading, row: r, column: section.columns[c]!.label, before, after });
      }
    });
  }
  return { doc: out, changes };
}

export interface Anchor {
  section: number;
  row: number;
}

const toLocalIso = (abs: number) => `${dayToYmd(Math.floor(abs / DAY))}T${String(Math.floor((abs % DAY) / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;

/** The deployment start: the first timed activity of the "Prod" section (else of the page). */
export function defaultAnchor(doc: EditDoc): (Anchor & { at: string }) | null {
  const order = [
    ...doc.sections.map((s, i) => ({ s, i })).filter(({ s }) => /^prod\b/i.test(s.heading)),
    ...doc.sections.map((s, i) => ({ s, i })),
  ];
  for (const { s, i } of order) {
    const r = rowSchedule(s).findIndex(t => t.startAbs !== null);
    if (r >= 0) return { section: i, row: r, at: toLocalIso(rowSchedule(s)[r]!.startAbs!) };
  }
  return null;
}

const DRAWER_TIME_RE = /(<ac:parameter ac:name="title">\s*)((?:1[0-2]|0?[1-9]):[0-5]\d\s*[AaPp][Mm])(\s*<\/ac:parameter>)/g;

/** Moves every drawer title that is a time ("6:15 PM") by `delta` minutes; other titles stay. */
export function shiftDrawerTimes(inner: string, delta: number): string {
  if (!delta) return inner;
  return inner.replace(DRAWER_TIME_RE, (_m, a: string, time: string, b: string) => a + formatTimeLabel(parseTimeLabel(time)! + delta) + b);
}

/**
 * Sets row r's Time to `label` and moves the logbook check times (drawer
 * titles) of every row that shows that time — the row and the rows merged
 * under it — by the same amount, so 6:00 / 6:15 / 6:30 become 5:00 / 5:15 / 5:30.
 */
export function retimeRow(section: EditSection, r: number, label: string): EditSection {
  const timeCol = colIndex(section, 'time');
  const logCol = colIndex(section, 'logbook');
  if (timeCol < 0) return section;
  const out: EditSection = structuredClone(section);
  const owner = ownerRow(out, r, timeCol);
  const cell = out.rows[owner]!.cells[timeCol]!;
  const before = parseTimeLabel(cellText(cell.inner));
  cell.inner = replaceFirstTime(cell.inner, label);
  const after = parseTimeLabel(label);
  if (before === null || after === null || logCol < 0) return out;

  const delta = after - before;
  for (let i = owner; i < out.rows.length && (i === owner || out.rows[i]!.cells[timeCol]!.sameAsAbove); i++) {
    const log = out.rows[i]!.cells[logCol]!;
    if (!log.sameAsAbove) log.inner = shiftDrawerTimes(log.inner, delta);
  }
  return out;
}

/**
 * Moves the runbook so the anchor activity starts at `newStart` ('YYYY-MM-DDTHH:mm'):
 * every Date, Time and logbook check-time drawer shifts by the same offset, and
 * Planned Start / End are recomputed. Rows pushed past midnight get their own
 * date. Target-based: re-applying to the shifted page changes nothing.
 */
export function shiftRunbook(doc: EditDoc, anchor: Anchor, newStart: string): EditDoc {
  const anchorAbs = rowSchedule(doc.sections[anchor.section]!)[anchor.row]?.startAbs;
  const [ymd, hm] = newStart.split('T');
  const [hh, mm] = (hm ?? '').split(':').map(Number);
  if (anchorAbs === null || anchorAbs === undefined || !ymd || hh === undefined || mm === undefined) return doc;
  const delta = ymdToDay(ymd) * DAY + hh * 60 + mm - anchorAbs;
  if (delta === 0) return applySchedule(doc).doc;

  const out = cloneDoc(doc);
  for (const section of out.sections) {
    if (!section.editable) continue;
    const times = rowSchedule(section);
    const dateCol = colIndex(section, 'date');
    const timeCol = colIndex(section, 'time');
    const logCol = colIndex(section, 'logbook');
    let shownDate: string | null = null;

    section.rows.forEach((row, r) => {
      const t = times[r]!;
      const newAbs = t.startAbs !== null ? t.startAbs + delta : null;

      if (timeCol >= 0 && newAbs !== null && !row.cells[timeCol]!.sameAsAbove) {
        row.cells[timeCol]!.inner = replaceFirstTime(row.cells[timeCol]!.inner, formatTimeLabel(newAbs));
      }

      if (dateCol >= 0) {
        const oldDay = t.date ? ymdToDay(t.date) : null;
        const newDate = newAbs !== null
          ? dayToYmd(Math.floor(newAbs / DAY))
          : oldDay !== null ? dayToYmd(Math.floor((oldDay * DAY + delta) / DAY)) : null;
        const cell = row.cells[dateCol]!;
        if (newDate && !cell.sameAsAbove) {
          cell.inner = setCellDate(cell.inner, newDate);
        } else if (newDate && cell.sameAsAbove && r > 0 && newDate !== shownDate) {
          // The block's date no longer holds for this row: give it its own.
          row.cells[dateCol] = { tag: 'td', open: null, inner: setCellDate('', newDate), sameAsAbove: false };
        }
        shownDate = newDate ?? shownDate;
      }

      if (logCol >= 0 && !row.cells[logCol]!.sameAsAbove) {
        row.cells[logCol]!.inner = shiftDrawerTimes(row.cells[logCol]!.inner, delta);
      }
    });
  }
  return applySchedule(out).doc;
}

/** "26 Oct 2026 MSP V3.16.0 Deployment Runbook" → same title with `ymd`'s date. */
export function shiftTitleDate(title: string, ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return title.replace(
    /^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}/i,
    `${d} ${MONTHS[m! - 1]} ${y}`,
  );
}

/** '6:03 PM' → '18:03' for <input type="time">; '' when the text has no time. */
export function labelToInputTime(text: string): string {
  const m = parseTimeLabel(text);
  return m === null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** '18:03' → '6:03 PM'; null for an empty input. */
export function inputTimeToLabel(value: string): string | null {
  const m = value.match(/^(\d{1,2}):(\d{2})/);
  return m ? formatTimeLabel(parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10)) : null;
}
