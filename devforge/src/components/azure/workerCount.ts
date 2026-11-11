// Capacity over time: how many workers served requests in each bucket. A worker only has a
// point where it served traffic (instanceHealthSeries omits empty buckets on purpose), so the
// count drops when the plan scales in, when a worker is recycled or killed, and to 0 in a total
// outage — the "were there enough workers when the surge hit?" question, from data the card
// already fetches.

type InstanceSeries = Array<{ name: string; series: Array<{ t: string; v: number }> }> | null | undefined;

/**
 * Workers serving requests per bucket, for the FE and (when it has its own) the API, on the
 * given bucket stamps — the CPU chart's, so the two line up and an empty bucket counts 0. Pure.
 */
export function workerCounts(stamps: readonly string[], fe: InstanceSeries, api?: InstanceSeries): Array<{ t: string; fe: number | null; api: number | null }> {
  const perBucket = (inst: InstanceSeries) => {
    if (!inst?.length) return null;
    const m = new Map<number, number>();
    for (const i of inst) for (const p of i.series) {
      const k = Date.parse(p.t);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const feMap = perBucket(fe);
  const apiMap = perBucket(api);
  return stamps.map(t => {
    const k = Date.parse(t);
    return { t, fe: feMap ? (feMap.get(k) ?? 0) : null, api: apiMap ? (apiMap.get(k) ?? 0) : null };
  });
}

/** Step changes in the FE count, for a one-line summary: "3 → 2 at 17:40". Pure. */
export function workerChanges(rows: ReadonlyArray<{ t: string; fe: number | null }>): Array<{ t: string; from: number; to: number }> {
  const out: Array<{ t: string; from: number; to: number }> = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!.fe, b = rows[i]!.fe;
    if (a != null && b != null && a !== b) out.push({ t: rows[i]!.t, from: a, to: b });
  }
  return out;
}
