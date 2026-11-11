// The investigation's "Evidences" bullets as numbered marks on the App Health Check charts:
// a bullet that names a moment ("**20:00–20:15 SGT · API:** …") gets a number, and the same
// number is drawn on every chart at that time — the charts become the picture of the list.
// The values on the charts are the telemetry; only the times come from the report, and a
// time outside the window is not drawn.

export interface EvidenceMarker {
  n: number;
  atMs: number;
  /** End of a range ("20:00–20:15"); absent for a single moment. */
  endMs?: number | undefined;
  label: string;
}

/** The section heading; "Azure Evidence" is what reports saved before the rename use. */
export const EVIDENCE_HEADING = /^## (?:Evidences|Azure Evidence)[ \t]*$/m;

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
export const circled = (n: number): string => (n >= 1 && n <= 20 ? CIRCLED[n - 1]! : `(${n})`);

const SGT_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;
// A bullet opening with its time, bold or not: "- **20:00–20:15 SGT · API:** …", "- 19:03 SGT: …".
const TIMED = /^- (\*\*)?(\d{1,2}):(\d{2})(?:\s*[–-]\s*(\d{1,2}):(\d{2}))?\s*SGT\b/;

export interface EvidenceImage { src: string; alt: string }

/**
 * The findings with the chart pictures, one per chart, right under the Evidences heading and
 * after an optional caption line (for the exports); unchanged without any. Pure.
 */
export function withEvidenceImages(markdown: string, images: EvidenceImage[], caption = ''): string {
  const head = images.length ? EVIDENCE_HEADING.exec(markdown) : null;
  if (!head) return markdown;
  const cut = head.index + head[0].length;
  const block = [
    ...(caption.trim() ? [`_${caption.trim()}_`] : []),
    ...images.map(i => `![${i.alt.replace(/[[\]\n]/g, ' ')}](${i.src})`),
  ].join('\n\n');
  return `${markdown.slice(0, cut)}\n\n${block}\n${markdown.slice(cut)}`;
}

/** "20:00" SGT on whichever day puts it inside the window (a window can cross midnight). Pure. */
function clockToMs(h: number, m: number, window: { startMs: number; endMs: number }): number | null {
  if (h > 23 || m > 59) return null;
  const startDay = Math.floor((window.startMs + SGT_MS) / DAY_MS) * DAY_MS - SGT_MS;
  for (let d = 0; startDay + d * DAY_MS <= window.endMs; d++) {
    const ms = startDay + d * DAY_MS + (h * 60 + m) * 60_000;
    if (ms >= window.startMs && ms <= window.endMs) return ms;
  }
  return null;
}

/** First words of a bullet, without its time and markdown, for a chart tooltip. Pure. */
function labelOf(line: string): string {
  return line.replace(TIMED, '').replace(/\*\*|`/g, '').replace(/^[\s·:–-]+/, '').trim().slice(0, 80);
}

/**
 * The findings with each timed Evidences bullet numbered, and the markers to draw. Pure.
 * Only the Evidences section is touched; bullets without a time keep no number.
 */
export function numberEvidence(markdown: string, window: { startMs: number; endMs: number }): { markdown: string; markers: EvidenceMarker[] } {
  const head = EVIDENCE_HEADING.exec(markdown);
  if (!head) return { markdown, markers: [] };
  const from = head.index + head[0].length;
  const next = markdown.slice(from).search(/^#{1,2} /m);
  const to = next < 0 ? markdown.length : from + next;
  const markers: EvidenceMarker[] = [];
  const section = markdown.slice(from, to).split('\n').map(line => {
    const m = TIMED.exec(line);
    if (!m) return line;
    const atMs = clockToMs(Number(m[2]), Number(m[3]), window);
    if (atMs == null) return line;
    let endMs = m[4] != null ? clockToMs(Number(m[4]), Number(m[5]), window) : null;
    if (endMs != null && endMs < atMs) endMs = null;
    const n = markers.length + 1;
    markers.push({ n, atMs, ...(endMs != null && endMs > atMs ? { endMs } : {}), label: labelOf(line) });
    return `- ${circled(n)} ${line.slice(2)}`;
  }).join('\n');
  return { markdown: markdown.slice(0, from) + section + markdown.slice(to), markers };
}
