import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { restartTotals, RESTART_CHART_TITLES } = require('./azure-restarts.cjs');
const { findDetector, parseDetectorCharts, parseDetectorInsights, htmlToText } = require('./azure-detectors.cjs');

const timeline = {
  renderingProperties: { type: 2, title: 'App Restart Events Timeline' },
  table: {
    columns: [
      { columnName: 'TimeStamp', dataType: 'DateTime' },
      { columnName: 'Cause', dataType: 'String' },
      { columnName: 'Count', dataType: 'Double' },
    ],
    rows: [
      ['2026-07-29T09:05:00Z', 'Kudu Kill(w3wp)', 2],
      ['2026-07-29T09:15:00Z', 'Kudu Kill(w3wp)', 2],
      ['2026-07-29T09:25:00Z', 'App Crash', 1],
      ['2026-07-29T09:35:00Z', 'Platform Healing Your App', 1],
    ],
  },
};

// The portal's prose block, as Azure renders it: an Insights table keyed by Message.
const insightTable = {
  renderingProperties: { type: 7 },
  table: {
    columns: [
      { columnName: 'Status', dataType: 'String' },
      { columnName: 'Message', dataType: 'String' },
      { columnName: 'Data.Name', dataType: 'String' },
      { columnName: 'Data.Value', dataType: 'String' },
      { columnName: 'Expanded', dataType: 'String' },
    ],
    rows: [
      ['Critical', 'Application stop events are detected', 'Kudu Kill(w3wp)', 'On Instance <b>WN0SDWK000K9R</b>, your application process (<b>w3wp.exe</b>) was terminated by Kudu REST API.', 'True'],
      ['Critical', 'Application stop events are detected', 'App Crash', 'Around 07/29/2026 09:25:34 (UTC), on Instance WN0SDWK000K9R, your application process experienced a crash.', 'True'],
    ],
  },
};

describe('findDetector', () => {
  const list = { value: [
    { name: 'sitecpuanalysis' },
    { name: 'apprestartanalyses', properties: { metadata: { name: 'Application Restart Analysis' } } },
  ] };

  it('finds the restart detector by keyword', () => {
    expect(findDetector(list, ['app restart', 'restart'])).toBe('apprestartanalyses');
  });

  it('honours keyword order, strongest first', () => {
    const both = { value: [
      { name: 'genericrestarts', properties: { metadata: { description: 'mentions restart' } } },
      { name: 'apprestartanalyses', properties: { metadata: { name: 'App Restart Analysis' } } },
    ] };
    expect(findDetector(both, ['app restart', 'restart'])).toBe('apprestartanalyses');
  });

  it('returns null when nothing matches', () => {
    expect(findDetector(list, ['snat'])).toBeNull();
  });
});

describe('parseDetectorCharts — restart timeline', () => {
  it('groups the timeline into one series per cause', () => {
    const out = parseDetectorCharts({ properties: { dataset: [timeline] } }, 'apprestartanalyses', { titles: RESTART_CHART_TITLES });
    const [chart] = out.charts;
    expect(chart.title).toBe('App Restart Events Timeline');
    expect(chart.series.map(s => s.name)).toEqual(['Kudu Kill(w3wp)', 'App Crash', 'Platform Healing Your App']);
  });

  it('measures the grain the detector returned', () => {
    const out = parseDetectorCharts({ properties: { dataset: [timeline] } }, 'x', { titles: RESTART_CHART_TITLES });
    expect(out.grainMs).toBe(600_000);   // the Kudu series is 10 minutes apart
  });

  it('keeps whatever matches when no title list is given', () => {
    const out = parseDetectorCharts({ properties: { dataset: [timeline] } }, 'x', { titleMatch: /restart/i });
    expect(out.charts).toHaveLength(1);
    expect(parseDetectorCharts({ properties: { dataset: [timeline] } }, 'x', { titleMatch: /snat/i })).toBeNull();
  });
});

describe('parseDetectorInsights', () => {
  it('groups the prose rows under their finding', () => {
    const [finding] = parseDetectorInsights({ properties: { dataset: [insightTable] } });
    expect(finding.message).toBe('Application stop events are detected');
    expect(finding.status).toBe('Critical');
    expect(finding.items.map(i => i.name)).toEqual(['Kudu Kill(w3wp)', 'App Crash']);
  });

  it('flattens the HTML so the card can render it as text', () => {
    const [finding] = parseDetectorInsights({ properties: { dataset: [insightTable] } });
    expect(finding.items[0].text).toBe('On Instance WN0SDWK000K9R, your application process (w3wp.exe) was terminated by Kudu REST API.');
  });

  it('ignores tables that are not insight tables', () => {
    expect(parseDetectorInsights({ properties: { dataset: [timeline] } })).toEqual([]);
  });
});

describe('htmlToText', () => {
  it('strips tags and collapses whitespace', () => {
    expect(htmlToText('<b>a</b><br/>  b &amp; c')).toBe('a b & c');
  });
});

describe('restartTotals', () => {
  it('totals each cause and ranks them', () => {
    const charts = parseDetectorCharts({ properties: { dataset: [timeline] } }, 'x', { titles: RESTART_CHART_TITLES }).charts;
    const out = restartTotals(charts);
    expect(out.total).toBe(6);
    expect(out.byCause[0]).toEqual({ cause: 'Kudu Kill(w3wp)', count: 4 });
  });

  it('drops causes that never fired rather than listing them at zero', () => {
    const out = restartTotals([{ title: 'App Restart Events Timeline', series: [{ name: 'App Crash', series: [{ t: '10:00', count: 0 }] }] }]);
    expect(out).toEqual({ total: 0, byCause: [] });
  });

  it('handles a site with no restart chart at all', () => {
    expect(restartTotals(null)).toEqual({ total: 0, byCause: [] });
    expect(restartTotals([])).toEqual({ total: 0, byCause: [] });
  });
});
