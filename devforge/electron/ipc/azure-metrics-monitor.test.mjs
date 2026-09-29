import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./azure-metrics.cjs');

const { _createCachingCredential, _setCached, _cacheSize, _fetchMonitorMetrics, _clearLookups } = handler;

const MIN = 60_000;

describe('createCachingCredential', () => {
  const token = (value, expiresInMs) => ({ token: value, expiresOnTimestamp: Date.now() + expiresInMs });

  it('reuses a token until 5 minutes before it expires, then fetches a new one', async () => {
    vi.useFakeTimers();
    try {
      const inner = { getToken: vi.fn().mockResolvedValueOnce(token('a', 60 * MIN)).mockResolvedValueOnce(token('b', 60 * MIN)) };
      const cred = _createCachingCredential(inner);
      expect((await cred.getToken('scope')).token).toBe('a');
      vi.advanceTimersByTime(54 * MIN);
      expect((await cred.getToken('scope')).token).toBe('a');
      vi.advanceTimersByTime(2 * MIN);
      expect((await cred.getToken('scope')).token).toBe('b');
      expect(inner.getToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const inner = { getToken: vi.fn().mockResolvedValue(token('a', 60 * MIN)) };
    const cred = _createCachingCredential(inner);
    const [x, y] = await Promise.all([cred.getToken('scope'), cred.getToken('scope')]);
    expect(x).toBe(y);
    expect(inner.getToken).toHaveBeenCalledTimes(1);
  });

  it('keeps scopes apart, whether passed as a string or an array', async () => {
    const inner = { getToken: vi.fn(async (s) => token(String(s), 60 * MIN)) };
    const cred = _createCachingCredential(inner);
    await cred.getToken('arm');
    await cred.getToken(['arm']);
    await cred.getToken('insights');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  it("treats MetricsQueryClient's double-slash scope as the same resource", async () => {
    const inner = { getToken: vi.fn(async () => token('a', 60 * MIN)) };
    const cred = _createCachingCredential(inner);
    await cred.getToken('https://management.azure.com/.default');
    await cred.getToken(['https://management.azure.com//.default']);
    expect(inner.getToken).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failure, so the next call tries again', async () => {
    const inner = { getToken: vi.fn().mockRejectedValueOnce(new Error('az login')).mockResolvedValueOnce(token('a', 60 * MIN)) };
    const cred = _createCachingCredential(inner);
    await expect(cred.getToken('scope')).rejects.toThrow('az login');
    expect((await cred.getToken('scope')).token).toBe('a');
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
