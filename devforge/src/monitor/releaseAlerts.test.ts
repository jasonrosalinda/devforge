import { describe, expect, it } from 'vitest';
import type { ReleaseEvent } from '@shared/types/azureMetrics.types';
import type { VerdictRow } from '@/components/azure/releaseVerdict';
import {
  RELEASE_GIVE_UP_MS, RELEASE_JUDGE_DELAY_MS, afterVerdict, dueReleases, emptyReleaseWatch, noteRelease,
  parseWatchKey, releaseAlertBody, watchKey,
} from './releaseAlerts';

const ev = (at: string): ReleaseEvent => ({ at, source: 'swap' });
const K = watchKey('medu-web', 'fe');
const T0 = '2026-11-09T01:00:00.000Z'; // baseline taken
const T1 = '2026-11-09T02:00:00.000Z';
const T2 = '2026-11-09T05:00:00.000Z';
const BASE_MS = Date.parse(T0);

describe('noteRelease', () => {
  it('only sets a baseline the first time, so older releases are never judged', () => {
    const s = noteRelease(emptyReleaseWatch(), K, ev(T1), BASE_MS);
    expect(s).toEqual({ seen: { [K]: T1 }, since: { [K]: BASE_MS }, pending: {} });
    expect(noteRelease(emptyReleaseWatch(), K, null, BASE_MS)).toEqual({ seen: { [K]: null }, since: { [K]: BASE_MS }, pending: {} });
  });

  it('queues a newer release, ignores the same or an older one', () => {
    const base = noteRelease(emptyReleaseWatch(), K, ev(T1), BASE_MS);
    expect(noteRelease(base, K, ev(T1), BASE_MS)).toBe(base);
    expect(noteRelease(base, K, null, BASE_MS)).toBe(base);
    const next = noteRelease(base, K, ev(T2), BASE_MS);
    expect(next.pending[K]).toEqual(ev(T2));
    expect(next.seen[K]).toBe(T2);
  });

  it('queues the first release of a site that had none at the baseline', () => {
    const base = noteRelease(emptyReleaseWatch(), K, null, BASE_MS);
    expect(noteRelease(base, K, ev(T1), BASE_MS).pending[K]).toEqual(ev(T1));
  });

  it('never judges a release from before the baseline, even when it shows up later', () => {
    // An empty baseline, then a two-week-old release on the next read.
    const base = noteRelease(emptyReleaseWatch(), K, null, BASE_MS);
    const old = noteRelease(base, K, ev('2026-10-26T02:00:00.000Z'), BASE_MS + 600_000);
    expect(old.pending).toEqual({});
    expect(old.seen[K]).toBe('2026-10-26T02:00:00.000Z');
    expect(dueReleases(old, BASE_MS + 10 * 3_600_000)).toEqual([]);
  });

  it('replaces a waiting release with a newer one', () => {
    let s = noteRelease(emptyReleaseWatch(), K, null, BASE_MS);
    s = noteRelease(s, K, ev(T1), BASE_MS);
    s = noteRelease(s, K, ev(T2), BASE_MS);
    expect(Object.values(s.pending)).toEqual([ev(T2)]);
  });
});

describe('dueReleases / afterVerdict', () => {
  const pending = noteRelease(noteRelease(emptyReleaseWatch(), K, null, BASE_MS), K, ev(T1), BASE_MS);
  const at = Date.parse(T1);

  it('is due only once the hour plus ingestion lag has passed', () => {
    expect(RELEASE_JUDGE_DELAY_MS).toBe(70 * 60_000);
    expect(dueReleases(pending, at + RELEASE_JUDGE_DELAY_MS - 1)).toEqual([]);
    expect(dueReleases(pending, at + RELEASE_JUDGE_DELAY_MS)).toEqual([[K, ev(T1)]]);
  });

  it('drops a judged release so it alerts at most once', () => {
    const s = afterVerdict(pending, K, true, at + RELEASE_JUDGE_DELAY_MS);
    expect(s.pending).toEqual({});
    expect(dueReleases(s, at + 10 * RELEASE_JUDGE_DELAY_MS)).toEqual([]);
  });

  it('retries a failed verdict, then gives up', () => {
    expect(afterVerdict(pending, K, false, at + RELEASE_JUDGE_DELAY_MS)).toBe(pending);
    expect(afterVerdict(pending, K, false, at + RELEASE_GIVE_UP_MS).pending).toEqual({});
    expect(afterVerdict(pending, 'other:fe', true, at)).toBe(pending);
  });
});

describe('helpers', () => {
  it('splits a watch key on its last colon', () => {
    expect(parseWatchKey(watchKey('a:b', 'api'))).toEqual({ appKey: 'a:b', site: 'api' });
    expect(parseWatchKey('x:fe')).toEqual({ appKey: 'x', site: 'fe' });
  });

  it('lists up to three worse rows, then new exception types', () => {
    const row = (label: string, judgement: VerdictRow['judgement']): VerdictRow =>
      ({ key: label, label, before: 1, after: 2, beforeText: '0.4%', afterText: '2.1%', deltaPct: 1, judgement });
    const body = releaseAlertBody(
      [row('5xx rate', 'worse'), row('CPU avg', 'same'), row('p95', 'worse'), row('A', 'worse'), row('B', 'worse')],
      [{ type: 'System.NullReferenceException', count: 12 }],
    );
    expect(body).toBe('5xx rate 0.4% → 2.1%\np95 0.4% → 2.1%\nA 0.4% → 2.1%\nNew exceptions: NullReferenceException (12)');
  });
});
