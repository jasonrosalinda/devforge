import type { CrashResult, RestartResult, SnatResult } from '@shared/types/azureMetrics.types';
import { snatSummary } from './snatPortSection';
import { restartTotals } from './restartSection';
import { crashTotals } from './crashMonitoringSection';

export interface HeaderVital {
  key: 'snat' | 'restarts' | 'crashes';
  text: string;
  tone: 'ok' | 'warn' | 'bad';
}

/** SNAT this close to the allocation is the precursor to failed connections. */
const SNAT_WARN = 0.8;

/**
 * The card header's "is this hour bad?" chips: SNAT port use, restarts and crashes for the
 * frontend and API together. A source not loaded yet (undefined) or without a detector
 * (null) is left out rather than shown as zero. Pure.
 */
export function headerVitals(i: {
  snat?: SnatResult | null | undefined;
  apiSnat?: SnatResult | null | undefined;
  restarts?: RestartResult | null | undefined;
  apiRestarts?: RestartResult | null | undefined;
  crashes?: CrashResult | null | undefined;
  apiCrashes?: CrashResult | null | undefined;
}): HeaderVital[] {
  const out: HeaderVital[] = [];

  const snats = [i.snat, i.apiSnat].filter((s): s is SnatResult => !!s?.charts?.length).map(snatSummary);
  if (snats.some(s => s.peakAllocated)) {
    const pct = Math.max(...snats.map(s => (s.peakAllocated ? (s.peakUsed ?? 0) / s.peakAllocated : 0)));
    const failed = snats.reduce((n, s) => n + (s.failedTotal ?? 0), 0);
    out.push({
      key: 'snat',
      text: `SNAT ${Math.round(pct * 100)}%${failed ? ` · ${failed} failed` : ''}`,
      // Failures at low port use are the destination refusing, not exhaustion: amber, not red.
      tone: failed && pct >= SNAT_WARN ? 'bad' : failed || pct >= SNAT_WARN ? 'warn' : 'ok',
    });
  }

  const restarts = [i.restarts, i.apiRestarts].filter((r): r is RestartResult => r != null);
  if (restarts.length) {
    const n = restarts.reduce((sum, r) => sum + restartTotals(r).total, 0);
    out.push({ key: 'restarts', text: `${n} restart${n === 1 ? '' : 's'}`, tone: n ? 'warn' : 'ok' });
  }

  const crashes = [i.crashes, i.apiCrashes].filter((c): c is CrashResult => c != null);
  if (crashes.length) {
    const n = crashes.reduce((sum, c) => sum + crashTotals(c).total, 0);
    out.push({ key: 'crashes', text: `${n} crash${n === 1 ? '' : 'es'}`, tone: n ? 'bad' : 'ok' });
  }
  return out;
}
