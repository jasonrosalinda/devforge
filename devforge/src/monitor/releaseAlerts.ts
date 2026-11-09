// "A release regressed": the monitor notices a new production release per site and, once
// an hour of after-release data has landed, runs the Release Verdict on it. Pure state
// helpers; monitorMain does the fetching. Exported for tests.
import type { ReleaseEvent } from '@shared/types/azureMetrics.types';
import type { VerdictRow } from '@/components/azure/releaseVerdict';

/** Before vs after window, in hours (the verdict dialog's 1h choice). */
export const RELEASE_VERDICT_HOURS = 1;
/** Judge once the 1h after-window is complete plus 10 min for App Insights ingestion lag. */
export const RELEASE_JUDGE_DELAY_MS = (RELEASE_VERDICT_HOURS * 60 + 10) * 60_000;
/** Release lists cost an Activity Log + Kudu call per site, so poll them at most this often. */
export const RELEASE_POLL_MS = 10 * 60_000;
/** A verdict that keeps failing (no App Insights, no access) is dropped this long after the release. */
export const RELEASE_GIVE_UP_MS = 6 * 3_600_000;

/**
 * Keyed by `${appKey}:${site}`. `seen` holds the newest release `at` per site (null = none
 * yet); `since` when that site's baseline was taken.
 */
export interface ReleaseWatch {
  seen: Record<string, string | null>;
  since: Record<string, number>;
  pending: Record<string, ReleaseEvent>;
}

export const emptyReleaseWatch = (): ReleaseWatch => ({ seen: {}, since: {}, pending: {} });

export const watchKey = (appKey: string, site: 'fe' | 'api') => `${appKey}:${site}`;

export function parseWatchKey(key: string): { appKey: string; site: 'fe' | 'api' } {
  const i = key.lastIndexOf(':');
  return { appKey: key.slice(0, i), site: key.slice(i + 1) === 'api' ? 'api' : 'fe' };
}

/**
 * Record the newest release a site reports. The first report per site only sets the
 * baseline, and a release from before that moment is never judged, even if it shows up
 * later (say the baseline read "no releases"). A newer release replaces one still
 * waiting: the latest release is the one that counts. Call it only with a successful
 * read: a failed one is not "no releases".
 */
export function noteRelease(state: ReleaseWatch, key: string, last: ReleaseEvent | null, nowMs: number): ReleaseWatch {
  if (!(key in state.seen)) {
    return { ...state, seen: { ...state.seen, [key]: last?.at ?? null }, since: { ...state.since, [key]: nowMs } };
  }
  if (!last) return state;
  const atMs = Date.parse(last.at);
  const prior = state.seen[key];
  if (prior && atMs <= Date.parse(prior)) return state;
  const seen = { ...state.seen, [key]: last.at };
  if (atMs < (state.since[key] ?? 0)) return { ...state, seen };
  return { ...state, seen, pending: { ...state.pending, [key]: last } };
}

/** Pending releases whose after-window is complete. */
export function dueReleases(state: ReleaseWatch, nowMs: number): Array<[string, ReleaseEvent]> {
  return Object.entries(state.pending).filter(([, ev]) => Date.parse(ev.at) + RELEASE_JUDGE_DELAY_MS <= nowMs);
}

/** After a verdict attempt: judged releases leave; failed ones retry until RELEASE_GIVE_UP_MS. */
export function afterVerdict(state: ReleaseWatch, key: string, judged: boolean, nowMs: number): ReleaseWatch {
  const ev = state.pending[key];
  if (!ev) return state;
  if (!judged && nowMs - Date.parse(ev.at) < RELEASE_GIVE_UP_MS) return state;
  const pending = { ...state.pending };
  delete pending[key];
  return { ...state, pending };
}

/** Up to three worse rows, then any new exception types. */
export function releaseAlertBody(rows: VerdictRow[], newTypes: Array<{ type: string; count: number }>): string {
  const worse = rows.filter(r => r.judgement === 'worse').slice(0, 3)
    .map(r => `${r.label} ${r.beforeText} → ${r.afterText}`);
  const types = newTypes.length
    ? [`New exceptions: ${newTypes.slice(0, 3).map(t => `${t.type.split('.').pop()} (${t.count})`).join(', ')}`]
    : [];
  return [...worse, ...types].join('\n');
}
