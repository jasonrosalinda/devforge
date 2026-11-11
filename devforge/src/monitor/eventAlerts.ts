// Tray alerts for what the metric check cannot see: a process restart (Kudu kill, app
// crash, platform healing) and SNAT connections failing near port exhaustion. Both
// come from App Service Diagnostics detectors, so the monitor asks for them every
// EVENT_POLL_MS rather than every minute. Same rules as the card and the incident
// report: a restart is new by its time, cause and worker; SNAT alerts only when
// connections failed with the pool at least SNAT_NEAR_FULL used.

import type { RestartResult, SnatFetchResult, SnatResult } from '@shared/types/azureMetrics.types';
import { restartEvents, restartTotals } from '@/components/azure/restartSection';
import { snatSummary } from '@/components/azure/snatPortSection';

export const EVENT_POLL_MS = 10 * 60_000;
export const SNAT_NEAR_FULL = 0.8;
/** SNAT is judged on its recent past, so a failure an hour ago does not mask a new one. */
export const SNAT_WINDOW_MS = 30 * 60_000;
/** The restart window starts at a fixed moment and moves forward once it is this old. */
export const RESTART_ANCHOR_MAX_MS = 24 * 3_600_000;
const RESTART_ANCHOR_BACK_MS = 6 * 3_600_000;

/**
 * Where the restart window starts. Fixed, not sliding: a sliding window lets an old restart
 * leave it in the same check a new one arrives, so an undated count would not move. Once the
 * fixed start is a day old it moves to six hours back, and `rebase` re-reads the counts. Pure.
 */
export function eventWindow(anchorMs: number | undefined, nowMs: number): { anchorMs: number; moved: boolean } {
  if (anchorMs == null) return { anchorMs: nowMs - RESTART_ANCHOR_BACK_MS, moved: false };
  if (nowMs - anchorMs > RESTART_ANCHOR_MAX_MS) return { anchorMs: nowMs - RESTART_ANCHOR_BACK_MS, moved: true };
  return { anchorMs, moved: false };
}

/** The state after the restart window moved: counts from the new window, nothing alerted, dated restarts still remembered. Pure. */
export function rebase(prev: EventWatch, restarts: { fe: RestartResult | null; api: RestartResult | null } | null): EventWatch {
  const fresh = diffEvents(undefined, restarts, null).next;
  return { seen: [...new Set([...prev.seen, ...fresh.seen])].slice(-MAX_SEEN), totals: fresh.totals, snatFailing: prev.snatFailing };
}

export interface EventWatch {
  /** Dated restarts already seen, by site|time|cause|worker. */
  seen: string[];
  /** Restarts the detectors counted, per site, for the undated kind. */
  totals: { fe: number; api: number };
  /** SNAT was failing near exhaustion at the last check, so a still-failing pool is not re-alerted. */
  snatFailing: boolean;
}

const MAX_SEEN = 500;

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** Peak use against the allocation, and failed connections, over the sites that have their own pool. */
function snatState(snat: SnatFetchResult | null | undefined): { failing: boolean; text: string } {
  // A shared plan reports one pool, on the frontend.
  const pools = [snat?.fe, snat?.shared ? null : snat?.api].filter((s): s is SnatResult => !!s?.charts?.length).map(snatSummary);
  const used = Math.max(0, ...pools.map(p => (p.peakAllocated ? (p.peakUsed ?? 0) / p.peakAllocated : 0)));
  const failed = pools.reduce((n, p) => n + (p.failedTotal ?? 0), 0);
  return {
    failing: failed > 0 && used >= SNAT_NEAR_FULL,
    text: `SNAT ports ${Math.round(used * 100)}% used, ${failed} failed connection${failed === 1 ? '' : 's'}: outbound ports close to exhausted`,
  };
}

/**
 * One line per restart or SNAT failure that is new since `prev`. No `prev` is the
 * baseline — the first check after the monitor starts — and says nothing, like the
 * metric alerts, so switching the monitor on does not replay the last hours. Pure.
 */
export function diffEvents(
  prev: EventWatch | undefined,
  restarts: { fe: RestartResult | null; api: RestartResult | null } | null,
  snat: SnatFetchResult | null,
): { next: EventWatch; lines: string[] } {
  const lines: string[] = [];
  const seen = new Set(prev?.seen ?? []);
  const totals = { fe: 0, api: 0 };
  for (const site of ['fe', 'api'] as const) {
    const r = restarts?.[site];
    if (!r) { totals[site] = prev?.totals[site] ?? 0; continue; }
    totals[site] = restartTotals(r).total;
    let dated = 0;
    for (const ev of restartEvents(r)) {
      if (ev.undated || !ev.t) continue;
      dated++;
      const key = `${site}|${ev.t}|${ev.cause}|${ev.instance ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (prev) lines.push(`${site === 'api' ? 'API' : 'Frontend'} restarted: ${ev.cause}${ev.instance ? ` on ${ev.instance}` : ''} at ${timeOf(ev.t)}`);
    }
    // Restarts the detector counted without times: alert on a rise in the count. The restart
    // window starts at a fixed moment (see eventWindow), so the count only grows within it.
    const risen = totals[site] - (prev?.totals[site] ?? totals[site]);
    if (prev && !dated && risen > 0) lines.push(`${site === 'api' ? 'API' : 'Frontend'}: ${risen} new restart${risen === 1 ? '' : 's'}`);
  }
  const s = snatState(snat);
  if (prev && s.failing && !prev.snatFailing) lines.push(s.text);
  return { next: { seen: [...seen].slice(-MAX_SEEN), totals, snatFailing: s.failing }, lines };
}
