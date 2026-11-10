import type { ReleaseEvent } from '@shared/types/azureMetrics.types';
import type { TimelineItem, TimelineLane } from './incidentTimeline';
import { HTTP_5XX_RATE } from './appRemarks';
import { formatSgt } from './rcaHtml';

/**
 * Remarks as a short story of the whole range, built from the same lanes the Incident
 * Timeline draws: what happened, when, how it lines up with releases, restarts and
 * crashes, and whether it keeps coming back. Pure; every line is a fact the card holds.
 */

export type StoryTone = 'ok' | 'info' | 'warning' | 'critical';

export type StoryAction =
  | { kind: '5xx'; label: string; startMs: number; endMs: number; site: 'fe' | 'api' }
  | { kind: 'release'; label: string; site: 'fe' | 'api'; event: ReleaseEvent };

export interface StoryLine {
  tone: StoryTone;
  text: string;
  actions: StoryAction[];
  /** Sort key — incidents read in the order they happened. */
  at: number;
  /** Detail listed under the line, one bullet each. */
  items?: string[];
}

/** A release this long before an incident is worth naming as a possible cause. */
export const RELEASE_LINK_MS = 60 * 60 * 1000;
/** A restart this close to a crash is counted as caused by it. */
export const CRASH_LINK_MS = 10 * 60 * 1000;
/** At or past this many bursts on one site, they're summarised rather than listed. */
export const GROUP_BURSTS = 3;

const hm = (ms: number) => formatSgt(ms).slice(11, 16);
const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function duration(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** Median gap between starts, when the gaps are regular enough to call it a rhythm
 *  (coefficient of variation under 0.5). Null otherwise. Pure; exported for tests. */
export function recurrenceMs(starts: number[]): number | null {
  if (starts.length < GROUP_BURSTS) return null;
  const sorted = [...starts].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((t, i) => t - sorted[i]!);
  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (mean <= 0) return null;
  const sd = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
  if (sd / mean >= 0.5) return null;
  const mid = [...gaps].sort((a, b) => a - b);
  return mid[Math.floor(mid.length / 2)]!;
}

const SOURCE: Record<ReleaseEvent['source'], string> = { swap: 'swap', deploy: 'deploy', revision: 'revision' };

export function buildRemarkStory({ lanes, nowActive, nowItems = [], hasApi }: {
  lanes: TimelineLane[];
  /** Remarks active in the trailing bucket (`activeRemarkList` + `nowRemarkText`). */
  nowActive: string[];
  /** Detail listed under the "Right now" line: the active 4xx/5xx codes and endpoints. */
  nowItems?: string[];
  hasApi: boolean;
}): StoryLine[] {
  const lane = (key: TimelineLane['key']) => lanes.find(l => l.key === key)?.items ?? [];
  const siteName = (site: 'fe' | 'api' | undefined) => (hasApi && site ? `${site === 'fe' ? 'FE' : 'API'} ` : '');
  const releases = lane('releases').filter(r => r.release).sort((a, b) => a.startMs - b.startMs);

  const releaseLabel = (r: TimelineItem) => `${hm(r.startMs)} ${siteName(r.site)}${SOURCE[r.release!.event.source]}`;
  const verdict = (r: TimelineItem): StoryAction =>
    ({ kind: 'release', label: `Verdict ${hm(r.startMs)}`, site: r.release!.site, event: r.release!.event });

  /** Text and action for the latest release shortly before `startMs`, if any. */
  const linkRelease = (startMs: number): { text: string; actions: StoryAction[] } => {
    const r = [...releases].reverse().find(x => x.startMs <= startMs && startMs - x.startMs <= RELEASE_LINK_MS);
    if (!r) return { text: '', actions: [] };
    const mins = Math.round((startMs - r.startMs) / 60000);
    return { text: ` — began ${mins < 1 ? 'right' : `${mins} min`} after the ${releaseLabel(r)}`, actions: [verdict(r)] };
  };

  const incidents: StoryLine[] = [];

  for (const d of lane('downtime')) {
    const end = d.endMs ?? d.startMs;
    const link = linkRelease(d.startMs);
    incidents.push({ tone: 'critical', at: d.startMs, text: `Down ${hm(d.startMs)}–${hm(end)} (${duration(end - d.startMs)})${link.text}.`, actions: link.actions });
  }

  for (const key of ['http5xx', 'http5xxApi'] as const) {
    const bursts = [...lane(key)].sort((a, b) => a.startMs - b.startMs);
    if (!bursts.length) continue;
    const site = bursts[0]!.burstSite ?? (key === 'http5xxApi' ? 'api' : 'fe');
    const who = `${siteName(site)}5xx`;
    if (bursts.length >= GROUP_BURSTS) {
      const first = bursts[0]!, lastEnd = Math.max(...bursts.map(b => b.endMs ?? b.startMs));
      const total = bursts.reduce((s, b) => s + ((b.endMs ?? b.startMs) - b.startMs), 0);
      const worst = bursts.reduce((a, b) => ((b.peak ?? 0) > (a.peak ?? 0) ? b : a));
      const every = recurrenceMs(bursts.map(b => b.startMs));
      const link = linkRelease(first.startMs);
      incidents.push({
        tone: 'critical', at: first.startMs,
        text: `${who} went above ${HTTP_5XX_RATE * 100}% ${bursts.length} times between ${hm(first.startMs)} and ${hm(lastEnd)} ` +
          `(${duration(total)} in total), peaking at ${pct(worst.peak ?? 0)} at ${hm(worst.startMs)}` +
          `${every ? `, recurring roughly every ${duration(every)}` : ''}${link.text}.`,
        actions: [{ kind: '5xx', label: 'List requests', startMs: first.startMs, endMs: lastEnd, site }, ...link.actions],
      });
    } else {
      for (const b of bursts) {
        const end = b.endMs ?? b.startMs;
        const link = linkRelease(b.startMs);
        incidents.push({
          tone: 'critical', at: b.startMs,
          text: `${who} above ${HTTP_5XX_RATE * 100}% ${hm(b.startMs)}–${hm(end)} (${duration(end - b.startMs)}), peak ${pct(b.peak ?? 0)}${link.text}.`,
          actions: [{ kind: '5xx', label: 'List requests', startMs: b.startMs, endMs: end, site }, ...link.actions],
        });
      }
    }
  }

  const anomalies = lane('anomalies');
  for (const a of anomalies.filter(x => x.severity === 'Critical')) {
    const end = a.endMs ?? a.startMs;
    const link = linkRelease(a.startMs);
    incidents.push({ tone: 'critical', at: a.startMs, text: `Critical spike ${hm(a.startMs)}–${hm(end)}: ${a.cause ?? 'several metrics'} together${link.text}.`, actions: link.actions });
  }
  const warnings = anomalies.filter(x => x.severity === 'Warning');
  if (warnings.length) {
    const metrics = [...new Set(warnings.flatMap(w => (w.cause ?? '').split(' + ').filter(Boolean)))];
    incidents.push({
      tone: 'warning', at: warnings[0]!.startMs,
      text: `${plural(warnings.length, 'warning-level spike')} (${metrics.join(', ') || 'several metrics'}), first at ${hm(warnings[0]!.startMs)}.`,
      actions: [],
    });
  }

  const restarts = lane('restarts');
  const crashes = lane('crashes');
  if (restarts.length || crashes.length) {
    const nRestarts = restarts.reduce((s, r) => s + (r.count ?? 1), 0);
    const byCause = new Map<string, number>();
    for (const r of restarts) byCause.set(r.cause ?? 'restart', (byCause.get(r.cause ?? 'restart') ?? 0) + (r.count ?? 1));
    const causes = [...byCause].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ×${n}`).join(', ');
    const crashTypes = [...new Set(crashes.map(c => c.cause).filter(Boolean))].slice(0, 2).join(', ');
    const linked = restarts.filter(r => crashes.some(c => Math.abs(c.startMs - r.startMs) <= CRASH_LINK_MS)).length;
    const first = Math.min(...[...restarts, ...crashes].map(x => x.startMs));
    const parts = [
      nRestarts ? `${plural(nRestarts, 'restart')}${causes ? ` (${causes})` : ''}` : '',
      crashes.length ? `${plural(crashes.length, 'captured crash', 'captured crashes')}${crashTypes ? ` (${crashTypes})` : ''}` : '',
    ].filter(Boolean);
    const within = `within ${CRASH_LINK_MS / 60000} min of a crash`;
    const crashNote = !linked ? ''
      : linked === restarts.length && linked > 1 ? ` — every restart ${within}`
      : ` — ${plural(linked, 'restart')} ${within}`;
    const link = linkRelease(first);
    incidents.push({
      tone: crashes.length ? 'critical' : 'warning', at: first,
      text: `${parts.join(' and ')}, first at ${hm(first)}${crashNote}${link.text}.`,
      actions: link.actions,
    });
  }

  incidents.sort((a, b) => a.at - b.at);

  // "Right now" only when something is active; an all-clear there just repeats the line below.
  const lines: StoryLine[] = nowActive.length
    ? [{ tone: 'critical', at: -Infinity, text: `Right now: ${nowActive.join(', ')}.`, actions: [], ...(nowItems.length ? { items: nowItems } : {}) }, ...incidents]
    : [...incidents];
  if (!incidents.length) {
    // "Other" only when a "Right now" line sits above it.
    lines.push({ tone: 'ok', at: Infinity, text: `No ${nowActive.length ? 'other ' : ''}issues in this window. There was no downtime and there were no 5xx bursts, restarts, crashes or unusual spikes.`, actions: [] });
  }
  if (releases.length) {
    const shown = releases.slice(-3);
    lines.push({
      tone: 'info', at: Infinity,
      text: `${plural(releases.length, 'release')} in range: ${releases.map(releaseLabel).join(', ')}.`,
      actions: shown.map(verdict),
    });
  }
  return lines;
}
