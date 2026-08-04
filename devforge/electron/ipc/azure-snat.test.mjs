import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { findSnatDetector, parseSnatDetector, detectGrainMs, SNAT_CHART_TITLES } = require('./azure-snat.cjs');

const detectorList = {
  value: [
    { name: 'sitecpuanalysis', properties: { metadata: { name: 'CPU Analysis' } } },
    { name: 'SnatPortExhaustion', properties: { metadata: { name: 'SNAT Port Exhaustion' } } },
    { name: 'tcpconnections', properties: { metadata: { name: 'TCP Connections' } } },
  ],
};

// Trimmed shape of a real detector response: one dataset per chart, each a table
// of TimeStamp / label columns / a numeric column.
function chart(title, rows, columns) {
  return {
    renderingProperties: { type: 2, title },
    table: {
      tableName: title,
      columns: columns ?? [
        { columnName: 'TimeStamp', dataType: 'DateTime' },
        { columnName: 'Counter', dataType: 'String' },
        { columnName: 'Count', dataType: 'Double' },
      ],
      rows,
    },
  };
}

const payload = {
  name: 'SnatPortExhaustion',
  properties: {
    dataset: [
      chart('SNAT port usage for TCP protocol', [
        ['2026-07-29T08:00:00Z', 'wn0K9C(TCP_Allocated)', 128],
        ['2026-07-29T08:05:00Z', 'wn0K9C(TCP_Allocated)', 130],
        ['2026-07-29T08:00:00Z', 'wn0K9C(Tcp_Used)', 12],
      ]),
      chart('Pending SNAT connections', [['2026-07-29T08:05:00Z', 'Pending(wn0K9R)', 1]]),
      chart('Failed SNAT connections', [['2026-07-29T08:00:00Z', 'Count', 0]]),
      chart('New SNAT connections established', [['2026-07-29T08:00:00Z', 'Successful(wn0K9R)', 44]]),
      chart('Some unrelated chart', [['2026-07-29T08:00:00Z', 'x', 1]]),
    ],
  },
};

describe('findSnatDetector', () => {
  it('picks the SNAT detector out of the list', () => {
    expect(findSnatDetector(detectorList)).toBe('SnatPortExhaustion');
  });

  it('accepts a bare array as well as the ARM envelope', () => {
    expect(findSnatDetector(detectorList.value)).toBe('SnatPortExhaustion');
  });

  it('falls back to a description mention when no detector is named for SNAT', () => {
    expect(findSnatDetector({ value: [
      { name: 'tcpconnections', properties: { metadata: { description: 'Outbound TCP and SNAT usage' } } },
    ] })).toBe('tcpconnections');
  });

  it('returns null when nothing mentions SNAT', () => {
    expect(findSnatDetector({ value: [{ name: 'sitecpuanalysis' }] })).toBeNull();
  });
});

describe('parseSnatDetector', () => {
  it('keeps only the four SNAT charts, in canonical order', () => {
    const out = parseSnatDetector(payload, 'SnatPortExhaustion');
    expect(out.detector).toBe('SnatPortExhaustion');
    expect(out.charts.map(c => c.title)).toEqual(SNAT_CHART_TITLES);
  });

  it('groups rows into one series per label, sorted chronologically', () => {
    const [usage] = parseSnatDetector(payload).charts;
    expect(usage.series.map(s => s.name)).toEqual(['wn0K9C(TCP_Allocated)', 'wn0K9C(Tcp_Used)']);
    expect(usage.series[0].series).toEqual([
      { t: '2026-07-29T08:00:00.000Z', count: 128 },
      { t: '2026-07-29T08:05:00.000Z', count: 130 },
    ]);
  });

  it('orders series by peak so the busiest keeps the first colour', () => {
    const [usage] = parseSnatDetector({ properties: { dataset: [
      chart('SNAT port usage for TCP protocol', [
        ['2026-07-29T08:00:00Z', 'quiet', 1],
        ['2026-07-29T08:00:00Z', 'busy', 300],
      ]),
    ] } }).charts;
    expect(usage.series.map(s => s.name)).toEqual(['busy', 'quiet']);
  });

  it('locates columns by name and type, not position', () => {
    const out = parseSnatDetector({ properties: { dataset: [
      chart('Pending SNAT connections',
        [['Pending(wn0K9R)', 3, '2026-07-29T08:00:00Z']],
        [
          { columnName: 'Instance', dataType: 'String' },
          { columnName: 'Value', dataType: 'Int64' },
          { columnName: 'TimeStamp', dataType: 'DateTime' },
        ]),
    ] } });
    expect(out.charts.find(c => c.title === 'Pending SNAT connections').series).toEqual([
      { name: 'Pending(wn0K9R)', series: [{ t: '2026-07-29T08:00:00.000Z', count: 3 }] },
    ]);
  });

  it('matches a title that carries a suffix', () => {
    const out = parseSnatDetector({ properties: { dataset: [
      chart('SNAT port usage for TCP protocol (per instance)', [['2026-07-29T08:00:00Z', 'a', 1]]),
    ] } });
    expect(out.charts[0].title).toBe('SNAT port usage for TCP protocol');
  });

  it('skips rows with an unparseable timestamp or value', () => {
    const out = parseSnatDetector({ properties: { dataset: [
      chart('Failed SNAT connections', [
        ['not a date', 'a', 1],
        ['2026-07-29T08:00:00Z', 'a', 'n/a'],
        ['2026-07-29T08:05:00Z', 'a', 2],
      ]),
    ] } });
    const failed = out.charts.find(c => c.title === 'Failed SNAT connections');
    expect(failed.series[0].series).toEqual([{ t: '2026-07-29T08:05:00.000Z', count: 2 }]);
  });

  it('returns null when the payload has no SNAT dataset', () => {
    expect(parseSnatDetector({ properties: { dataset: [chart('CPU Drill Down', [['2026-07-29T08:00:00Z', 'a', 1]])] } })).toBeNull();
    expect(parseSnatDetector({ properties: { dataset: [] } })).toBeNull();
    expect(parseSnatDetector(null)).toBeNull();
  });

  it('keeps a matching chart that came back with no rows, so the panel still renders', () => {
    const out = parseSnatDetector({ properties: { dataset: [chart('Failed SNAT connections', [])] } });
    expect(out.charts.find(c => c.title === 'Failed SNAT connections').series).toEqual([]);
  });

  it('fills in charts the detector omitted entirely', () => {
    const out = parseSnatDetector({ properties: { dataset: [
      chart('SNAT port usage for TCP protocol', [['2026-07-29T08:00:00Z', 'a', 1]]),
    ] } });
    expect(out.charts.map(c => c.title)).toEqual(SNAT_CHART_TITLES);
    expect(out.charts.filter(c => c.series.length === 0).map(c => c.title)).toEqual([
      'Pending SNAT connections',
      'Failed SNAT connections',
      'New SNAT connections established',
    ]);
  });
});

describe('detectGrainMs', () => {
  const at = (...mins) => ({
    name: 'w1',
    series: mins.map(m => ({ t: new Date(Date.UTC(2026, 6, 29, 8, m)).toISOString(), count: 1 })),
  });

  it('measures the bucket width the detector actually returned', () => {
    expect(detectGrainMs([{ title: 'x', series: [at(0, 5, 10, 15)] }])).toBe(300_000);
    expect(detectGrainMs([{ title: 'x', series: [at(0, 1, 2, 3)] }])).toBe(60_000);
  });

  it('measures the longest series, not the first', () => {
    expect(detectGrainMs([
      { title: 'sparse', series: [at(0, 30)] },
      { title: 'dense', series: [at(0, 1, 2, 3, 4)] },
    ])).toBe(60_000);
  });

  it('takes the median so one gap in the data does not skew it', () => {
    expect(detectGrainMs([{ title: 'x', series: [at(0, 1, 2, 3, 60)] }])).toBe(60_000);
  });

  it('returns null when there is nothing to measure', () => {
    expect(detectGrainMs([{ title: 'x', series: [at(0)] }])).toBeNull();
    expect(detectGrainMs([])).toBeNull();
  });
});
