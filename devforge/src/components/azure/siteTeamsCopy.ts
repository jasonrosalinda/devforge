/** Copy for Teams helpers: one site's (Frontend or API) copy, and the status-row colours. */
import { PERF_COLORS } from '@/lib/chart-colors';

// The status colours Teams keeps on paste: the Performance legend's green, orange and red.
type Cell = string | undefined;
const OK = PERF_COLORS.ok, WARN = PERF_COLORS.fourXx, BAD = PERF_COLORS.fiveXx;

/** Instances row (running, stopped, total): red when nothing runs or every instance is stopped. */
export const instanceColors = (running: number, stopped: number, total: number): [Cell, Cell, Cell] =>
  [running === 0 ? BAD : undefined, stopped === total ? BAD : undefined, undefined];

/** SNAT row (pending, failed, peak): pending ports orange, failed connections red. */
export const snatColors = (pending: number | null, failed: number | null): [Cell, Cell, Cell] =>
  [(pending ?? 0) > 0 ? WARN : undefined, (failed ?? 0) > 0 ? BAD : undefined, undefined];

/** UptimeRobot row (—, incidents, uptime): any incident red, a full 100% green. */
export const uptimeColors = (incidents: number, uptimePct: number | null): [Cell, Cell, Cell] =>
  [undefined, incidents > 0 ? BAD : undefined, uptimePct === 100 ? OK : undefined];

export interface SiteCopyRow { name: string; value: string; color?: string | undefined }
export interface SiteCopySection { section: string; rows: SiteCopyRow[] }

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CELL = 'padding:4px 10px;';

/** HTML for Teams and the same content as plain text. Pure. */
export function buildSiteTeamsCopy({ title, imageUrl, sections }: {
  title: string;
  /** The site's chart as a PNG data URL, or null when it could not be captured. */
  imageUrl: string | null;
  sections: SiteCopySection[];
}): { html: string; text: string } {
  const filled = sections.filter(s => s.rows.length);
  const html =
    `<div style="font-family:sans-serif;font-size:13px;">` +
    `<p style="font-weight:700;font-size:14px;margin:0;">${escapeHtml(title)}</p>` +
    // Outside the table: an image inside a cell trips Teams' "paste limit exceeded".
    (imageUrl ? `<p style="margin:0;"><img src="${imageUrl}" style="display:block;"/></p>` : '') +
    `<table border="1" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px;">` +
    filled.map(s =>
      `<tr><td colspan="2" style="${CELL}"><b>${escapeHtml(s.section)}</b></td></tr>` +
      s.rows.map(r =>
        `<tr><td style="${CELL}">${escapeHtml(r.name)}</td>` +
        `<td style="${CELL}${r.color ? `color:${r.color};` : ''}">${escapeHtml(r.value)}</td></tr>`,
      ).join(''),
    ).join('') +
    `</table></div>`;
  const text = [
    title,
    ...filled.flatMap(s => ['', s.section, ...s.rows.map(r => `${r.name} | ${r.value}`)]),
  ].join('\n');
  return { html, text };
}
