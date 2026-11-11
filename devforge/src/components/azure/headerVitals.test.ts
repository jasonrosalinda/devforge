import { describe, it, expect } from 'vitest';
import type { CrashResult, RestartResult, SnatResult } from '@shared/types/azureMetrics.types';
import { headerVitals } from './headerVitals';

const pts = (...counts: number[]) => counts.map((count, n) => ({ t: `2026-11-10T06:0${n}:00Z`, count }));
const snat = (used: number, allocated: number, failed: number[] = []) => ({
  charts: [
    { title: 'SNAT port usage for TCP protocol', series: [{ name: 'wn0a (TCP_Used)', series: pts(used) }, { name: 'wn0a (TCP_Allocated)', series: pts(allocated) }] },
    { title: 'Failed SNAT connections', series: failed.length ? [{ name: 'wn0a', series: pts(...failed) }] : [] },
  ],
}) as unknown as SnatResult;
const restarts = (...counts: number[]) => ({ charts: [{ title: 'Restarts', series: [{ name: 'Kudu Kill', series: pts(...counts) }] }] }) as unknown as RestartResult;
const crashes = (...counts: number[]) => ({ charts: [{ title: 'App crashes', series: [{ name: 'w3wp', series: pts(...counts) }] }] }) as unknown as CrashResult;

describe('headerVitals', () => {
  it('sums the frontend and API and colours by severity', () => {
    const v = headerVitals({
      snat: snat(64, 128), apiSnat: snat(120, 128),
      restarts: restarts(2), apiRestarts: restarts(1),
      crashes: crashes(0), apiCrashes: crashes(0),
    });
    expect(v).toEqual([
      { key: 'snat', text: 'SNAT 94%', tone: 'warn' },
      { key: 'restarts', text: '3 restarts', tone: 'warn' },
      { key: 'crashes', text: '0 crashes', tone: 'ok' },
    ]);
  });

  it('flags crashes and near-exhaustion failures as bad, failures at low port use as a warning', () => {
    const v = headerVitals({ snat: snat(10, 128, [2, 3]), crashes: crashes(1) });
    expect(v).toEqual([
      { key: 'snat', text: 'SNAT 8% · 5 failed', tone: 'warn' },
      { key: 'crashes', text: '1 crash', tone: 'bad' },
    ]);
    expect(headerVitals({ snat: snat(120, 128, [1]) })[0]).toMatchObject({ text: 'SNAT 94% · 1 failed', tone: 'bad' });
  });

  it('leaves out what has not loaded or has no detector, instead of showing zero', () => {
    expect(headerVitals({ snat: undefined, restarts: null, crashes: undefined })).toEqual([]);
  });
});
