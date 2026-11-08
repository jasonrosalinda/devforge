import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./azure-kpi.cjs');
const { _clearLookups } = require('./azure-metrics.cjs');

const { _mean, _monthlyAverage, _aggregateCost, _fetchCost, _fetchServiceKpi } = handler;

const SUB = 'sub-1';
const FARM = '/subscriptions/sub-1/resourceGroups/RG/providers/Microsoft.Web/serverfarms/shared-plan';
const WINDOW = {
  startIso: '2026-09-30T16:00:00.000Z',
  endIso: '2026-10-31T16:00:00.000Z',
  costFrom: '2026-10-01T00:00:00.000Z',
  costTo: '2026-10-31T23:59:59.000Z',
};
const pt = (average) => ({ timeStamp: new Date(), average });

/** One canned daily series per metric name; records which resource each name was asked of. */
const fakeClient = (byName) => ({
  queryResource: vi.fn(async (_resId, names) => ({
    metrics: names.map((name) => ({ name, timeseries: byName[name] ? [{ data: byName[name] }] : [] })),
  })),
});
const credential = { getToken: vi.fn(async () => ({ token: 'tok', expiresOnTimestamp: Date.now() + 3_600_000 })) };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const COST_BODY = {
  properties: {
    columns: [{ name: 'Cost' }, { name: 'ResourceGroupName' }, { name: 'ServiceName' }, { name: 'Currency' }],
    rows: [
      [100, 'RG', 'Azure App Service', 'USD'],
      [50.5, 'rg', 'SQL Database', 'USD'],
      [20, '', 'Microsoft Defender for Cloud', 'USD'],
      [0, 'empty-rg', 'Storage', 'USD'],
    ],
  },
};

describe('mean', () => {
  it('ignores nulls and returns null for no values', () => {
    expect(_mean([1, null, 3, undefined])).toBe(2);
    expect(_mean([])).toBeNull();
    expect(_mean([null])).toBeNull();
  });
});

describe('monthlyAverage', () => {
  it('asks for daily averages over the window and returns their mean, unrounded', async () => {
    const client = fakeClient({ CpuPercentage: [pt(1), pt(2), pt(2.5), pt(null)] });
    const ts = { startTime: new Date(WINDOW.startIso), endTime: new Date(WINDOW.endIso) };
    expect(await _monthlyAverage(client, '/res', 'CpuPercentage', ts)).toBeCloseTo(5.5 / 3, 10);
    expect(client.queryResource).toHaveBeenCalledWith('/res', ['CpuPercentage'], { timespan: ts, granularity: 'P1D', aggregations: ['Average'] });
  });

  it('is null when Azure returns no series', async () => {
    expect(await _monthlyAverage(fakeClient({}), '/res', 'CpuPercentage', {})).toBeNull();
  });
});

describe('aggregateCost', () => {
  it('totals, groups resource groups case-insensitively, names subscription-level charges, drops zero lines, sorts by cost', () => {
    const r = _aggregateCost(COST_BODY.properties.columns.map((c) => c.name), COST_BODY.properties.rows);
    expect(r.ok).toBe(true);
    expect(r.total).toBeCloseTo(170.5);
    expect(r.currency).toBe('USD');
    expect(r.byResourceGroup).toEqual([
      { name: 'RG', cost: 150.5, services: [{ name: 'Azure App Service', cost: 100 }, { name: 'SQL Database', cost: 50.5 }] },
      { name: '(subscription level)', cost: 20, services: [{ name: 'Microsoft Defender for Cloud', cost: 20 }] },
    ]);
    expect(r.byService.map((l) => l.name)).toEqual(['Azure App Service', 'SQL Database', 'Microsoft Defender for Cloud']);
  });

  it('rejects a response with no Cost column', () => {
    expect(() => _aggregateCost(['ServiceName'], [])).toThrow('no Cost column');
  });
});

describe('fetchCost', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('follows nextLink and groups by resource group and service for the UTC month', async () => {
    const page2 = { properties: { columns: COST_BODY.properties.columns, rows: [[9.5, 'other', 'Bandwidth', 'USD']] } };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ properties: { ...COST_BODY.properties, nextLink: 'https://next' } }))
      .mockResolvedValueOnce(json(page2));
    vi.stubGlobal('fetch', fetchMock);
    const r = await _fetchCost('tok', SUB, WINDOW);
    expect(r.total).toBeCloseTo(180);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://next');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.timePeriod).toEqual({ from: WINDOW.costFrom, to: WINDOW.costTo });
    expect(body.dataset.grouping.map((g) => g.name)).toEqual(['ResourceGroupName', 'ServiceName']);
  });

  it('explains a 403 as the missing Cost Management Reader role', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'nope' }, 403)));
    await expect(_fetchCost('tok', SUB, WINDOW)).rejects.toThrow('Cost Management Reader');
  });

  const throttled = (retryAfter) => ({ ...json({ error: 'busy' }, 429), headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) } });

  it('retries once after a 429, waiting as long as Cost Management says', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(throttled('0')).mockResolvedValueOnce(json(COST_BODY));
    vi.stubGlobal('fetch', fetchMock);
    expect((await _fetchCost('tok', SUB, WINDOW)).total).toBeCloseTo(170.5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks the user to wait when still throttled after the retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => throttled('0')));
    await expect(_fetchCost('tok', SUB, WINDOW)).rejects.toThrow('Wait a minute');
  });

  it('surfaces other failures with the status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'down' }, 503)));
    await expect(_fetchCost('tok', SUB, WINDOW)).rejects.toThrow('Cost Management 503');
  });
});

describe('fetchServiceKpi', () => {
  const APP = {
    name: 'web-app', type: 'appservice', resourceGroup: 'RG', appInsightsAppId: 'ai-web',
    apiName: 'api-app', apiInsightsAppId: 'ai-api', dbServerName: 'dbsvr', dbName: 'db',
  };
  const CA = { name: 'svc', type: 'containerapp', resourceGroup: 'CA-RG' };
  const config = { subscriptionId: SUB, apps: [APP, CA] };
  let aiBodies;

  beforeEach(() => {
    _clearLookups();
    aiBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('api.applicationinsights.io')) {
        aiBodies.push({ url: u, body: JSON.parse(init.body) });
        return json({ tables: [{ rows: [[u.includes('ai-api') ? 7 : 3]] }] });
      }
      if (u.includes('CostManagement')) return json(COST_BODY);
      if (u.includes('/serverfarms/')) return json({ sku: { name: 'P1v3', capacity: 1 }, properties: {} });
      return json({ properties: { serverFarmId: FARM } });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const client = () => fakeClient({
    CpuPercentage: [pt(2), pt(4)],
    MemoryPercentage: [pt(30), pt(40)],
    cpu_percent: [pt(1), pt(2)],
  });

  it('returns every figure per target, with the plan named, and the cost block', async () => {
    const c = client();
    const r = await _fetchServiceKpi({ client: c, cred: credential }, {
      config, window: WINDOW,
      targets: [{ appName: 'web-app', site: 'web' }, { appName: 'web-app', site: 'api' }, { appName: 'svc', site: 'web' }],
    });
    const web = r.targets['web-app::web'];
    expect(web).toEqual({ scope: 'Plan shared-plan', cpu: { value: 3 }, memory: { value: 35 }, db: { value: 1.5 }, errors5xx: { value: 3 } });
    const api = r.targets['web-app::api'];
    expect(api.db).toBeNull();
    expect(api.errors5xx).toEqual({ value: 7 });
    const ca = r.targets['svc::web'];
    expect(ca.scope).toBe('Container app');
    expect(ca.errors5xx).toBeNull(); // no App Insights id and no ARM lookup for a container app
    expect(r.cost.ok).toBe(true);
    // App Service CPU is read from the plan; the container app from itself.
    const asked = c.queryResource.mock.calls.map(([res, [name]]) => `${name}@${res.split('/').pop()}`);
    expect(asked).toContain('CpuPercentage@shared-plan');
    expect(asked).toContain('CpuPercentage@svc');
    expect(asked).toContain('cpu_percent@db');
    expect(aiBodies[0].body.timespan).toBe(`${WINDOW.startIso}/${WINDOW.endIso}`);
    expect(aiBodies[0].body.query).toContain('sum(itemCount)');
  });

  it('keeps a failing figure to its own cell', async () => {
    const c = client();
    c.queryResource.mockImplementation(async (_res, [name]) => {
      if (name === 'MemoryPercentage') throw new Error('metric not supported');
      return { metrics: [{ name, timeseries: [{ data: [pt(5)] }] }] };
    });
    const r = await _fetchServiceKpi({ client: c, cred: credential }, { config, window: WINDOW, targets: [{ appName: 'svc', site: 'web' }] });
    expect(r.targets['svc::web'].cpu).toEqual({ value: 5 });
    expect(r.targets['svc::web'].memory).toEqual({ value: null, error: 'metric not supported' });
  });

  it('marks an empty month as no data rather than zero', async () => {
    const r = await _fetchServiceKpi({ client: fakeClient({}), cred: credential }, { config, window: WINDOW, targets: [{ appName: 'svc', site: 'web' }] });
    expect(r.targets['svc::web'].cpu).toEqual({ value: null, note: 'No data in this month' });
  });

  it('reports an app missing from Settings, and a cost failure, without failing the rest', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('CostManagement') ? json({}, 403) : json({}))));
    const r = await _fetchServiceKpi({ client: client(), cred: credential }, { config, window: WINDOW, targets: [{ appName: 'gone', site: 'web' }] });
    expect(r.targets['gone::web'].cpu.error).toContain('not found in Settings');
    expect(r.cost).toEqual({ ok: false, error: expect.stringContaining('Cost Management Reader') });
  });

  it('errors when the plan cannot be resolved for an App Service', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => (String(url).includes('CostManagement') ? json(COST_BODY) : json({}, 404))));
    const r = await _fetchServiceKpi({ client: client(), cred: credential }, { config, window: WINDOW, targets: [{ appName: 'web-app', site: 'web' }] });
    expect(r.targets['web-app::web'].scope).toBeNull();
    expect(r.targets['web-app::web'].cpu.error).toContain('App Service plan not found');
  });

  it('needs an Azure configuration', async () => {
    expect(await _fetchServiceKpi({ client: client(), cred: credential }, { config: { subscriptionId: '', apps: [] }, window: WINDOW, targets: [] }))
      .toEqual({ _error: expect.stringContaining('No Azure configuration') });
  });
});
