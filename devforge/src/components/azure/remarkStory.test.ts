import { describe, it, expect } from 'vitest';
import type { ReleaseEvent } from '@shared/types/azureMetrics.types';
import type { TimelineItem, TimelineLane } from './incidentTimeline';
import { buildRemarkStory, duration, recurrenceMs } from './remarkStory';

// 2026-11-05 08:00 SGT
const T0 = Date.parse('2026-11-05T00:00:00Z');
const MIN = 60_000;
const at = (m: number) => T0 + m * MIN;

const lanes = (items: Partial<Record<TimelineLane['key'], TimelineItem[]>>): TimelineLane[] =>
  (['releases', 'restarts', 'crashes', 'downtime', 'anomalies', 'http5xx', 'http5xxApi'] as const)
    .map(key => ({ key, label: key, items: items[key] ?? [] }));

const release = (m: number, site: 'fe' | 'api' = 'fe', source: ReleaseEvent['source'] = 'swap'): TimelineItem => {
  const event: ReleaseEvent = { at: new Date(at(m)).toISOString(), source };
  return { startMs: at(m), title: '', color: '', site, release: { site, event } };
};
const burst = (m: number, len: number, peak: number, site: 'fe' | 'api' = 'fe'): TimelineItem =>
  ({ startMs: at(m), endMs: at(m + len), title: '', color: '', burstSite: site, site, peak });

const story = (items: Parameters<typeof lanes>[0], nowActive: string[] = [], hasApi = true) =>
  buildRemarkStory({ lanes: lanes(items), nowActive, hasApi });

describe('buildRemarkStory', () => {
  it('reads a quiet window as quiet', () => {
    expect(story({}).map(l => [l.tone, l.text])).toEqual([
      ['ok', 'Right now: all clear.'],
      ['ok', 'Nothing else in this window: no downtime, 5xx bursts, restarts, crashes or unusual spikes.'],
    ]);
  });

  it('opens with what is active right now', () => {
    expect(story({}, ['CPU spike (1 spike)', 'memory pressure'])[0]).toMatchObject({
      tone: 'critical', text: 'Right now: CPU spike (1 spike), memory pressure.',
    });
  });

  it('ties a 5xx burst to the release shortly before it, with both actions', () => {
    const lines = story({ releases: [release(0, 'fe')], http5xxApi: [burst(6, 30, 0.12, 'api')] });
    const line = lines.find(l => l.text.startsWith('API 5xx'))!;
    expect(line.text).toBe('API 5xx above 5% 08:06–08:36 (30 min), peak 12.0% — began 6 min after the 08:00 FE swap.');
    expect(line.actions.map(a => a.kind)).toEqual(['5xx', 'release']);
    expect(line.actions[0]).toMatchObject({ startMs: at(6), endMs: at(36), site: 'api' });
  });

  it('does not blame a release more than an hour before', () => {
    const lines = story({ releases: [release(0)], http5xx: [burst(90, 5, 0.06)] });
    expect(lines.find(l => l.text.startsWith('FE 5xx'))!.text).not.toContain('after the');
  });

  it('summarises many bursts and spots a regular rhythm', () => {
    const bursts = [0, 20, 40, 60, 80].map((m, i) => burst(m, 5, i === 2 ? 0.2 : 0.07));
    const line = story({ http5xx: bursts }, [], false).find(l => l.text.startsWith('5xx'))!;
    expect(line.text).toBe('5xx went above 5% 5 times between 08:00 and 09:25 (25 min in total), peaking at 20.0% at 08:40, recurring roughly every 20 min.');
    expect(line.actions[0]).toMatchObject({ kind: '5xx', label: 'List requests', startMs: at(0), endMs: at(85), site: 'fe' });
  });

  it('pairs restarts with nearby crashes and names the causes', () => {
    const lines = story({
      restarts: [
        { startMs: at(10), title: '', color: '', count: 2, cause: 'Kudu Kill' },
        { startMs: at(50), title: '', color: '', count: 1, cause: 'App Crash' },
      ],
      crashes: [{ startMs: at(48), title: '', color: '', cause: 'System.OutOfMemoryException' }],
    });
    const line = lines.find(l => l.text.includes('restart'))!;
    expect(line.tone).toBe('critical');
    expect(line.text).toBe('3 restarts (Kudu Kill ×2, App Crash ×1) and 1 captured crash (System.OutOfMemoryException), first at 08:10 — 1 restart within 10 min of a crash.');
  });

  it('says every restart when all of them sit next to a crash, and is a warning without crashes', () => {
    const crash = (m: number): TimelineItem => ({ startMs: at(m), title: '', color: '', cause: 'X' });
    const r = (m: number): TimelineItem => ({ startMs: at(m), title: '', color: '', count: 1, cause: 'App Crash' });
    expect(story({ restarts: [r(10), r(30)], crashes: [crash(12), crash(31)] }).find(l => l.text.includes('restart'))!.text)
      .toContain('— every restart within 10 min of a crash.');
    expect(story({ restarts: [r(10)] }).find(l => l.text.includes('restart'))).toMatchObject({ tone: 'warning', text: '1 restart (App Crash ×1), first at 08:10.' });
  });

  it('lists critical spikes on their own and folds warnings into one line', () => {
    const lines = story({ anomalies: [
      { startMs: at(5), endMs: at(15), title: '', color: '', severity: 'Warning', cause: 'CPU + Memory' },
      { startMs: at(30), endMs: at(40), title: '', color: '', severity: 'Critical', cause: 'CPU + DB CPU' },
      { startMs: at(60), endMs: at(65), title: '', color: '', severity: 'Warning', cause: 'CPU' },
    ] });
    expect(lines.map(l => l.text)).toEqual([
      'Right now: all clear.',
      '2 warning-level spikes (CPU, Memory), first at 08:05.',
      'Critical spike 08:30–08:40: CPU + DB CPU together.',
    ]);
  });

  it('orders incidents by when they started and ends with the releases', () => {
    const lines = story({
      downtime: [{ startMs: at(120), endMs: at(125), title: '', color: '' }],
      http5xx: [burst(30, 10, 0.1)],
      releases: [release(0), release(200, 'api', 'deploy')],
    });
    expect(lines.map(l => l.text.split(' ')[0])).toEqual(['Right', 'FE', 'Down', '2']);
    expect(lines.at(-1)).toMatchObject({ tone: 'info', text: '2 releases in range: 08:00 FE swap, 11:20 API deploy.' });
    expect(lines.at(-1)!.actions.map(a => a.label)).toEqual(['Verdict 08:00', 'Verdict 11:20']);
  });
});

describe('recurrenceMs', () => {
  it('finds a regular rhythm and refuses an irregular one', () => {
    expect(recurrenceMs([0, 20, 40, 61].map(at))).toBe(20 * MIN);
    expect(recurrenceMs([0, 2, 60, 61].map(at))).toBeNull();
    expect(recurrenceMs([0, 20].map(at))).toBeNull();
  });
});

describe('duration', () => {
  it.each([[30_000, '1 min'], [45 * MIN, '45 min'], [60 * MIN, '1h'], [190 * MIN, '3h 10m']])('%i → %s', (ms, text) => {
    expect(duration(ms)).toBe(text);
  });
});
