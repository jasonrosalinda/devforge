// Small concurrency helpers shared by main-process modules.

/** Run fn over items with at most `limit` running at once; results keep the input order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * An order of alternatives to try that moves the last one that worked to the front, e.g.
 * token vs session download: once the session has worked, later downloads skip the
 * token request that would only fail again.
 */
function makeStickyOrder(paths) {
  let preferred = null;
  return {
    current: () => (preferred ? [preferred, ...paths.filter((p) => p !== preferred)] : [...paths]),
    succeeded: (path) => { preferred = path; },
  };
}

module.exports = { mapPool, makeStickyOrder };
