import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { pageViewBin, pageViewQueries, parsePageViewTables, getPageViewInsights } = require('./azure-pageviews.cjs');

describe('pageViewBin', () => {
  it('scales the bucket with the window', () => {
    expect(pageViewBin(60)).toBe('1m');
    expect(pageViewBin(24 * 60)).toBe('15m');
    expect(pageViewBin(7 * 24 * 60)).toBe('6h');
    expect(pageViewBin(30 * 24 * 60)).toBe('6h'); // boundary is inclusive
    expect(pageViewBin(31 * 24 * 60)).toBe('1d');
  });

  it('puts the bin into the timeline query', () => {
    expect(pageViewQueries('15m')[1]).toContain('bin(timestamp, 15m)');
  });

  it('avoids KQL reserved words as column aliases', () => {
    // `views` is reserved: "summarize views=..." fails to parse (SYN0002).
    for (const q of pageViewQueries('5m')) {
      expect(q).not.toMatch(/[\s,(]views\s*=/);
      expect(q).not.toMatch(/by views\b/);
    }
  });
});

describe('parsePageViewTables', () => {
  const tables = [
    [[1200, 1834.56, 1400, 4210.2, 12000]],
    [['2026-09-25T00:00:00Z', 1700, 3900, 40], ['2026-09-25T00:15:00Z', 2100.44, 4500, 55]],
    [['Home', 800, 1500, 3200], ['Checkout', 90, 3400, 7800]],
    [[1100, 320.4, 12, 610, 890.2, 1832.6]],
  ];

  it('shapes the headline, series, pages and timing breakdown', () => {
    const r = parsePageViewTables(tables, '15m');
    expect(r).toMatchObject({ bin: '15m', views: 1200, avgMs: 1834.6, p50Ms: 1400, p95Ms: 4210.2, maxMs: 12000 });
    expect(r.series).toEqual([
      { t: '2026-09-25T00:00:00Z', avgMs: 1700, p95Ms: 3900, views: 40 },
      { t: '2026-09-25T00:15:00Z', avgMs: 2100.4, p95Ms: 4500, views: 55 },
    ]);
    expect(r.pages[1]).toEqual({ name: 'Checkout', views: 90, avgMs: 3400, p95Ms: 7800 });
    expect(r.timings).toEqual({ samples: 1100, networkMs: 320.4, sendMs: 12, receiveMs: 610, processingMs: 890.2, totalMs: 1832.6 });
  });

  it('reports zero views without inventing load times (no JavaScript SDK)', () => {
    const r = parsePageViewTables([[[0, null, null, null, null]], [], [], [[0, null, null, null, null, null]]], '5m');
    expect(r).toMatchObject({ views: 0, avgMs: null, p95Ms: null, series: [], pages: [], timings: null });
  });

  it('fails when the headline query fails, degrades when the others do', () => {
    expect(parsePageViewTables([{ error: '403: nope' }, [], [], []], '5m')).toEqual({ error: '403: nope' });
    const r = parsePageViewTables([tables[0], { error: 'x' }, { error: 'y' }, { error: 'z' }], '5m');
    expect(r).toMatchObject({ views: 1200, series: [], pages: [], timings: null });
  });
});

describe('getPageViewInsights', () => {
  it('sends the four queries as one batch', async () => {
    let sent = null;
    const r = await getPageViewInsights(async (qs) => { sent = qs; return [[[5, 1000, 900, 2000, 3000]], [], [], []]; }, 60);
    expect(sent).toHaveLength(4);
    expect(r.views).toBe(5);
    expect(r.bin).toBe('1m');
  });
});
