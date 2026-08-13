import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { RestartResult } from '@shared/types/azureMetrics.types';
import { EventBarChart, INSTANCE_PALETTE } from './azureMetricChart';
import { CellSkeleton, PanelSkeleton } from './loadingSkeleton';

/**
 * Application restart events, from the portal's restart-analysis detector.
 *
 * A restart is invisible in every other signal on the card — traffic dips, latency
 * spikes, and nothing says the process died. The cause matters more than the count:
 * a Kudu kill is a person, an App Crash is the application faulting, and Platform
 * Healing is Azure restarting a worker it judged unhealthy. Same symptom, three
 * completely different investigations.
 *
 * Per site, so the frontend and the API each get their own row.
 */

/** Cause → colour. Anything unrecognised falls through to the shared palette. */
const CAUSE_COLORS: Array<[RegExp, string]> = [
  [/kudu|manual|process explorer/i, '#22d3ee'],   // someone did this deliberately
  [/crash|fault|unhandled/i, '#f85149'],           // the application broke
  [/healing|platform|unhealthy/i, '#f97316'],      // Azure intervened
  [/scale|swap|deploy|config/i, '#a371f7'],        // an expected lifecycle event
];

export function causeColor(cause: string, fallbackIdx = 0): string {
  for (const [re, color] of CAUSE_COLORS) if (re.test(cause)) return color;
  return INSTANCE_PALETTE[fallbackIdx % INSTANCE_PALETTE.length] ?? '#8b9ab3';
}

/** Total restarts per cause across the window. Pure. */
export function restartTotals(
  restarts: RestartResult | null | undefined,
): { total: number; byCause: Array<{ cause: string; count: number }> } {
  const chart = restarts?.charts?.find(c => /restart/i.test(c.title)) ?? restarts?.charts?.[0];
  const fromChart = (chart?.series ?? [])
    .map(s => ({ cause: s.name, count: s.series.reduce((sum, p) => sum + (p.count ?? 0), 0) }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count);
  if (fromChart.length) {
    return { total: fromChart.reduce((sum, c) => sum + c.count, 0), byCause: fromChart };
  }

  // "We analyzed 6 Kudu Kill Events…" wins where it exists: the prose describes a
  // sample of the events, but that headline counts all of them.
  const prose = proseOf(restarts);
  const headline = parseRestartHeadline(prose).sort((a, b) => b.count - a.count);
  if (headline.length) {
    return { total: headline.reduce((sum, c) => sum + c.count, 0), byCause: headline };
  }

  const counted = new Map<string, number>();
  for (const e of parseRestartProse(prose)) counted.set(e.cause, (counted.get(e.cause) ?? 0) + e.count);
  const byCause = [...counted.entries()].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count);
  return { total: byCause.reduce((sum, c) => sum + c.count, 0), byCause };
}

// The causes the detector writes about, longest first so "Platform Healing Your
// App" is not matched as "App".
const CAUSE_NAMES = ['Platform Healing Your App', 'Kudu Kill(w3wp)', 'Kudu Kill', 'App Crash', 'Site Stopped', 'Config Change'];
const CAUSE_ALT = CAUSE_NAMES.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/**
 * Events pulled out of the detector's prose.
 *
 * The `webappstart` detector — the one that actually answers on real sites — does
 * not publish a per-cause table. It publishes one paragraph: "We analyzed 6 Kudu
 * Kill Events... Kudu Kill(w3wp) Around 07/29/2026 09:31:20 (UTC), on Instance
 * WN0SDWK000KFZ, your application process was terminated...". Every fact a reader
 * wants is in there; it is just unreadable as a block of text.
 *
 * Pure, and deliberately conservative: the original prose stays on screen, so
 * anything this fails to parse is still readable rather than silently lost.
 */
export function parseRestartProse(text: string): RestartEvent[] {
  const events: RestartEvent[] = [];

  // "<Cause> Around 07/29/2026 09:31:20 (UTC), on Instance WN0SDWK000KFZ"
  const dated = new RegExp(
    '(' + CAUSE_ALT + ')\\s+Around\\s+(\\d{1,2}/\\d{1,2}/\\d{4}\\s+\\d{1,2}:\\d{2}:\\d{2})\\s*\\(UTC\\)[,\\s]*on Instance\\s+([A-Za-z0-9_-]+)',
    'gi');
  for (const m of text.matchAll(dated)) {
    const iso = usDateToIso(m[2] ?? '');
    events.push({
      t: iso ?? '',
      cause: canonicalCause(m[1] ?? ''),
      count: 1,
      ...(m[3] ? { instance: m[3] } : {}),
    });
  }

  // The undated variant: "<Cause> On Instance WN0SDWK000K9R, ... This event occurred
  // multiple times during the day." Azure publishes no timestamps for those at all.
  const undated = new RegExp('(' + CAUSE_ALT + ')\\s+On Instance\\s+([A-Za-z0-9_-]+)', 'gi');
  for (const m of text.matchAll(undated)) {
    const instance = m[2] ?? '';
    const cause = canonicalCause(m[1] ?? '');
    if (events.some(e => e.cause === cause && e.instance === instance)) continue;
    events.push({ t: '', cause, count: 1, instance, undated: true });
  }

  // Newest first, with the undated ones last: they have no place on a timeline.
  return events.sort((a, b) => (a.t && b.t ? (a.t < b.t ? 1 : -1) : a.t ? -1 : 1));
}

/** "We analyzed `6` Kudu Kill Events, `1` App Crash Event." → totals per cause. */
export function parseRestartHeadline(text: string): Array<{ cause: string; count: number }> {
  const out: Array<{ cause: string; count: number }> = [];
  // The backticks are the detector's own emphasis around each figure.
  for (const m of text.matchAll(/`?(\d+)`?\s+([A-Za-z()\s]+?)\s+Events?\b/g)) {
    const count = Number(m[1]);
    const cause = canonicalCause((m[2] ?? '').trim());
    if (count > 0 && cause) out.push({ cause, count });
  }
  return out;
}

/** Collapses the detector's several spellings onto one name per cause. */
function canonicalCause(raw: string): string {
  const t = raw.trim();
  if (/kudu/i.test(t)) return 'Kudu Kill(w3wp)';
  if (/crash/i.test(t)) return 'App Crash';
  if (/healing/i.test(t)) return 'Platform Healing Your App';
  return t;
}

/** "07/29/2026 09:31:20" (UTC) → ISO. Null when it does not parse. */
function usDateToIso(s: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The detector's findings as one string, minus the boilerplate advice block. */
export function proseOf(restarts: RestartResult | null | undefined): string {
  return (restarts?.insights ?? [])
    .flatMap(f => f.items.filter(i => !/additional information/i.test(i.name)).map(i => i.text))
    .join(' ');
}

/** One restart, as a reader would describe it. */
export interface RestartEvent {
  /** ISO timestamp, or empty when the detector reported the event without one. */
  t: string;
  cause: string;
  count: number;
  /** Worker the detector named, when its prose mentions one. */
  instance?: string | undefined;
  /** Reported as recurring, with no times published for the individual events. */
  undated?: boolean | undefined;
}

/**
 * The timeline flattened into a list of events, newest first.
 *
 * Four restarts spread over an hour are four facts with times attached; a chart of
 * them is a shape you then have to read times off. Both are shown — the chart for
 * "when, relative to everything else on the card", the list for "what happened".
 */
export function restartEvents(restarts: RestartResult | null | undefined): RestartEvent[] {
  const chart = restarts?.charts?.find(c => /restart/i.test(c.title)) ?? restarts?.charts?.[0];
  const instances = instancesByCause(restarts);
  const events: RestartEvent[] = [];
  for (const s of chart?.series ?? []) {
    for (const p of s.series) {
      if (!p.count) continue;
      const inst = instances.get(s.name);
      events.push({ t: p.t, cause: s.name, count: p.count, ...(inst ? { instance: inst } : {}) });
    }
  }
  // A published timeline is the exception; on real sites the events live in the
  // prose, so it is read whenever the chart came back empty.
  if (!events.length) return parseRestartProse(proseOf(restarts));
  return events.sort((a, b) => (a.t < b.t ? 1 : -1));
}

/**
 * Worker names pulled out of the detector's prose, keyed by cause.
 *
 * The timeline says when and how many; only the prose says which instance, and it
 * is the instance that decides whether this was one sick worker or the whole plan.
 */
export function instancesByCause(restarts: RestartResult | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const finding of restarts?.insights ?? []) {
    for (const item of finding.items) {
      const m = /instance\s+([A-Za-z0-9_-]{4,})/i.exec(item.text);
      if (m?.[1] && !out.has(item.name)) out.set(item.name, m[1]);
    }
  }
  return out;
}

const SGT = { timeZone: 'Asia/Singapore' } as const;
const fmtEventTime = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { ...SGT, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function RestartPanel({
  restarts, loading, syncId,
}: {
  restarts: RestartResult | null | undefined;
  loading: boolean;
  syncId?: string | undefined;
}) {
  if (loading && !restarts) {
    return <PanelSkeleton rows={4} chartHeight={90} />;
  }
  if (!restarts) {
    return <div style={{ fontSize: 10, color: 'var(--muted-foreground)', fontStyle: 'italic', padding: '6px 8px' }}>Restart analysis unavailable for this site.</div>;
  }

  const { total, byCause } = restartTotals(restarts);
  const events = restartEvents(restarts);
  const chart = restarts.charts?.find(c => /restart/i.test(c.title)) ?? restarts.charts?.[0];
  const plotted = (chart?.series ?? []).filter(s => s.series.some(p => p.count > 0));
  const findings = restarts.insights ?? [];

  return (
    <div style={{ fontSize: 10, padding: '2px 8px 4px' }}>
      {total === 0 && findings.length === 0 && (
        <div style={{ color: '#3fb950', padding: '4px 0' }}>No restarts in this window.</div>
      )}

      {plotted.length > 0 && (
        <>
          {/* Bars rather than lines: a line between two restarts implies the value
              travelled through the space between them, when nothing happened there. */}
          <EventBarChart
            series={plotted.map(s => ({ name: s.name, series: s.series }))}
            colors={plotted.map((s, i) => causeColor(s.name, i))}
            height={110}
            syncId={syncId}
            valueLabel="restarts"
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, paddingLeft: 8, marginTop: 2 }}>
            {byCause.map((c, i) => (
              <span key={c.cause} style={{ color: '#6e7681', whiteSpace: 'nowrap' }}>
                <span style={{ color: causeColor(c.cause, i) }}>■</span> {c.cause}
                <span style={{ color: '#484f58' }}> {c.count.toLocaleString()}</span>
              </span>
            ))}
          </div>
        </>
      )}

      {/* Cause totals, shown even without a chart: the counts come from the detector's
          headline ("We analyzed 6 Kudu Kill Events"), which is authoritative for the
          window even when it publishes no timeline to plot. */}
      {plotted.length === 0 && byCause.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 4 }}>
          {byCause.map(c => (
            <span key={c.cause} style={{ whiteSpace: 'nowrap' }}>
              <span style={{ color: causeColor(c.cause), fontWeight: 600 }}>{c.count.toLocaleString()}</span>
              <span style={{ color: '#6e7681' }}> {c.cause}</span>
            </span>
          ))}
        </div>
      )}

      {/* The events themselves, newest first. This is what gets read out loud in an
          incident: a time, a cause, and the worker it happened on. */}
      {events.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 130px', gap: 8, color: '#6e7681', marginBottom: 2 }}>
            <span>When (SGT)</span><span>Cause</span><span>Instance</span>
          </div>
          {events.slice(0, 20).map((e, i) => (
            <div key={`${e.t}-${e.cause}-${e.instance ?? ''}-${i}`} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 130px', gap: 8, marginBottom: 1 }}>
              {/* Azure reports some events as "occurred multiple times during the day"
                  with no timestamps at all. Saying so beats inventing a time. */}
              <span className="tabular-nums" style={{ color: e.t ? '#cdd9e5' : '#484f58' }}>
                {e.t ? fmtEventTime(e.t) : 'recurring'}
              </span>
              <span style={{ color: causeColor(e.cause) }}>
                {e.cause}{e.count > 1 ? <span style={{ color: '#484f58' }}> ×{e.count}</span> : null}
              </span>
              <span style={{ color: '#6e7681', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.instance ?? '—'}</span>
            </div>
          ))}
          {events.length > 20 && (
            <div style={{ color: '#484f58', marginTop: 2 }}>+{events.length - 20} more events in this window.</div>
          )}
        </div>
      )}

    </div>
  );
}

/**
 * The Restarts row as it sits inside a FE / API section table.
 *
 * The collapsed row leads with the cause rather than the count: three restarts all
 * from a deploy is routine, three from crashes is an incident.
 */
export function RestartRows({
  restarts, loading, expanded, onToggle, syncId,
}: {
  restarts: RestartResult | null | undefined;
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
  syncId?: string | undefined;
}) {
  const { total, byCause } = restartTotals(restarts);
  const top = byCause[0];
  const crashy = byCause.some(c => /crash|healing|unhealthy/i.test(c.cause));

  return (
    <>
      <tr
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td className="text-muted-foreground font-bold" title="Application restart events from App Service Diagnostics: Kudu kills (someone restarted it), app crashes (the process faulted), and platform healing (Azure restarted an unhealthy worker). A restart is invisible in the other signals — traffic just dips.">
          Restarts
          {expanded
            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
        </td>
        <td className="text-right tabular-nums" colSpan={2} style={{ whiteSpace: 'nowrap', color: '#8b9ab3', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {loading && !restarts
            ? <CellSkeleton w={120} />
            : top
              ? <span style={{ color: causeColor(top.cause) }}>{top.cause} ×{top.count.toLocaleString()}{byCause.length > 1 ? ` +${byCause.length - 1} more` : ''}</span>
              : restarts ? 'no restarts' : '—'}
        </td>
        <td className="text-right tabular-nums" style={{ whiteSpace: 'nowrap', color: total === 0 ? '#3fb950' : crashy ? 'hsl(var(--destructive))' : '#d29922' }}>
          {loading && !restarts ? <CellSkeleton w={58} /> : restarts ? `${total.toLocaleString()} restart${total === 1 ? '' : 's'}` : '—'}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
            <RestartPanel restarts={restarts} loading={loading} syncId={syncId} />
          </td>
        </tr>
      )}
    </>
  );
}
