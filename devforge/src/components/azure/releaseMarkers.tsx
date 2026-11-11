import { createContext, useContext } from 'react';
import { ReferenceArea, ReferenceLine } from 'recharts';
import type { ReleaseEvent, ReleaseResult } from '@shared/types/azureMetrics.types';
import { RELEASE_COLORS } from '@/lib/chart-colors';
import { circled, type EvidenceMarker } from '@/lib/evidence-markers';
import { formatSgt } from './rcaHtml';

/**
 * Release markers — a vertical line on every time chart of a card at the moment a
 * release reached production, so a change in CPU, restarts or errors can be read as
 * "before" and "after" the release.
 *
 * Supplied through context rather than props: the card's charts sit under a dozen
 * section components (restarts, crashes, SNAT, performance, users…), and threading a
 * prop through each of them for something every chart draws identically would touch
 * every one of those signatures for no gain.
 */
export interface ReleaseMarkerSet {
  fe: ReleaseEvent[];
  api: ReleaseEvent[];
  /** Labels name the site only when the card has two of them. */
  hasApi: boolean;
  /** App Investigation only: its numbered Evidences bullets, drawn at their moments. */
  evidence?: EvidenceMarker[] | undefined;
}

const NONE: ReleaseMarkerSet = { fe: [], api: [], hasApi: false };
const EVIDENCE_COLOR = 'hsl(var(--primary))';

/** Each evidence marker snapped to this chart's buckets; dropped when it falls outside. Pure; exported for tests. */
export function evidenceMarks(markers: readonly EvidenceMarker[] | undefined, stamps: readonly string[]): Array<{ n: number; x: string; x2: string | null; label: string }> {
  const out: Array<{ n: number; x: string; x2: string | null; label: string }> = [];
  for (const m of markers ?? []) {
    const x = snapToStamp(stamps, m.atMs);
    if (!x) continue;
    const x2 = m.endMs != null ? snapToStamp(stamps, m.endMs) : null;
    out.push({ n: m.n, x, x2: x2 && x2 !== x ? x2 : null, label: m.label });
  }
  return out;
}

export const ReleaseMarkersContext = createContext<ReleaseMarkerSet>(NONE);

/** Smallest gap between consecutive stamps — the chart's bucket width. */
function bucketMs(stamps: readonly string[]): number {
  let min = Infinity;
  for (let i = 1; i < stamps.length; i++) {
    const d = Date.parse(stamps[i]!) - Date.parse(stamps[i - 1]!);
    if (d > 0 && d < min) min = d;
  }
  return Number.isFinite(min) ? min : 0;
}

/**
 * The x value (a data stamp) of the bucket holding `ms`, or null when `ms` falls
 * outside the chart. Exported for tests.
 *
 * The charts use a category axis over the series' own `t` strings, so a ReferenceLine
 * only draws at a value that IS one of those strings. Floor, not nearest: Azure stamps
 * mark the start of a bucket, so a 09:40 release lives in the 09:00 bucket of an hourly
 * chart — rounding it to 10:00 would put the marker after the effect it caused.
 */
export function snapToStamp(stamps: readonly string[], ms: number): string | null {
  if (!stamps.length || !Number.isFinite(ms)) return null;
  const first = Date.parse(stamps[0]!);
  const last = Date.parse(stamps[stamps.length - 1]!);
  if (ms < first || ms >= last + Math.max(bucketMs(stamps), 1)) return null;
  let hit: string | null = null;
  for (const s of stamps) {
    if (Date.parse(s) <= ms) hit = s;
    else break;
  }
  return hit;
}

const SGT_HM: Intl.DateTimeFormatOptions = { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/**
 * One marker per site per bucket, ready to draw. Pure; exported for tests.
 *
 * Two releases in the same bucket would draw on top of each other, so they merge,
 * keeping the latest time for the label.
 */
export function markerLines(set: ReleaseMarkerSet, stamps: readonly string[]): Array<{ x: string; site: 'fe' | 'api'; label: string }> {
  const bySite = { fe: new Map<string, ReleaseEvent>(), api: new Map<string, ReleaseEvent>() };
  for (const site of ['fe', 'api'] as const) {
    for (const ev of set[site]) {
      const x = snapToStamp(stamps, Date.parse(ev.at));
      if (x) bySite[site].set(x, ev);
    }
  }
  const hm = (ev: ReleaseEvent) => new Date(ev.at).toLocaleTimeString('en-GB', SGT_HM);
  const out: Array<{ x: string; site: 'fe' | 'api'; label: string }> = [];
  for (const [x, fe] of bySite.fe) {
    const api = bySite.api.get(x);
    if (!api) {
      out.push({ x, site: 'fe', label: `${set.hasApi ? 'FE' : 'Release'} ${hm(fe)}` });
      continue;
    }
    // A pipeline usually ships FE and API minutes apart, into the same bucket. Two
    // lines there draw as one and their labels print over each other, so they share
    // one line that names both.
    bySite.api.delete(x);
    out.push({ x, site: 'fe', label: hm(fe) === hm(api) ? `FE · API ${hm(fe)}` : `FE ${hm(fe)} · API ${hm(api)}` });
  }
  for (const [x, api] of bySite.api) out.push({ x, site: 'api', label: `API ${hm(api)}` });
  return out;
}

/**
 * Drop inside any Recharts cartesian chart whose x axis is the `t` stamps. `showLabel`
 * is for the large CombinedChart only — on the 110px block charts a label per line
 * crowds out the data it is meant to explain.
 */
export function ReleaseMarkers({ stamps, yAxisId, showLabel = false }: {
  stamps: readonly string[];
  yAxisId?: string;
  showLabel?: boolean;
}) {
  const set = useContext(ReleaseMarkersContext);
  if (!set.fe.length && !set.api.length && !set.evidence?.length) return null;
  const axis = yAxisId ? { yAxisId } : {};
  return (
    <>
      {/* Numbered on every chart, not only the large one: the number is what ties the mark to its bullet. */}
      {evidenceMarks(set.evidence, stamps).map(m => [
        m.x2 && <ReferenceArea key={`eva_${m.n}`} {...axis} x1={m.x} x2={m.x2} fill={EVIDENCE_COLOR} fillOpacity={0.04} strokeOpacity={0} ifOverflow="hidden" />,
        <ReferenceLine
          key={`ev_${m.n}`}
          x={m.x}
          {...axis}
          stroke={EVIDENCE_COLOR}
          strokeWidth={1}
          strokeOpacity={0.7}
          label={{ value: circled(m.n), position: 'insideTopRight' as const, fill: EVIDENCE_COLOR, fontSize: 11, fontWeight: 600 }}
        />,
      ])}
      {markerLines(set, stamps).map(m => (
        <ReferenceLine
          key={`${m.site}_${m.x}`}
          x={m.x}
          {...(yAxisId ? { yAxisId } : {})}
          stroke={RELEASE_COLORS[m.site]}
          strokeWidth={1.5}
          strokeDasharray={m.site === 'fe' ? '6 3' : '2 3'}
          {...(showLabel ? { label: { value: `▲ ${m.label}`, position: 'insideTopLeft' as const, fill: RELEASE_COLORS[m.site], fontSize: 10 } } : {})}
        />
      ))}
    </>
  );
}

export const SOURCE_LABEL: Record<ReleaseEvent['source'], string> = { swap: 'slot swap', deploy: 'deploy', revision: 'new revision' };

/** Hover text for one release: what, when, which build, by whom. Pure; exported for tests. */
export function releaseTitle(ev: ReleaseEvent): string {
  return [
    `${formatSgt(Date.parse(ev.at))} · ${SOURCE_LABEL[ev.source]}`,
    ev.build ? `Build ${ev.build}` : null,
    ev.commit ? `Commit ${ev.commit}` : null,
    ev.branch ? `Branch ${ev.branch}` : null,
    ev.by ? `By ${ev.by}` : null,
    ev.message ?? null,
  ].filter(Boolean).join('\n');
}

/**
 * What the header says about one site. Pure; exported for tests.
 *
 * "n/a" only when every source was refused — that is a missing Reader role, which the
 * engineer can fix, and must not read as "this app has never been released".
 */
export function releaseStatus(r: ReleaseResult | null | undefined): { text: string; title: string } | null {
  if (!r) return null;
  if (r.last) return { text: formatSgt(Date.parse(r.last.at)), title: releaseTitle(r.last) };
  const states = Object.values(r.sources);
  if (states.length && states.every(s => s === 'denied')) {
    return { text: 'n/a', title: 'No access to the Activity Log or deployment history — needs Reader on the resource group' };
  }
  return { text: 'none in 30 days', title: 'No slot swap or deployment found in the last 30 days' };
}

/** One site's "Last release", in the header of its own Frontend / API section. */
export function SiteReleaseLabel({ loading, result, onClick }: {
  loading: boolean;
  result: ReleaseResult | null | undefined;
  /** Opens the Release Verdict for the last release; only offered when there is one. */
  onClick?: ((event: ReleaseEvent) => void) | undefined;
}) {
  if (loading) return <span className="text-xs font-normal text-muted-foreground">Last release …</span>;
  const st = releaseStatus(result);
  if (!st) return null;
  const last = result?.last;
  if (last && onClick) {
    return (
      <button
        type="button"
        onClick={e => { e.stopPropagation(); onClick(last); }}
        title={`${st.title}\n\nClick for the release verdict`}
        className="text-xs font-normal text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        Last release <span className="text-foreground">{st.text}</span>
      </button>
    );
  }
  return (
    <span className="text-xs font-normal text-muted-foreground" title={st.title}>
      Last release <span className="text-foreground">{st.text}</span>
    </span>
  );
}

/** "Last release" in the card header, for the sites whose own section is not on screen
 *  — always when the card is collapsed, since it is the first thing to check when a
 *  card turns red. */
export function LastReleaseLabel({ loading, fe, api, hasApi }: {
  loading: boolean;
  fe: ReleaseResult | null | undefined;
  api: ReleaseResult | null | undefined;
  hasApi: boolean;
}) {
  if (loading) return <span className="text-xs text-muted-foreground">Last release …</span>;
  const parts = ([['FE', fe], ['API', api]] as const)
    .filter(([name]) => name === 'FE' || hasApi)
    .map(([name, r]) => ({ name, st: releaseStatus(r) }))
    .filter((p): p is { name: 'FE' | 'API'; st: { text: string; title: string } } => p.st != null);
  if (!parts.length) return null;
  return (
    <span className="text-xs text-muted-foreground">
      Last release:{' '}
      {parts.map((p, i) => (
        <span key={p.name} title={p.st.title}>
          {i > 0 && ' · '}
          {hasApi ? `${p.name} ` : ''}<span className="text-foreground">{p.st.text}</span>
        </span>
      ))}
    </span>
  );
}
