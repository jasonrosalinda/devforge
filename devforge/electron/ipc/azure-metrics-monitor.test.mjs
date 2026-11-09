import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./azure-metrics.cjs');

const { _setCached, _cacheSize, _fetchMonitorMetrics, _clearLookups, _findAppInsightsAppId } = handler;

const MIN = 60_000;

describe('findAppInsightsAppId', () => {
  const components = { value: [{ name: 'web', id: '/subscriptions/s/resourceGroups/rg/providers/microsoft.insights/components/web', properties: { AppId: 'app-1' } }] };
  let fetchMock;
  beforeEach(() => {
    _clearLookups();
    fetchMock = vi.fn(async (url) => (String(url).includes('appsettings')
      ? { ok: true, json: async () => ({ properties: {} }) }
      : { ok: true, json: async () => components }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('lists the subscription once, however many fetches ask (also when they ask at the same time)', async () => {
    const ids = await Promise.all([
      _findAppInsightsAppId('t', 's', 'rg', 'web'),
      _findAppInsightsAppId('t', 's', 'rg', 'web'),
    ]);
    expect(await _findAppInsightsAppId('t', 's', 'RG', 'WEB')).toBe('app-1');
    expect(ids).toEqual(['app-1', 'app-1']);
    expect(fetchMock).toHaveBeenCalledTimes(2); // app settings + component list, first lookup only
  });

  it('does not keep a miss: a 401 or 429 must not hide App Insights for the session', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: true, json: async () => ({ properties: {} }) }))
      .mockImplementationOnce(async () => ({ ok: false, status: 429 }));
    expect(await _findAppInsightsAppId('t', 's', 'rg', 'web')).toBeNull();
    expect(await _findAppInsightsAppId('t', 's', 'rg', 'web')).toBe('app-1');
  });
});

describe('result cache', () => {
  it('drops expired entries when a new one is stored', () => {
    vi.useFakeTimers();
    try {
      const before = _cacheSize();
      _setCached('sweep-test:a', {});
      _setCached('sweep-test:b', {});
      expect(_cacheSize()).toBe(before + 2);
      vi.advanceTimersByTime(3 * MIN);
      _setCached('sweep-test:c', {});
      expect(_cacheSize()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fetchMonitorMetrics', () => {
  const SUB = 'sub-1';
  const APP = {
    name: 'medu-web', type: 'appservice', resourceGroup: 'RG',
    appInsightsAppId: 'ai-1', dbServerName: 'dbsvr', dbName: 'db',
  };
  const FARM = '/subscriptions/sub-1/resourceGroups/RG/providers/Microsoft.Web/serverfarms/plan';
  const T0 = '2026-09-29T01:00:00.000Z';
  const T1 = '2026-09-29T01:01:00.000Z';
  const pt = (t, average, maximum = average) => ({ timeStamp: new Date(t), average, maximum });
  const cnt = (t, total) => ({ timeStamp: new Date(t), total });

  /** One canned series per metric name; a query returns every name it asked for. */
  const fakeClient = (byName) => ({
    queryResource: vi.fn(async (_resId, names) => ({
      metrics: names.map(name => ({ name, timeseries: byName[name] ? [{ data: byName[name] }] : [] })),
    })),
  });

  const credential = { getToken: vi.fn(async () => ({ token: 'ai-token', expiresOnTimestamp: Date.now() + 3_600_000 })) };

  let fetchMock;
  beforeEach(() => {
    _clearLookups();
    fetchMock = vi.fn(async (url) => {
      if (String(url).includes('api.applicationinsights.io')) {
        return { ok: true, json: async () => ({ tables: [{ rows: [
          [T0, 'i1', 'web', 10, 2, 80], [T0, 'i2', 'web', 10, 1, 90], [T1, 'i1', 'web', 10, 0, 100],
        ] }] }) };
      }
      if (String(url).includes('/serverfarms/')) {
        return { ok: true, json: async () => ({ sku: { name: 'P1v3', capacity: 2 }, properties: {} }) };
      }
      return { ok: true, json: async () => ({ properties: { serverFarmId: FARM } }) };
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const series = {
    CpuPercentage: [pt(T0, 10, 20), pt(T1, 30, 40)],
    MemoryPercentage: [pt(T0, 50), pt(T1, 52)],
    Requests: [cnt(T0, 100), cnt(T1, 120.4)],
    Http5xx: [cnt(T0, 5), cnt(T1, 0)],
    cpu_percent: [pt(T0, 1.5), pt(T1, 62)],
    sql_instance_memory_percent: [pt(T0, 57.6), pt(T1, 58.7)],
  };

  it('asks for everything in three batched queries: plan, site, database', async () => {
    const client = fakeClient(series);
    await _fetchMonitorMetrics(client, 'arm-token', credential, APP, SUB, T0, T1);
    const calls = client.queryResource.mock.calls.map(([resId, names]) => [resId.split('/').pop(), names]);
    expect(calls).toEqual([
      ['plan', ['CpuPercentage', 'MemoryPercentage']],
      ['medu-web', ['Requests', 'Http5xx']],
      ['db', ['cpu_percent', 'sql_instance_memory_percent']],
    ]);
  });

  it('returns the series the alerts read, summarized the same way as the full fetch', async () => {
    const m = await _fetchMonitorMetrics(fakeClient(series), 'arm-token', credential, APP, SUB, T0, T1);
    expect(m.cpu).toEqual(handler._summarize(series.CpuPercentage));
    expect(m.memory).toEqual(handler._summarize(series.MemoryPercentage));
    expect(m.memUnit).toBe('%');
    expect(m.dbCpu).toEqual(handler._summarize(series.cpu_percent));
    expect(m.dbMemory).toEqual(handler._summarize(series.sql_instance_memory_percent));
    expect(m.requestsSeries).toEqual([{ t: T0, count: 100 }, { t: T1, count: 120 }]);
    // App Insights per-instance failures, summed per minute, win over Azure Monitor Http5xx.
    expect(m.failedRequestsSeries).toEqual([{ t: T0, count: 3 }, { t: T1, count: 0 }]);
    expect(m.plan).toMatchObject({ farmId: FARM, sku: 'P1v3' });
    expect(m).toMatchObject({ label: 'medu-web', type: 'appservice', cpuUnit: '%' });
  });

  it('adds the API site\'s own requests and Http5xx when the app has an App Service API', async () => {
    const client = fakeClient(series);
    const m = await _fetchMonitorMetrics(client, 'arm-token', credential, { ...APP, apiName: 'medu-api' }, SUB, T0, T1);
    expect(client.queryResource.mock.calls.map(([resId, names]) => [resId.split('/').pop(), names]))
      .toContainEqual(['medu-api', ['Requests', 'Http5xx']]);
    expect(m.apiRequestsSeries).toEqual([{ t: T0, count: 100 }, { t: T1, count: 120 }]);
    expect(m.apiFailedRequestsSeries).toEqual([{ t: T0, count: 5 }, { t: T1, count: 0 }]);
  });

  it('leaves the API series out with no API, or a Container App API without App Insights', async () => {
    const none = await _fetchMonitorMetrics(fakeClient(series), 'arm-token', credential, APP, SUB, T0, T1);
    expect(none.apiRequestsSeries).toBeNull();
    const client = fakeClient(series);
    const ca = await _fetchMonitorMetrics(client, 'arm-token', credential, { ...APP, apiName: 'api', apiType: 'containerapp' }, SUB, T0, T1);
    expect(ca.apiFailedRequestsSeries).toBeNull();
    expect(client.queryResource).toHaveBeenCalledTimes(3);
  });

  /** App Insights answers the API's per-minute query; everything else as before. */
  const withApiInsights = () => {
    const inner = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url, init) => (String(init?.body ?? '').includes('sumif(itemCount')
      ? { ok: true, json: async () => ({ tables: [{ rows: [[T0, 200, 4], [T1, 100, 0]] }] }) }
      : inner(url, init)));
  };

  it('reads the API 5xx from its App Insights when it has one, ahead of Azure Monitor', async () => {
    withApiInsights();
    const client = fakeClient(series);
    const m = await _fetchMonitorMetrics(client, 'arm-token', credential, { ...APP, apiName: 'medu-api', apiInsightsAppId: 'ai-api' }, SUB, T0, T1);
    expect(m.apiRequestsSeries).toEqual([{ t: T0, count: 200 }, { t: T1, count: 100 }]);
    expect(m.apiFailedRequestsSeries).toEqual([{ t: T0, count: 4 }, { t: T1, count: 0 }]);
    // No Azure Monitor query for the API site.
    expect(client.queryResource.mock.calls.some(([resId]) => resId.endsWith('/medu-api'))).toBe(false);
    const body = JSON.parse(fetchMock.mock.calls.find(([u, i]) => String(u).includes('/apps/ai-api/') && i)[1].body);
    expect(body.query).toContain('rc >= 500 or (success == false');
  });

  it('gives a Container App API its 5xx split too, through App Insights', async () => {
    withApiInsights();
    const app = { ...APP, type: 'containerapp', apiName: 'msp-api', apiType: 'containerapp', apiInsightsAppId: 'ai-api' };
    const m = await _fetchMonitorMetrics(fakeClient(series), 'arm-token', credential, app, SUB, T0, T1);
    expect(m.apiFailedRequestsSeries).toEqual([{ t: T0, count: 4 }, { t: T1, count: 0 }]);
  });

  it('counts only true 5xx from App Insights, never every failed request (which takes in 4xx)', async () => {
    await _fetchMonitorMetrics(fakeClient(series), 'arm-token', credential, APP, SUB, T0, T1);
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u).includes('/apps/ai-1/query'));
    const { query } = JSON.parse(init.body);
    expect(query).toContain('failedCount=countif(rc >= 500 or (success == false');
    expect(query).not.toMatch(/countif\(success\s*==\s*false\)/);
  });

  it('falls back to Azure Monitor Http5xx when App Insights is not configured', async () => {
    const app = { ...APP, appInsightsAppId: undefined };
    // No App Insights component found by discovery either.
    fetchMock.mockImplementation(async (url) => (String(url).includes('/components')
      ? { ok: true, json: async () => ({ value: [] }) }
      : String(url).includes('appsettings')
        ? { ok: true, json: async () => ({ properties: {} }) }
        : String(url).includes('/serverfarms/')
          ? { ok: true, json: async () => ({ sku: { name: 'P1v3' }, properties: {} }) }
          : { ok: true, json: async () => ({ properties: { serverFarmId: FARM } }) }));
    const m = await _fetchMonitorMetrics(fakeClient(series), 'arm-token', credential, app, SUB, T0, T1);
    expect(m.failedRequestsSeries).toEqual([{ t: T0, count: 5 }, { t: T1, count: 0 }]);
  });

  it('falls back to the site working set in MB when the plan has no memory percentage', async () => {
    const client = fakeClient({ ...series, MemoryPercentage: undefined, MemoryWorkingSet: [pt(T0, 512 * 1024 * 1024)] });
    const m = await _fetchMonitorMetrics(client, 'arm-token', credential, APP, SUB, T0, T1);
    expect(m.memUnit).toBe('MB');
    expect(m.memory.series[0].v).toBe(512);
    expect(client.queryResource.mock.calls.at(-1)[1]).toEqual(['MemoryWorkingSet']);
  });

  it('leaves the database out when none is configured', async () => {
    const app = { ...APP, dbName: undefined, dbServerName: undefined };
    const client = fakeClient(series);
    const m = await _fetchMonitorMetrics(client, 'arm-token', credential, app, SUB, T0, T1);
    expect(m.dbCpu).toBeNull();
    expect(m.dbMemory).toBeNull();
    expect(client.queryResource).toHaveBeenCalledTimes(2);
  });

  it('looks the plan up once, not on every check', async () => {
    const client = fakeClient(series);
    await _fetchMonitorMetrics(client, 'arm-token', credential, APP, SUB, T0, T1);
    await _fetchMonitorMetrics(client, 'arm-token', credential, APP, SUB, T0, T1);
    const armCalls = fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://management.azure.com'));
    expect(armCalls).toHaveLength(2); // site + serverfarm, first check only
  });

  it('fails the check when the plan metrics cannot be read', async () => {
    const client = { queryResource: vi.fn(async () => { throw new Error('AuthorizationFailed'); }) };
    await expect(_fetchMonitorMetrics(client, 'arm-token', credential, APP, SUB, T0, T1)).rejects.toThrow('AuthorizationFailed');
  });
});
