// App Service Diagnostics — the Application Crashes detector (`appcrashes`).
//
// Restarts already counts "App Crash" as a cause, but only as a count and a
// timestamp — it does not say which exception faulted the process. This is the
// detector the portal's own "Application Crashes" page uses, and it answers
// that: a per-bucket crash-count timeline (always present) plus, once Proactive
// Crash Monitoring has triggered (Azure's own threshold: crashing more than 3
// times in 24h), a dropdown of individual crash events each with a captured
// callstack — the same stack trace App Service emails out when it happens.
//
// Confirmed live against a real site — `appcrashes` is the detector id. Its
// payload carries five datasets: an "Application Event Logs" markdown block, an
// insights table (the "N crashes due to (code)" headline), the per-event
// "Crashing Thread Callstack" dropdown, the crash-count timeline chart, and a
// "Some Useful Links" markdown block. Only the timeline and the per-event
// dropdown are parsed here — the two markdown blocks and the insights headline
// are Azure's own generic advice text, not a fact specific to this app.
//
// Per site, not per plan: a frontend crashing while its API stays up is exactly
// the distinction worth seeing, so the FE and the API are queried separately —
// same reasoning as azure-restarts.cjs.

const { fetchDetectorPayload, parseDetectorCharts, htmlToText } = require('./azure-detectors.cjs');

/** Ordered strongest-first — see findDetector. 'appcrashes' is the id confirmed
 *  live against a real site. */
const CRASH_KEYWORDS = ['appcrashes', 'application crashes'];

/** The timeline dataset's title, so it isn't confused with the per-event
 *  dropdown or the markdown blocks the same payload carries. */
const CRASH_CHART_MATCH = /crashes timeline/i;

/** "08/13/2026 03:35:49" (UTC — the detector's own range is UTC) → ISO.
 *  Null when it does not parse. */
function usDateToIso(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * The per-event dropdown's `Key` column: "08/13/2026 03:35:49 0xE0434352 - CLR
 * Exception System.ObjectDisposedException" → {t, exitCode, category,
 * exceptionType}. Pure.
 *
 * The trailing dotted identifier is treated as the exception type when present;
 * a native crash with no managed exception (an access violation, say) has no
 * such token, and `exceptionType` is left null rather than guessed at.
 */
function parseCrashKey(key) {
  const m = /^(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}:\d{2})\s+(0x[0-9a-f]+)\s*-\s*(.+)$/i.exec(String(key ?? '').trim());
  if (!m) return null;
  const rest = m[3].trim();
  const typed = /^(.*?)\s+([\w]+(?:\.[\w]+)+)$/.exec(rest);
  return {
    t: usDateToIso(m[1]) ?? '',
    exitCode: m[2],
    category: typed ? typed[1] : rest,
    exceptionType: typed ? typed[2] : null,
  };
}

/**
 * The per-event dropdown's `Value` column: a JSON-encoded single-cell dataset
 * whose one row is an HTML `<ul><li>` list, one `<li>` per stack frame. Reads
 * through both wrappers to a plain, newline-joined stack trace. Pure.
 */
function parseCrashStackTrace(value) {
  let html = value;
  try {
    const parsed = JSON.parse(value);
    html = parsed?.[0]?.table?.rows?.[0]?.[0] ?? value;
  } catch {
    // Not JSON — treat the raw value as the HTML itself rather than fail.
  }
  const str = String(html ?? '');
  const frames = [...str.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(m => htmlToText(m[1]));
  return frames.length ? frames.join('\n') : htmlToText(str);
}

/**
 * One row of the detector's "Crashing Thread Callstack" dropdown — one row per
 * crash Proactive Crash Monitoring captured a stack trace for. Pure.
 *
 * Identified by its columns (Key + Value), not its title: the dataset itself
 * carries no title, only the fixed dropdown placeholder "Select a crash event"
 * in every row's Label cell.
 */
function parseCrashEvents(payload) {
  const datasets = payload?.properties?.dataset ?? payload?.dataset ?? [];
  const events = [];
  for (const ds of datasets) {
    const cols = ds?.table?.columns ?? [];
    const iKey = cols.findIndex(c => String(c?.columnName ?? '').toLowerCase() === 'key');
    const iValue = cols.findIndex(c => String(c?.columnName ?? '').toLowerCase() === 'value');
    if (iKey < 0 || iValue < 0) continue;
    for (const row of ds.table?.rows ?? []) {
      const parsedKey = parseCrashKey(row[iKey]);
      if (!parsedKey) continue;
      events.push({ ...parsedKey, stackTrace: parseCrashStackTrace(row[iValue]) });
    }
  }
  return events.sort((a, b) => (a.t < b.t ? 1 : -1));
}

/**
 * Crash timeline plus individual crash events for one site. Null when the site
 * publishes no Application Crashes detector.
 */
async function fetchCrashData(token, siteResId, startIso, endIso, timeGrain) {
  const resolved = await fetchDetectorPayload(token, siteResId, {
    keywords: CRASH_KEYWORDS,
    startIso,
    endIso,
    timeGrain,
    label: 'crashes',
  });
  if (!resolved) return null;
  const { name, payload } = resolved;
  const parsedChart = parseDetectorCharts(payload, name, { titleMatch: CRASH_CHART_MATCH });
  return {
    detector: name,
    charts: parsedChart?.charts ?? [],
    grainMs: parsedChart?.grainMs ?? null,
    events: parseCrashEvents(payload),
  };
}

/**
 * Total crashes in the window, from the timeline. Pure.
 *
 * The timeline counts every crash; the per-event list below only covers the
 * ones Proactive Crash Monitoring captured a stack trace for (Azure's own cap
 * is the last handful per window), so the two numbers can legitimately differ.
 */
function crashTotals(charts) {
  const chart = (charts ?? []).find(c => /crash/i.test(c.title)) ?? (charts ?? [])[0];
  if (!chart) return { total: 0 };
  const total = chart.series.reduce((sum, s) => sum + s.series.reduce((a, p) => a + (p.count ?? 0), 0), 0);
  return { total };
}

/** Captured crash events grouped by exception type. Pure. */
function eventsByExceptionType(events) {
  const byType = new Map();
  for (const e of events ?? []) {
    const type = e.exceptionType || e.category || 'Unknown exception';
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  return [...byType.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count);
}

module.exports = {
  CRASH_KEYWORDS,
  CRASH_CHART_MATCH,
  parseCrashKey,
  parseCrashStackTrace,
  parseCrashEvents,
  fetchCrashData,
  crashTotals,
  eventsByExceptionType,
};
