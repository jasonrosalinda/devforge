import { describe, it, expect } from 'vitest';
import type { RestartResult, SnatFetchResult } from '@shared/types/azureMetrics.types';
import { diffEvents, eventWindow, rebase } from './eventAlerts';

const restartsAt = (...times: string[]) => ({
  charts: [{ title: 'Restarts', series: [{ name: 'Kudu Kill', series: times.map(t => ({ t, count: 1 })) }] }],
}) as unknown as RestartResult;
const snat = (used: number, failed: number, shared = true) => {
  const site = {
    charts: [
      { title: 'SNAT port usage for TCP protocol', series: [
        { name: 'wn0a (TCP_Used)', series: [{ t: '2026-11-10T12:00:00Z', count: used }] },
        { name: 'wn0a (TCP_Allocated)', series: [{ t: '2026-11-10T12:00:00Z', count: 128 }] },
      ] },
      { title: 'Failed SNAT connections', series: failed ? [{ name: 'wn0a', series: [{ t: '2026-11-10T12:00:00Z', count: failed }] }] : [] },
    ],
  };
  return { fe: site, api: shared ? null : site, shared } as unknown as SnatFetchResult;
};

describe('diffEvents', () => {
  it('records the first check as the baseline and alerts nothing', () => {
    const { next, lines } = diffEvents(undefined, { fe: restartsAt('2026-11-10T12:21:00Z'), api: null }, snat(125, 3));
    expect(lines).toEqual([]);
    expect(next.seen).toHaveLength(1);
    expect(next.snatFailing).toBe(true);
  });

  it('alerts each new restart once, by time, cause and site', () => {
    const base = diffEvents(undefined, { fe: restartsAt('2026-11-10T12:21:00Z'), api: null }, null).next;
    const r1 = diffEvents(base, { fe: restartsAt('2026-11-10T12:21:00Z', '2026-11-10T12:22:00Z'), api: restartsAt('2026-11-10T12:22:00Z') }, null);
    expect(r1.lines).toHaveLength(2);
    expect(r1.lines[0]).toMatch(/^Frontend restarted: Kudu Kill at /);
    expect(r1.lines[1]).toMatch(/^API restarted: Kudu Kill at /);
    expect(diffEvents(r1.next, { fe: restartsAt('2026-11-10T12:21:00Z', '2026-11-10T12:22:00Z'), api: restartsAt('2026-11-10T12:22:00Z') }, null).lines).toEqual([]);
  });

  it('alerts SNAT only when connections fail near exhaustion, and only when it starts', () => {
    const base = diffEvents(undefined, null, snat(40, 0)).next;
    expect(diffEvents(base, null, snat(68, 2)).lines).toEqual([]);   // 53%: the destination refused, not exhaustion
    const start = diffEvents(base, null, snat(120, 5));
    expect(start.lines).toEqual(['SNAT ports 94% used, 5 failed connections: outbound ports close to exhausted']);
    expect(diffEvents(start.next, null, snat(121, 9)).lines).toEqual([]);
  });

  it('keeps the restart window start fixed, moving it only once it is a day old', () => {
    const H = 3_600_000, now = Date.parse('2026-11-10T12:00:00Z');
    expect(eventWindow(undefined, now)).toEqual({ anchorMs: now - 6 * H, moved: false });
    expect(eventWindow(now - 20 * H, now)).toEqual({ anchorMs: now - 20 * H, moved: false });
    expect(eventWindow(now - 25 * H, now)).toEqual({ anchorMs: now - 6 * H, moved: true });
  });

  it('re-reads the counts after the window moves, alerting nothing and remembering dated restarts', () => {
    const undated = (n: number) => ({ charts: [{ title: 'Restarts', series: [] }], insights: [{ message: 'x', items: [{ name: 'Description', text: `We analyzed \`${n}\` Kudu Kill Events.` }] }] }) as unknown as RestartResult;
    const base = diffEvents(undefined, { fe: restartsAt('2026-11-10T12:21:00Z'), api: null }, null).next;
    const moved = rebase(base, { fe: undated(1), api: null });
    expect(moved.seen).toEqual(base.seen);
    expect(moved.totals.fe).toBe(1);
    // A later rise against the re-read count is new.
    expect(diffEvents(moved, { fe: undated(2), api: null }, null).lines).toEqual(['Frontend: 1 new restart']);
  });

  it('counts a shared plan once, and keeps the last state when a detector call failed', () => {
    const base = diffEvents(undefined, { fe: restartsAt('2026-11-10T12:21:00Z'), api: null }, snat(40, 0, false)).next;
    // Two plans, two pools: their failures add up.
    expect(diffEvents(base, null, snat(120, 2, false)).lines[0]).toMatch(/4 failed connections/);
    // One plan: the API's copy of the same pool is not added.
    const sharedWithCopy = { ...snat(120, 2, false), shared: true };
    expect(diffEvents(base, null, sharedWithCopy).lines[0]).toMatch(/2 failed connections/);
    const kept = diffEvents(base, null, null).next;
    expect(kept.seen).toEqual(base.seen);
  });
});
