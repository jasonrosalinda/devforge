// App Service Diagnostics — the generic detector plumbing.
//
// "Diagnose and solve problems" is a plain ARM REST surface:
//
//   GET {siteResId}/detectors?api-version=2022-03-01              → list
//   GET {siteResId}/detectors/{name}?startTime=&endTime=&…        → datasets
//
// Detector ids and dataset titles are not contractual, so nothing here hardcodes
// an id: a detector is discovered by keyword and its charts are matched by title
// with a substring fallback. When nothing matches the caller gets null, which for
// most of these means "not published for this site" rather than an error.
//
// SNAT ports (azure-snat.cjs) and restart events (azure-restarts.cjs) are both
// this shape, which is why the shape lives here rather than in either of them.

const API_VERSION = '2022-03-01';

/** Keeps title matching insensitive to case, punctuation and double spaces, which
 *  have all drifted between detector revisions. */
function normalizeTitle(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Picks a detector out of a list response by keyword. Pure.
 *
 * `keywords` is ordered strongest-first: a detector actually named for the thing
 * beats one whose description merely mentions it.
 */
function findDetector(list, keywords) {
  const items = Array.isArray(list) ? list : (list?.value ?? []);
  const named = items.map(d => ({
    name: d?.name ?? d?.properties?.metadata?.id ?? null,
    hay: normalizeTitle([
      d?.name,
      d?.properties?.metadata?.id,
      d?.properties?.metadata?.name,
      d?.properties?.metadata?.description,
    ].filter(Boolean).join(' ')),
  })).filter(d => d.name);

  for (const kw of keywords) {
    const hit = named.find(d => d.hay.includes(normalizeTitle(kw)));
    if (hit) return hit.name;
  }
  return null;
}

/** Locates the timestamp, value and label columns by name and dataType rather than
 *  by position — detector tables reorder between revisions. */
function columnIndexes(columns) {
  const cols = (columns ?? []).map((c, i) => ({
    i,
    name: String(c?.columnName ?? ''),
    type: String(c?.dataType ?? '').toLowerCase(),
  }));
  const time = cols.find(c => c.type.includes('datetime'))
            ?? cols.find(c => /time|date/i.test(c.name));
  const value = cols.find(c => /^(value|count|total)$/i.test(c.name) && c.i !== time?.i)
             ?? cols.find(c => /(double|int|long|decimal|single|float)/.test(c.type) && c.i !== time?.i);
  const labels = cols.filter(c => c.i !== time?.i && c.i !== value?.i);
  return { time, value, labels };
}

/**
 * Turns a detector payload into `{ detector, charts, grainMs }`. Pure — exported
 * so the column probing can be tested without an Azure round trip.
 *
 * `opts.titles` pins the charts to a known set, in that order, and keeps a slot for
 * every one even when the detector omitted it — a counter that never fired is an
 * answer, and dropping its panel would leave the reader unsure it was checked.
 * `opts.titleMatch` instead keeps whatever matches, for detectors whose chart set
 * is not known in advance.
 *
 * Each chart is `{ title, series: [{ name, series: [{ t, count }] }] }`, the shape
 * EndpointSeriesChart / mergeUrlSeries already consume.
 */
function parseDetectorCharts(payload, detectorName, opts = {}) {
  const { titles = null, titleMatch = null, maxSeries = 12 } = opts;
  const datasets = payload?.properties?.dataset ?? payload?.dataset ?? [];
  if (!Array.isArray(datasets) || !datasets.length) return null;

  const wanted = titles ? titles.map(normalizeTitle) : null;
  const charts = [];

  for (const ds of datasets) {
    const rawTitle = ds?.renderingProperties?.title ?? ds?.table?.tableName ?? '';
    const norm = normalizeTitle(rawTitle);

    let title = rawTitle;
    if (wanted) {
      // Exact title first, then substring both ways, so "SNAT port usage" and
      // "SNAT port usage for TCP protocol (per instance)" land on the same slot.
      let idx = wanted.indexOf(norm);
      if (idx < 0) idx = wanted.findIndex(w => norm && (norm.includes(w) || w.includes(norm)));
      if (idx < 0) continue;
      title = titles[idx];
    } else if (titleMatch && !titleMatch.test(rawTitle)) {
      continue;
    }

    const table = ds?.table;
    const rows = table?.rows ?? [];
    const { time, value, labels } = columnIndexes(table?.columns);
    if (!time || !value) continue;

    const byName = new Map();
    for (const row of rows) {
      const ts = new Date(row[time.i]);
      const v = Number(row[value.i]);
      if (Number.isNaN(ts.getTime()) || Number.isNaN(v)) continue;
      const name = labels.map(c => row[c.i]).filter(x => x != null && x !== '').join(' · ') || title;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ t: ts.toISOString(), count: v });
    }

    const series = [...byName.entries()]
      .map(([name, points]) => ({ name, series: points.sort((a, b) => a.t < b.t ? -1 : 1) }))
      // Busiest first: the legend is capped below, and a flat zero series is the
      // one worth dropping.
      .sort((a, b) => Math.max(...b.series.map(p => p.count)) - Math.max(...a.series.map(p => p.count)))
      .slice(0, maxSeries);

    charts.push({ title, series });
  }

  if (!charts.length) return null;

  if (titles) {
    for (const title of titles) {
      if (!charts.some(c => c.title === title)) charts.push({ title, series: [] });
    }
    charts.sort((a, b) => titles.indexOf(a.title) - titles.indexOf(b.title));
  }
  return { detector: detectorName ?? payload?.name ?? null, charts, grainMs: detectGrainMs(charts) };
}

/**
 * The bucket width the detector actually returned, in milliseconds — the median
 * gap between consecutive points of its longest series. Pure.
 *
 * Needed because a detector is free to ignore the requested timeGrain, and the
 * only honest way to tell the reader "these charts are coarser than the interval
 * you picked" is to measure what came back.
 */
function detectGrainMs(charts) {
  const longest = (charts ?? [])
    .flatMap(c => c.series)
    .reduce((best, s) => (s.series.length > (best?.series.length ?? 0) ? s : best), null);
  const pts = longest?.series ?? [];
  if (pts.length < 2) return null;
  const deltas = [];
  for (let i = 1; i < pts.length; i++) {
    const d = new Date(pts[i].t).getTime() - new Date(pts[i - 1].t).getTime();
    if (d > 0) deltas.push(d);
  }
  if (!deltas.length) return null;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] ?? null;
}

/**
 * The detector's prose findings — the "Application stop events are detected" block
 * in the portal, one row per event with the instance, time and cause written out.
 *
 * Azure renders these as an Insights table: `Status`, `Message` (the finding), and
 * `Data.Name` / `Data.Value` pairs (the rows beneath it). The values are HTML, so
 * they are also flattened to text for anywhere that cannot render markup. Pure.
 */
function parseDetectorInsights(payload) {
  const datasets = payload?.properties?.dataset ?? payload?.dataset ?? [];
  if (!Array.isArray(datasets)) return [];

  const findings = [];
  for (const ds of datasets) {
    const cols = (ds?.table?.columns ?? []).map(c => String(c?.columnName ?? ''));
    const idx = (name) => cols.findIndex(c => c.toLowerCase() === name);
    const iStatus = idx('status');
    const iMessage = idx('message');
    const iName = idx('data.name');
    const iValue = idx('data.value');
    // An insight table is identified by its columns, not by a rendering-type number:
    // those numbers have changed between API versions, the column names have not.
    if (iMessage < 0 || iName < 0 || iValue < 0) continue;

    const byMessage = new Map();
    for (const row of ds.table.rows ?? []) {
      const message = String(row[iMessage] ?? '').trim();
      const name = String(row[iName] ?? '').trim();
      const value = String(row[iValue] ?? '').trim();
      if (!message || (!name && !value)) continue;
      if (!byMessage.has(message)) {
        byMessage.set(message, { status: iStatus >= 0 ? String(row[iStatus] ?? '') : '', message, items: [] });
      }
      byMessage.get(message).items.push({ name, html: value, text: htmlToText(value) });
    }
    findings.push(...byMessage.values());
  }
  return findings;
}

/** Detector descriptions carry links and <b> tags; the card renders plain text. */
function htmlToText(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // Logged rather than swallowed: a blank section is otherwise indistinguishable
    // from "this site has no detector", and the two are fixed in different places.
    console.warn(`[detector] GET ${res.status} ${res.statusText} — ${url}`);
    return null;
  }
  return res.json();
}

/**
 * Discovers a detector for a site by keyword and returns its parsed charts.
 * Resolves to null when the site publishes nothing matching.
 *
 * `timeGrain` is an ISO8601 duration (PT1M / PT5M / PT1H). Detectors are free to
 * ignore it, and some reject it outright with a 400 — a rejected grain retries at
 * the detector's own default, because losing the charts is worse than losing the
 * resolution.
 */
async function fetchDetectorCharts(token, siteResId, { keywords, titles = null, titleMatch = null, startIso, endIso, timeGrain = null, label = 'detector' }) {
  const list = await getJson(`https://management.azure.com${siteResId}/detectors?api-version=${API_VERSION}`, token);
  if (!list) return null;

  const name = findDetector(list, keywords);
  if (!name) {
    // One line, once per fetch: a detector rename is the likeliest reason a section
    // ever goes blank, and the available ids are what identifies the new one.
    const ids = (list.value ?? []).map(d => d?.name).filter(Boolean);
    console.warn(`[${label}] no detector matching ${keywords.join(' / ')} on site; available:`, ids.join(', '));
    return null;
  }

  const url = (grain) =>
    `https://management.azure.com${siteResId}/detectors/${encodeURIComponent(name)}` +
    `?api-version=${API_VERSION}&startTime=${encodeURIComponent(startIso)}&endTime=${encodeURIComponent(endIso)}` +
    (grain ? `&timeGrain=${encodeURIComponent(grain)}` : '');

  let payload = await getJson(url(timeGrain), token);
  if (!payload && timeGrain) {
    console.warn(`[${label}] detector ${name} rejected timeGrain=${timeGrain}; retrying at its default grain`);
    payload = await getJson(url(null), token);
  }
  if (!payload) return null;
  const parsed = parseDetectorCharts(payload, name, { titles, titleMatch });
  const insights = parseDetectorInsights(payload);
  if (!parsed) return insights.length ? { detector: name, charts: [], grainMs: null, insights } : null;
  return { ...parsed, insights };
}

module.exports = {
  API_VERSION,
  normalizeTitle,
  findDetector,
  parseDetectorCharts,
  parseDetectorInsights,
  htmlToText,
  detectGrainMs,
  fetchDetectorCharts,
};
