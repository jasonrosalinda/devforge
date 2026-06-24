// Parses a Confluence export_view HTML body into a structured runbook table.
// Runs in the renderer (Chromium DOMParser). Images are resolved to their
// base64 data URIs from the attachment list — including images nested inside
// expand macros ("drawers"), which export_view renders inline.

export interface RunbookImage {
  src: string;   // data URI
  name: string;
  orig?: string; // original Confluence image URL (for full-res links)
}

export type StatusColor = 'green' | 'yellow' | 'red' | 'blue' | 'purple' | 'grey';

export interface RunbookCell {
  html: string;        // sanitized Confluence HTML with <img> rewritten to data URIs
  text: string;        // plain-text fallback (status detection)
  images: RunbookImage[];
  status?: { text: string; color: StatusColor }; // Confluence status lozenge, if present
  droppedImages?: number;      // count of <img> that matched no downloaded attachment
  droppedImageKeys?: string[]; // the keys those dropped <img> exposed (for diagnostics)
}

export interface ParsedRunbook {
  columns: string[];
  rows: RunbookCell[][];
}

export interface RunbookSection {
  title: string;
  table: ParsedRunbook;
  typedRows: RunbookRow[];
}

// ── Typed row model ────────────────────────────────────────────────────────────

export interface RunbookRow {
  date: string;
  time: string;
  activity: string;        // plain text (for filtering/search)
  activityHtml: string;    // rich HTML (lozenges, formatting)
  duration: string;
  startTime: string;
  endTime: string;
  status: { text: string; color: StatusColor } | null;
  pics: string[];          // ["King Dimaunahan", "Jose Baleros Jr"]
  logbook: {
    notes: string[];
    images: RunbookImage[];
    html: string;
  };
  extra: Record<string, string>; // any unmapped columns keyed by header name
}

export interface RunbookAttachment {
  filename: string;
  mediaType: string;
  isImage: boolean;
  dataUri: string;
  id?: string | undefined;       // Confluence attachment id (matches data-linked-resource-id)
  fileId?: string | undefined;   // Media file id / UUID (matches data-media-id)
  srcUrl?: string | undefined;   // Full Confluence URL (matches img src attr directly)
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

// Extract heading text, stripping Confluence icon/emoji/status spans that
// render as stray letters ("e", "i", etc.) in export_view textContent.
function headingText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(
    '.confluence-icon, .emoticon, .status-macro, .aui-lozenge, ' +
    'img, [class*="icon"], [class*="emoji"], [class*="emoticon"], ' +
    'ac\\:emoticon, ac\\:image',
  ).forEach(n => n.remove());
  const text = collapse(clone.textContent || '');
  // Strip a leading single lowercase letter immediately before an uppercase
  // letter — icon-font glyphs render as a stray char ("ePre-Prod To Do List").
  return text.replace(/^[a-z](?=[A-Z])/, '').trim();
}

function basename(src: string): string {
  try {
    const path = src.split('?')[0] ?? src;
    return decodeURIComponent(path.substring(path.lastIndexOf('/') + 1));
  } catch {
    return src;
  }
}

// Maps multiple keys (filename, attachment id, media file id) → data URI so an
// <img> can be matched whether Confluence renders it as a classic attachment
// (data-linked-resource-default-alias / -id) or a media node (data-media-id).
// Collects all absolute image URLs from the page HTML (renderer DOMParser).
// These exact URLs are sent to the main process to fetch with auth.
export function collectImageUrls(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const urls = new Set<string>();
  doc.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') || '';
    if (/^https?:\/\//i.test(src)) urls.add(src);
  });
  return Array.from(urls);
}

function buildImageMap(attachments: RunbookAttachment[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const att of attachments) {
    const add = (k: string | undefined) => { if (k) map.set(k.toLowerCase(), att.dataUri); };
    add(att.filename);
    add(att.id);
    add(att.fileId);
    // srcUrl with and without query params — matches the img src attribute directly
    if (att.srcUrl) {
      add(att.srcUrl);
      add(att.srcUrl.split('?')[0]);
    }
  }
  return map;
}

function resolveImg(img: HTMLImageElement, map: Map<string, string>): RunbookImage | null {
  const name =
    img.getAttribute('data-linked-resource-default-alias') ||
    img.getAttribute('data-media-name') ||
    img.getAttribute('alt') ||
    basename(img.getAttribute('src') || '') ||
    'image';

  const rawSrc = img.getAttribute('src') || '';
  const cleanSrc = rawSrc.split('?')[0]; // strip query params → matches srcUrl key

  const candidates = [
    rawSrc,                                               // full URL with query
    cleanSrc,                                             // full URL without query (primary key)
    img.getAttribute('data-media-id'),                    // media node UUID → fileId
    img.getAttribute('data-linked-resource-id'),          // classic attachment id
    img.getAttribute('data-linked-resource-default-alias'),
    img.getAttribute('data-media-name'),
    img.getAttribute('alt'),
    cleanSrc ? basename(cleanSrc) : undefined,             // filename from URL
    basename(img.getAttribute('data-image-src') || ''),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    const hit = map.get(c.toLowerCase());
    if (hit) return { src: hit, name };
  }
  // Fall back to inline data URIs if export_view already embedded them.
  const src = img.getAttribute('src') || '';
  if (src.startsWith('data:')) return { src, name };
  return null;
}

// Block-aware text: insert newlines for <br> and block elements so adjacent
// paragraphs/divs don't concatenate (e.g. "…prdmeduapi" + "USE_MINIFIED…").
// Collapses runs of spaces/tabs but preserves line breaks; drops empty lines.
function blockText(el: Element): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('img, figure').forEach(n => n.remove());
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  clone.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6').forEach(b => b.append('\n'));
  const raw = clone.textContent || '';
  return raw
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Map a Confluence status lozenge to a colour. Confluence encodes it either in
// a data-color attribute (Green/Yellow/Red/Blue/Purple/Grey) or an AUI class
// (aui-lozenge-success/error/current/complete/moved).
function lozengeColor(el: Element): StatusColor {
  const dc = (el.getAttribute('data-color') || '').toLowerCase();
  const cls = (el.getAttribute('class') || '').toLowerCase();
  const hay = `${dc} ${cls}`;
  if (/green|success/.test(hay)) return 'green';
  if (/red|error|remove/.test(hay)) return 'red';
  if (/yellow|moved|inprogress|in-progress/.test(hay)) return 'yellow';
  if (/blue|current|complete|info/.test(hay)) return 'blue';
  if (/purple|new/.test(hay)) return 'purple';
  return 'grey';
}

function detectStatus(el: Element): { text: string; color: StatusColor } | undefined {
  const loz = el.querySelector('.status-macro, .aui-lozenge, [data-macro-name="status"]');
  if (!loz) return undefined;
  const text = collapse(loz.textContent || '');
  if (!text) return undefined;
  return { text, color: lozengeColor(loz) };
}

// Produce the cell's Confluence HTML as-is (preserving bold, lists, nesting,
// expand macros) with <img> rewritten to downloaded data URIs and unsafe
// markup stripped. Unresolved images are removed (avoids broken glyphs).
function cellToRunbookCell(cell: Element, map: Map<string, string>): RunbookCell {
  const status = detectStatus(cell);
  const clone = cell.cloneNode(true) as HTMLElement;

  // Strip dangerous / non-content nodes.
  clone.querySelectorAll('script, style, link, meta, iframe, object, embed, noscript').forEach(n => n.remove());

  // Strip event handlers and javascript: URLs.
  clone.querySelectorAll('*').forEach(el => {
    Array.from(el.attributes).forEach(attr => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    });
  });

  // Rewrite images → data URIs; collect for gallery/lightbox.
  const images: RunbookImage[] = [];
  const droppedKeys: string[] = [];
  clone.querySelectorAll('img').forEach(img => {
    const orig = img.getAttribute('src') || '';
    const resolved = resolveImg(img as HTMLImageElement, map);
    if (resolved) {
      img.setAttribute('src', resolved.src);
      if (/^https?:/i.test(orig)) img.setAttribute('data-orig-src', orig);
      img.removeAttribute('srcset');
      img.removeAttribute('data-image-src');
      img.setAttribute('alt', resolved.name);
      images.push({ ...resolved, orig });
    } else {
      // No attachment matched — record the identifying attributes we tried, so a
      // present-but-unmatched screenshot is visible in diagnostics, not silent.
      const desc = [
        ['src', orig],
        ['media-id', img.getAttribute('data-media-id')],
        ['resource-id', img.getAttribute('data-linked-resource-id')],
        ['alias', img.getAttribute('data-linked-resource-default-alias') || img.getAttribute('data-media-name')],
        ['alt', img.getAttribute('alt')],
      ].filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
      droppedKeys.push(desc || '(no key)');
      img.remove();
    }
  });
  if (droppedKeys.length) {
    console.warn(`[release-pilot] ${droppedKeys.length} image(s) had no matching attachment, dropped:`, droppedKeys);
  }

  // Convert Confluence expand macros → native <details>/<summary>.
  const doc = clone.ownerDocument;
  // Pattern 1: .expand-container (.expand-control + .expand-content)
  clone.querySelectorAll('.expand-container').forEach(exp => {
    const ctrl = exp.querySelector('.expand-control-text, .expand-control');
    const body = exp.querySelector('.expand-content');
    if (!body) return;
    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = ctrl ? collapse(ctrl.textContent || 'Details') : 'Details';
    details.appendChild(summary);
    details.appendChild(body.cloneNode(true));
    exp.replaceWith(details);
  });
  // Pattern 2: data-macro-name="expand" (Cloud storage / newer export)
  clone.querySelectorAll('[data-macro-name="expand"]').forEach(exp => {
    const title = exp.querySelector('[data-macro-parameter="title"], .title');
    const body = exp.querySelector('.conf-macro-body, .wysiwyg-macro-body, .expand-content');
    if (!body) return;
    const details = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = title ? collapse(title.textContent || 'Details') : 'Details';
    details.appendChild(summary);
    details.appendChild(body.cloneNode(true));
    exp.replaceWith(details);
  });

  // External links open in the browser.
  clone.querySelectorAll('a[href]').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  return {
    html: clone.innerHTML,
    text: collapse(clone.textContent || ''),
    images,
    ...(status ? { status } : {}),
    ...(droppedKeys.length ? { droppedImages: droppedKeys.length, droppedImageKeys: droppedKeys } : {}),
  };
}

// Drop "rollback confirmation" rows. Matched across the whole row (not just the
// activity column) because merged cells can shift the text out of that column.
const ROLLBACK_ROW = /rollback\s*confirmation/i;

// Direct th/td children of a row (ignores cells from any nested table).
function directCells(tr: Element): Element[] {
  return Array.from(tr.children).filter(c => c.tagName === 'TD' || c.tagName === 'TH');
}

function spanOf(cell: Element, attr: 'colspan' | 'rowspan'): number {
  const v = parseInt(cell.getAttribute(attr) || '1', 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// Normalize an HTML table with merged cells (colspan/rowspan) into a dense,
// rectangular matrix so every logical column lines up. A slot covered by a
// span continuation is `null` (rendered as an empty cell). Without this, a
// single merged cell shifts every column to its right.
function tableMatrix(rows: Element[]): (Element | null)[][] {
  const matrix: (Element | null)[][] = [];
  rows.forEach((tr, r) => {
    if (!matrix[r]) matrix[r] = [];
    let c = 0;
    for (const cell of directCells(tr)) {
      while (matrix[r]![c] !== undefined) c++; // skip slots claimed by spans above/left
      const cs = spanOf(cell, 'colspan');
      const rs = spanOf(cell, 'rowspan');
      for (let i = 0; i < rs; i++) {
        const rr = r + i;
        if (!matrix[rr]) matrix[rr] = [];
        for (let j = 0; j < cs; j++) {
          matrix[rr]![c + j] = i === 0 && j === 0 ? cell : null;
        }
      }
      c += cs;
    }
  });
  // Pad every row to the widest so columns and body rows share one width.
  const width = matrix.reduce((m, row) => Math.max(m, row.length), 0);
  for (const row of matrix) for (let c = 0; c < width; c++) if (row[c] === undefined) row[c] = null;
  return matrix;
}

const emptyCell = (): RunbookCell => ({ html: '', text: '', images: [] });

function parseTable(table: HTMLTableElement, map: Map<string, string>): ParsedRunbook {
  // Only this table's own rows (exclude rows belonging to a nested table).
  const ownRows = Array.from(table.querySelectorAll('tr')).filter(tr => tr.closest('table') === table);
  if (ownRows.length === 0) return { columns: [], rows: [] };

  // Header: explicit thead, else the first row.
  const thead = table.querySelector('thead');
  let headerRow: Element;
  let bodyRows: Element[];
  if (thead && thead.querySelector('tr')) {
    headerRow = thead.querySelector('tr') as Element;
    bodyRows = ownRows.filter(r => !thead.contains(r));
  } else {
    headerRow = ownRows[0]!;
    bodyRows = ownRows.slice(1);
  }

  // Build one matrix over header + body so widths align and spans resolve.
  const matrix = tableMatrix([headerRow, ...bodyRows]);
  const columns = (matrix[0] || []).map(el => (el ? collapse(el.textContent || '') : ''));

  const rows = matrix.slice(1)
    .map(row => row.map(el => (el ? cellToRunbookCell(el, map) : emptyCell())))
    .filter(cells => !cells.some(c => ROLLBACK_ROW.test(c.text)));

  return { columns, rows };
}

// ── Column key mapping ────────────────────────────────────────────────────────

type ColKey = 'date' | 'time' | 'activity' | 'duration' | 'startTime' | 'endTime' | 'status' | 'pics' | 'logbook' | 'extra';

function colKey(header: string): ColKey {
  const h = header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (/^date/.test(h)) return 'date';
  // "start time" before plain "time"
  if (/start\s*time/.test(h)) return 'startTime';
  if (/end\s*time/.test(h)) return 'endTime';
  if (/^time/.test(h)) return 'time';
  if (/activity/.test(h)) return 'activity';
  if (/duration/.test(h)) return 'duration';
  if (/status/.test(h)) return 'status';
  if (/pic|person|owner|assignee/.test(h)) return 'pics';
  if (/logbook|screenshot|monitoring|log\b/.test(h)) return 'logbook';
  return 'extra';
}

function parsePics(text: string): string[] {
  return text
    .split(/[/,|]/)
    .map(p => p.replace(/^@/, '').trim())
    .filter(Boolean);
}

function mapToRows(table: ParsedRunbook): RunbookRow[] {
  const keyMap = table.columns.map(colKey);
  return table.rows.map(cells => {
    const row: RunbookRow = {
      date: '', time: '', activity: '', activityHtml: '',
      duration: '', startTime: '', endTime: '',
      status: null, pics: [],
      logbook: { notes: [], images: [], html: '' },
      extra: {},
    };
    cells.forEach((cell, i) => {
      const key = keyMap[i] ?? 'extra';
      switch (key) {
        case 'date':      row.date = cell.text; break;
        case 'time':      row.time = cell.text; break;
        case 'activity':  row.activity = cell.text; row.activityHtml = cell.html; break;
        case 'duration':  row.duration = cell.text; break;
        case 'startTime': row.startTime = cell.text; break;
        case 'endTime':   row.endTime = cell.text; break;
        case 'status':
          row.status = cell.status ?? (cell.text ? { text: cell.text, color: 'grey' as StatusColor } : null);
          break;
        case 'pics':      row.pics = parsePics(cell.text); break;
        case 'logbook':
          row.logbook = {
            notes: cell.text.split('\n').map(l => l.trim()).filter(Boolean),
            images: cell.images,
            html: cell.html,
          };
          break;
        default: {
          const col = table.columns[i] ?? `col${i}`;
          row.extra[col] = cell.text;
        }
      }
    });
    return row;
  });
}

// Default: skip any section whose heading mentions "rollback".
const DEFAULT_EXCLUDE = /rollback/i;

// Walks the page in document order, pairing each heading (h1–h4) with the
// table(s) that follow it, so a runbook with "Pre-Prod To Do List" /
// "Post-Prod To Do List" renders as separate labelled sections.
export function parseRunbookSections(
  html: string,
  attachments: RunbookAttachment[],
  excludePattern: RegExp = DEFAULT_EXCLUDE,
): RunbookSection[] {
  const map = buildImageMap(attachments);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.querySelectorAll('h1, h2, h3, h4, table'));

  const sections: RunbookSection[] = [];
  let currentTitle = '';

  for (const el of nodes) {
    if (el.tagName.toLowerCase() !== 'table') {
      currentTitle = headingText(el);
      continue;
    }
    // Skip tables nested inside another table cell.
    if (el.parentElement?.closest('table')) continue;
    // Skip excluded sections (e.g. Rollback plan).
    if (currentTitle && excludePattern.test(currentTitle)) continue;

    const table = parseTable(el as HTMLTableElement, map);
    if (table.rows.length === 0) continue;

    sections.push({ title: currentTitle || 'Runbook', table, typedRows: mapToRows(table) });
  }

  return sections;
}

// Extracts the release label from the plan's "High-level Schedule" section,
// e.g. "MEDU v6.21.1 - Hotfix Release" (a link/cell under the heading).
export function extractReleaseLabel(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, a, td, th, p'));
  let after = false;
  let fallback = '';
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    const text = collapse(el.textContent || '');
    if (/^h[1-6]$/.test(tag)) {
      if (after) break;                       // next heading ends the section
      if (/schedule/i.test(text)) after = true;
      continue;
    }
    if (!after || !text) continue;
    if (tag === 'a') return text;             // prefer the link text
    if (!fallback) fallback = text;           // else first cell/paragraph
  }
  return fallback;
}

// Extracts the PROD Deployment date/time from the plan's High-level Schedule
// table. Prefers the "Actual Schedule" column; falls back to "Original Schedule".
// Returns raw strings (caller normalizes), e.g. { date: "Jun 2, 2026", time: "5:00 PM" }.
export function extractProdSchedule(html: string): { date: string; time: string } {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) continue;
    const headers = Array.from((rows[0] as Element).querySelectorAll('th, td'))
      .map(c => collapse(c.textContent || ''));
    const origIdx = headers.findIndex(h => /original/i.test(h));
    const actualIdx = headers.findIndex(h => /actual/i.test(h));
    if (origIdx < 0 && actualIdx < 0) continue; // not the schedule table

    const prodRow = rows.slice(1).find(tr => {
      const first = Array.from(tr.querySelectorAll('th, td'))[0];
      return first && /prod.*deploy/i.test(collapse(first.textContent || ''));
    });
    if (!prodRow) continue;

    const cells = Array.from(prodRow.querySelectorAll('th, td'));
    const cellAt = (i: number) => (i >= 0 && cells[i] ? collapse(cells[i]!.textContent || '') : '');
    const actual = cellAt(actualIdx);
    const original = cellAt(origIdx);
    const chosen = (actual && !/^n\/?a$/i.test(actual)) ? actual : original;

    const dateMatch = chosen.match(/[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/);
    const timeMatch = chosen.match(/\d{1,2}:\d{2}\s*[AP]M/i);
    return { date: dateMatch ? dateMatch[0] : '', time: timeMatch ? timeMatch[0] : '' };
  }

  return { date: '', time: '' };
}

// Pull text items from a table cell (bullets if present, else the cell text).
function cellLines(cell: Element): string[] {
  const lis = Array.from(cell.querySelectorAll('li'))
    .map(li => collapse(li.textContent || ''))
    .filter(Boolean);
  if (lis.length) return lis;
  const t = collapse(cell.textContent || '');
  return t ? [t] : [];
}

// Extracts release goals from the plan page. Primary: a table with a "Goals"
// column → that column's cells. Fallback: a "Goals"/"Objectives" heading
// followed by list items / paragraphs (until the next heading).
// Matches the headings/columns teams use for the release goals — "Goals",
// "Objectives", and "What to Expect[ in This Release]" / "Highlights" / "Scope".
const GOALS_LABEL_RE = /goal|objective|what'?s?\s*(to\s*expect|new)|expect|highlight|scope/i;

export function extractGoals(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Primary — goals table column.
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const allRows = Array.from(table.querySelectorAll('tr'));
    if (!allRows.length) continue;
    const headerCells = Array.from((allRows[0] as Element).querySelectorAll('th, td'));
    const goalIdx = headerCells.findIndex(c => GOALS_LABEL_RE.test(collapse(c.textContent || '')));
    if (goalIdx < 0) continue;

    const goals: string[] = [];
    for (const tr of allRows.slice(1)) {
      const cell = Array.from(tr.querySelectorAll('th, td'))[goalIdx];
      if (cell) goals.push(...cellLines(cell));
    }
    if (goals.length) return goals;
  }

  // Fallback — goals heading ("What to Expect…", "Goals", …) + following list/paragraphs.
  const nodes = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, ul, ol, p'));
  const goals: string[] = [];
  let capturing = false;
  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (capturing) break;
      if (GOALS_LABEL_RE.test(collapse(el.textContent || ''))) capturing = true;
      continue;
    }
    if (!capturing) continue;
    if (tag === 'ul' || tag === 'ol') {
      el.querySelectorAll('li').forEach(li => {
        const t = collapse(li.textContent || '');
        if (t) goals.push(t);
      });
    } else {
      const t = collapse(el.textContent || '');
      if (t) goals.push(t);
    }
  }
  return goals;
}
