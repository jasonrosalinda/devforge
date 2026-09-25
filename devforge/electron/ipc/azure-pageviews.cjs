// App Insights page views — browser page-load time for the frontend.
//
// `pageViews` rows are written by the App Insights JavaScript SDK running in the
// browser, not by the server, so a site without the SDK has none: the result then
// says so (views 0) rather than looking like an empty but healthy chart.
//
// `duration` on a page view is the page load time in milliseconds (navigation
// start to load event). `browserTimings` splits that same load into network,
// send, receive and client processing, which is what tells a slow server apart
// from a heavy page.

/** Bin width that keeps a window near ~120 buckets, same scheme as the endpoint timelines. */
function pageViewBin(spanMins) {
  return spanMins <= 120 ? '1m'
    : spanMins <= 600 ? '5m'
      : spanMins <= 1800 ? '15m'
        : spanMins <= 7200 ? '1h'
          : spanMins <= 43200 ? '6h'
            : '1d';
}

/** The four KQL statements, in the order parsePageViewTables expects. */
function pageViewQueries(bin) {
  return [
    // 0: headline figures. itemCount undoes sampling for the view count.
    'pageViews | summarize viewCount=sum(itemCount), avgMs=avg(duration), p50Ms=percentile(duration,50), p95Ms=percentile(duration,95), maxMs=max(duration)',
    // 1: load time over time.
    `pageViews | summarize avgMs=avg(duration), p95Ms=percentile(duration,95), viewCount=sum(itemCount) by bin(timestamp, ${bin}) | order by timestamp asc`,
    // 2: busiest operations with their own load time. Grouped by operation_Name (the
    // route) rather than name (the page <title>): titles vary per locale and page, so
    // one route split into many rows. Falls back to the title where no operation is set.
    'pageViews | extend op=iff(isnotempty(operation_Name), operation_Name, name) | summarize viewCount=sum(itemCount), avgMs=avg(duration), p95Ms=percentile(duration,95) by op | top 10 by viewCount desc',
    // 3: where the load time goes.
    'browserTimings | summarize timingCount=sum(itemCount), networkMs=avg(networkDuration), sendMs=avg(sendDuration), receiveMs=avg(receiveDuration), processingMs=avg(processingDuration), totalMs=avg(totalDuration)',
  ];
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * Shape the batch's tables (rows arrays, or { error }) into the card's payload.
 * A failure of the headline table fails the whole result; the others degrade to empty.
 */
function parsePageViewTables(tables, bin) {
  const [summary, series, pages, timings] = tables;
  if (!Array.isArray(summary)) return { error: summary?.error ?? 'Page view query failed' };

  const [views, avgMs, p50Ms, p95Ms, maxMs] = summary[0] ?? [];
  const viewCount = typeof views === 'number' ? views : 0;

  const t = Array.isArray(timings) ? timings[0] : null;
  const timingSamples = t && typeof t[0] === 'number' ? t[0] : 0;

  return {
    bin,
    views: viewCount,
    avgMs: viewCount ? num(avgMs) : null,
    p50Ms: viewCount ? num(p50Ms) : null,
    p95Ms: viewCount ? num(p95Ms) : null,
    maxMs: viewCount ? num(maxMs) : null,
    series: Array.isArray(series)
      ? series
        .filter(r => typeof r[1] === 'number')
        .map(r => ({ t: String(r[0]), avgMs: num(r[1]), p95Ms: num(r[2]), views: typeof r[3] === 'number' ? r[3] : 0 }))
      : [],
    pages: Array.isArray(pages)
      ? pages.map(r => ({ name: String(r[0] ?? '(unnamed)'), views: typeof r[1] === 'number' ? r[1] : 0, avgMs: num(r[2]), p95Ms: num(r[3]) }))
      : [],
    timings: timingSamples > 0
      ? { samples: timingSamples, networkMs: num(t[1]), sendMs: num(t[2]), receiveMs: num(t[3]), processingMs: num(t[4]), totalMs: num(t[5]) }
      : null,
  };
}

/** Run the batch against one App Insights app. `runBatch(queries)` returns one rows array (or { error }) per query. */
async function getPageViewInsights(runBatch, spanMins) {
  const bin = pageViewBin(spanMins);
  const tables = await runBatch(pageViewQueries(bin));
  return parsePageViewTables(tables, bin);
}

module.exports = { pageViewBin, pageViewQueries, parsePageViewTables, getPageViewInsights };
