// "Investigate this", raised by an App Health Check card. App opens the App Investigation
// tab and the page interprets the prefilled question; a request made before the page
// mounts is held. The engineer still reviews the interpretation and clicks Run.
import { createHandoff } from './handoff';
import type { TimelineLane } from '@/components/azure/incidentTimeline';
import { formatSgt } from '@/components/azure/rcaHtml';

export interface InvestigationRequest {
  appKey: string;
  query: string;
  startMs: number;
  endMs: number;
}

const handoff = createHandoff<InvestigationRequest>();
const opener = createHandoff<true>();

/** The request goes first, so a tab that mounts from the open still picks it up. */
export const requestInvestigation = (req: InvestigationRequest): void => {
  handoff.request(req);
  opener.request(true);
};

/** For the App Investigation page. Returns an unsubscribe. */
export const onInvestigationRequest = (cb: (req: InvestigationRequest) => void): (() => void) => handoff.subscribe(cb);

/** For App: open the App Investigation tab. Returns an unsubscribe. */
export const onOpenInvestigation = (cb: () => void): (() => void) => opener.subscribe(() => cb());

/** A burst can start well before the outage it causes, so the window opens early. */
const LEAD_MS = 30 * 60_000;
const TAIL_MS = 10 * 60_000;

/**
 * The question and window for one card: the downtime in range, else its worst 5xx burst,
 * else the whole range. Pure.
 */
export function buildInvestigationRequest({ appKey, appLabel, lanes, rangeStartMs, rangeEndMs }: {
  appKey: string;
  appLabel: string;
  lanes: TimelineLane[];
  rangeStartMs: number;
  rangeEndMs: number;
}): InvestigationRequest {
  const items = (key: TimelineLane['key']) => lanes.find(l => l.key === key)?.items ?? [];
  const down = items('downtime').filter(i => i.endMs != null);
  const bursts = [...items('http5xx'), ...items('http5xxApi')].filter(i => i.endMs != null)
    .sort((a, b) => (b.peak ?? 0) - (a.peak ?? 0));
  const focus = down.length ? down : bursts.slice(0, 1);
  const what = down.length ? 'downtime' : bursts.length ? '5xx burst' : null;

  const clamp = (ms: number) => Math.min(Math.max(ms, rangeStartMs), rangeEndMs);
  const startMs = focus.length ? clamp(Math.min(...focus.map(i => i.startMs)) - LEAD_MS) : rangeStartMs;
  const endMs = focus.length ? clamp(Math.max(...focus.map(i => i.endMs!)) + TAIL_MS) : rangeEndMs;
  const seen = focus.length
    ? `${what} ${formatSgt(Math.min(...focus.map(i => i.startMs)))} → ${formatSgt(Math.max(...focus.map(i => i.endMs!)))}`
    : null;

  return {
    appKey,
    startMs,
    endMs,
    query: `Investigate ${appLabel} (${appKey}) from ${formatSgt(startMs)} to ${formatSgt(endMs)}.`
      + (seen ? ` App Health Check shows ${seen}: find what caused it.` : ' Find the cause of any errors, slowness or downtime in this window.'),
  };
}
