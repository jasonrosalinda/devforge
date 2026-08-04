import { describe, it, expect } from 'vitest';
import { restartEvents, instancesByCause, restartTotals, causeColor, parseRestartProse, parseRestartHeadline, proseOf } from './restartSection';
import type { RestartResult } from '@shared/types/azureMetrics.types';

const restarts: RestartResult = {
  detector: 'apprestartanalyses',
  charts: [{
    title: 'App Restart Events Timeline',
    series: [
      { name: 'Kudu Kill(w3wp)', series: [
        { t: '2026-07-29T09:05:00Z', count: 2 },
        { t: '2026-07-29T09:15:00Z', count: 0 },
        { t: '2026-07-29T09:30:00Z', count: 2 },
      ] },
      { name: 'App Crash', series: [{ t: '2026-07-29T09:25:00Z', count: 1 }] },
    ],
  }],
  insights: [{
    status: 'Critical',
    message: 'Application stop events are detected',
    items: [
      { name: 'Kudu Kill(w3wp)', html: '', text: 'On Instance WN0SDWK000K9R, your application process (w3wp.exe) was terminated by Kudu REST API.' },
      { name: 'App Crash', html: '', text: 'Around 07/29/2026 09:25:34 (UTC), on Instance WN0SDWK000KFZ, your application process experienced a crash.' },
    ],
  }],
};

describe('restartEvents', () => {
  it('flattens the timeline into events, newest first', () => {
    const out = restartEvents(restarts);
    expect(out.map(e => [e.cause, e.count])).toEqual([
      ['Kudu Kill(w3wp)', 2],
      ['App Crash', 1],
      ['Kudu Kill(w3wp)', 2],
    ]);
    expect(out[0]!.t).toBe('2026-07-29T09:30:00Z');
  });

  it('drops empty buckets — they are the absence of an event, not an event', () => {
    expect(restartEvents(restarts).every(e => e.count > 0)).toBe(true);
  });

  it('attaches the worker the detector named', () => {
    const out = restartEvents(restarts);
    expect(out.find(e => e.cause === 'App Crash')!.instance).toBe('WN0SDWK000KFZ');
    expect(out.find(e => e.cause === 'Kudu Kill(w3wp)')!.instance).toBe('WN0SDWK000K9R');
  });

  it('leaves the instance unset when the prose does not name one', () => {
    const bare: RestartResult = { charts: restarts.charts };
    expect(restartEvents(bare)[0]!.instance).toBeUndefined();
  });

  it('handles a site with no restart data', () => {
    expect(restartEvents(null)).toEqual([]);
    expect(restartEvents({ charts: [] })).toEqual([]);
  });
});

describe('instancesByCause', () => {
  it('keeps the first worker named for each cause', () => {
    const map = instancesByCause(restarts);
    expect(map.get('Kudu Kill(w3wp)')).toBe('WN0SDWK000K9R');
    expect(map.size).toBe(2);
  });

  it('is empty when there are no findings', () => {
    expect(instancesByCause({ charts: [] }).size).toBe(0);
  });
});

describe('restartTotals', () => {
  it('totals by cause, busiest first', () => {
    expect(restartTotals(restarts)).toEqual({
      total: 5,
      byCause: [{ cause: 'Kudu Kill(w3wp)', count: 4 }, { cause: 'App Crash', count: 1 }],
    });
  });
});

describe('causeColor', () => {
  it('gives each kind of restart a colour that matches what it means', () => {
    expect(causeColor('Kudu Kill(w3wp)')).toBe('#22d3ee');       // deliberate
    expect(causeColor('App Crash')).toBe('#f85149');              // the app broke
    expect(causeColor('Platform Healing Your App')).toBe('#f97316'); // Azure stepped in
  });

  it('falls back to the shared palette for a cause it does not know', () => {
    expect(causeColor('Something New', 0)).toBe('#38bdf8');
  });
});

// The prose the `webappstart` detector actually returns — one paragraph carrying
// every event, which is what the card has to read when there is no timeline.
const PROSE = 'We analyzed `3` Kudu Kill Events, `1` App Crash Event. '
  + 'Kudu Kill(w3wp) Around 07/29/2026 09:31:20 (UTC), on Instance WN0SDWK000KFZ, your application process (w3wp.exe) was terminated by Kudu REST API or killing the process from Process Explorer in Kudu site. '
  + 'Kudu Kill(w3wp) Around 07/29/2026 09:31:26 (UTC), on Instance WN0SDWK000K9R, your application process (w3wp.exe) was terminated by Kudu REST API. '
  + 'App Crash Around 07/29/2026 09:01:05 (UTC), on Instance WN0SDWK000K9C, your application process experienced a crash.';

const proseOnly = {
  charts: [],
  detector: 'webappstart',
  insights: [{
    status: 'Critical',
    message: 'Application stop events are detected',
    items: [
      { name: 'Description', html: '', text: PROSE },
      { name: 'Additional Information', html: '', text: 'Application initialization can be complex and require a long time to complete after the restart.' },
    ],
  }],
};

describe('parseRestartProse', () => {
  it('pulls each event out of the paragraph with its time and worker', () => {
    const out = parseRestartProse(PROSE);
    expect(out.map(e => [e.cause, e.instance])).toEqual([
      ['Kudu Kill(w3wp)', 'WN0SDWK000K9R'],
      ['Kudu Kill(w3wp)', 'WN0SDWK000KFZ'],
      ['App Crash', 'WN0SDWK000K9C'],
    ]);
    expect(out[0]!.t).toBe('2026-07-29T09:31:26.000Z');
  });

  it('does not read "Platform Healing Your App" as an App Crash', () => {
    const out = parseRestartProse('Platform Healing Your App Around 07/29/2026 09:38:53 (UTC), on Instance WN0SDWK000KFZ, your application process was responding slow.');
    expect(out.map(e => e.cause)).toEqual(['Platform Healing Your App']);
  });

  it('keeps an event Azure reported without a timestamp, marked recurring', () => {
    const out = parseRestartProse('Kudu Kill(w3wp) On Instance WN0SDWK000K9R, your application process was terminated. This event occurred multiple times during the day.');
    expect(out[0]).toMatchObject({ cause: 'Kudu Kill(w3wp)', instance: 'WN0SDWK000K9R', t: '', undated: true });
  });

  it('does not duplicate a dated event as an undated one', () => {
    const both = 'Kudu Kill(w3wp) Around 07/29/2026 09:31:20 (UTC), on Instance WN0SDWK000KFZ, terminated. Kudu Kill(w3wp) On Instance WN0SDWK000KFZ, terminated again.';
    expect(parseRestartProse(both)).toHaveLength(1);
  });

  it('returns nothing for prose with no events in it', () => {
    expect(parseRestartProse('Application initialization can be complex.')).toEqual([]);
  });
});

describe('parseRestartHeadline', () => {
  it('reads the counts the detector states up front', () => {
    expect(parseRestartHeadline(PROSE)).toEqual([
      { cause: 'Kudu Kill(w3wp)', count: 3 },
      { cause: 'App Crash', count: 1 },
    ]);
  });

  it('handles the singular "1 Platform Healing Your App Event"', () => {
    expect(parseRestartHeadline('We analyzed `1` Platform Healing Your App Event.')).toEqual([
      { cause: 'Platform Healing Your App', count: 1 },
    ]);
  });
});

describe('prose fallback', () => {
  it('counts restarts from the headline when there is no timeline chart', () => {
    // The previous build showed "0 restarts" here — the chart was empty and nothing
    // read the paragraph that had every event in it.
    expect(restartTotals(proseOnly)).toEqual({
      total: 4,
      byCause: [{ cause: 'Kudu Kill(w3wp)', count: 3 }, { cause: 'App Crash', count: 1 }],
    });
  });

  it('lists the events from the prose when the chart is empty', () => {
    expect(restartEvents(proseOnly).map(e => e.cause)).toEqual([
      'Kudu Kill(w3wp)', 'Kudu Kill(w3wp)', 'App Crash',
    ]);
  });

  it('ignores the boilerplate advice block when reading events', () => {
    expect(proseOf(proseOnly)).not.toContain('Application initialization');
  });
});
