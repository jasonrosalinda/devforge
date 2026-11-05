import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { _fetchFiveXxRequests: fetchFiveXxRequests } = require('./azure-metrics.cjs');

const cred = { getToken: async () => ({ token: 'tok' }) };
const START = '2026-10-28T09:00:00.000Z';
const END = '2026-10-28T12:00:00.000Z';

const reply = (body, ok = true, status = 200) => vi.fn(async () => ({
  ok, status, json: async () => body, text: async () => JSON.stringify(body),
}));

afterEach(() => vi.unstubAllGlobals());

describe('fetchFiveXxRequests', () => {
  it('asks for the total and the newest records in one call over exactly the window', async () => {
    const fetch = reply({ tables: [{ rows: [[3]] }, { rows: [] }] });
    vi.stubGlobal('fetch', fetch);
    await fetchFiveXxRequests('app-1', cred, START, END, 50);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.applicationinsights.io/v1/apps/app-1/query');
    expect(init.headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(init.body);
    expect(body.timespan).toBe(`${START}/${END}`);
    const [count, list] = body.query.split(';\n');
    // Same 5xx definition as the card: includes failures with no usable code.
    expect(count).toContain('rc >= 500 or (success == false');
    expect(count).toContain('summarize total=sum(itemCount)');
    expect(list).toContain('top 50 by timestamp desc');
  });

  it('maps rows, labels a missing code and defaults the sample weight', async () => {
    vi.stubGlobal('fetch', reply({ tables: [
      { rows: [[1234]] },
      { rows: [
        ['2026-10-28T11:59:00Z', 'GET /api/x', 'https://site/api/x?id=1', '503', 1234.6, 'RD01', 'op-1', 4],
        ['2026-10-28T11:58:00Z', 'POST /y', null, '', null, null, null, null],
      ] },
    ] }));
    const out = await fetchFiveXxRequests('app-1', cred, START, END);
    expect(out.total).toBe(1234);
    expect(out.rows[0]).toEqual({
      t: '2026-10-28T11:59:00.000Z', name: 'GET /api/x', url: 'https://site/api/x?id=1', resultCode: '503',
      durationMs: 1235, instance: 'RD01', operationId: 'op-1', itemCount: 4,
    });
    expect(out.rows[1]).toMatchObject({ url: '', resultCode: '(none)', durationMs: 0, itemCount: 1 });
  });

  it('throws the API error so the handler can show it', async () => {
    vi.stubGlobal('fetch', reply({ error: { message: 'bad' } }, false, 403));
    await expect(fetchFiveXxRequests('app-1', cred, START, END)).rejects.toThrow(/^403:/);
    vi.stubGlobal('fetch', reply({ error: { message: 'Query is invalid' } }));
    await expect(fetchFiveXxRequests('app-1', cred, START, END)).rejects.toThrow('Query is invalid');
  });

  it('reads an empty answer as zero', async () => {
    vi.stubGlobal('fetch', reply({ tables: [] }));
    expect(await fetchFiveXxRequests('app-1', cred, START, END)).toEqual({ total: 0, rows: [] });
  });
});
