import { describe, it, expect, vi } from 'vitest';
import { buildInvestigationRequest, onInvestigationRequest, onOpenInvestigation, requestInvestigation } from './investigation-request';
import type { TimelineLane } from '@/components/azure/incidentTimeline';

const MIN = 60_000;
const T0 = Date.parse('2026-11-10T06:00:00Z'); // 14:00 SGT
const range = { appKey: 'prdmeduapp', appLabel: 'MIMS CPD', rangeStartMs: T0 - 120 * MIN, rangeEndMs: T0 + 120 * MIN };
const lane = (key: TimelineLane['key'], items: TimelineLane['items']): TimelineLane => ({ key, label: key, items });

describe('buildInvestigationRequest', () => {
  it('focuses on the downtime, opening 30 min early for a burst that led into it', () => {
    const req = buildInvestigationRequest({ ...range, lanes: [
      lane('downtime', [{ startMs: T0, endMs: T0 + 15 * MIN, title: '', color: '' }]),
      lane('http5xx', [{ startMs: T0 - 60 * MIN, endMs: T0 - 50 * MIN, peak: 0.5, title: '', color: '' }]),
    ] });
    expect(req.startMs).toBe(T0 - 30 * MIN);
    expect(req.endMs).toBe(T0 + 25 * MIN);
    expect(req.query).toBe('Investigate MIMS CPD (prdmeduapp) from 2026-11-10 13:30 SGT to 2026-11-10 14:25 SGT. '
      + 'App Health Check shows downtime 2026-11-10 14:00 SGT → 2026-11-10 14:15 SGT: find what caused it.');
  });

  it('falls back to the worst 5xx burst on either site, clipped to the range', () => {
    const req = buildInvestigationRequest({ ...range, lanes: [
      lane('http5xx', [{ startMs: T0 - 110 * MIN, endMs: T0 - 100 * MIN, peak: 0.08, title: '', color: '' }]),
      lane('http5xxApi', [{ startMs: T0 - 115 * MIN, endMs: T0 - 105 * MIN, peak: 0.4, title: '', color: '' }]),
    ] });
    expect(req.startMs).toBe(range.rangeStartMs);
    expect(req.endMs).toBe(T0 - 95 * MIN);
    expect(req.query).toContain('shows 5xx burst');
  });

  it('uses the whole range when nothing stands out', () => {
    const req = buildInvestigationRequest({ ...range, lanes: [] });
    expect([req.startMs, req.endMs]).toEqual([range.rangeStartMs, range.rangeEndMs]);
    expect(req.query).toMatch(/Find the cause of any errors/);
  });
});

describe('investigation handoff', () => {
  it('holds the request for a page that mounts after the tab opens', () => {
    const open = vi.fn();
    const offOpen = onOpenInvestigation(open);
    requestInvestigation({ appKey: 'a', query: 'q', startMs: 1, endMs: 2 });
    expect(open).toHaveBeenCalledTimes(1);
    const got = vi.fn();
    const off = onInvestigationRequest(got);
    expect(got).toHaveBeenCalledWith({ appKey: 'a', query: 'q', startMs: 1, endMs: 2 });
    off(); offOpen();
  });
});
