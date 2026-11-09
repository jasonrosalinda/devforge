import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./azure-config.cjs');
const { _diffConfig: diffConfig, _compare: compare, _listSlots: listSlots, _siteApp: siteApp } = handler;

const SECRET = 'Server=db;Password=hunter2-very-secret';
const CONFIG = {
  subscriptionId: 'sub',
  apps: [
    { name: 'web', type: 'appservice', resourceGroup: 'rg', apiName: 'api', apiType: 'appservice' },
    { name: 'ca', type: 'containerapp', resourceGroup: 'rg2' },
  ],
};

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe('diffConfig', () => {
  const side = (settings, conns = {}, stickySettings = [], stickyConns = []) => ({ settings, conns, stickySettings, stickyConns });

  it('marks each name only-left, only-right, same or differs, sorted, with sticky flags', () => {
    const rows = diffConfig(
      side({ B: '1', A: 'x', Only: 'l' }, { Db: { value: SECRET, type: 'SQLAzure' } }, ['A']),
      side({ A: 'x', B: '2', New: 'r' }, { Db: { value: SECRET, type: 'SQLServer' } }),
    );
    expect(rows).toEqual([
      { name: 'A', kind: 'setting', status: 'same', sticky: true },
      { name: 'B', kind: 'setting', status: 'differs', sticky: false },
      { name: 'New', kind: 'setting', status: 'only-right', sticky: false },
      { name: 'Only', kind: 'setting', status: 'only-left', sticky: false },
      { name: 'Db', kind: 'connstr', status: 'differs', sticky: false, type: 'SQLAzure' },
    ]);
  });

  it('never returns a value', () => {
    const rows = diffConfig(side({ K: SECRET }, { C: { value: SECRET, type: 'Custom' } }), side({ K: 'other' }, {}));
    expect(JSON.stringify(rows)).not.toContain('hunter2');
  });
});

describe('siteApp', () => {
  it('resolves the web app or its API, and refuses Container Apps', () => {
    expect(siteApp(CONFIG, 'web', 'api')).toEqual({ name: 'api', resourceGroup: 'rg', type: 'appservice' });
    expect(() => siteApp(CONFIG, 'ca', 'web')).toThrow(/Container Apps/);
    expect(() => siteApp(CONFIG, 'nope', 'web')).toThrow(/not in Settings/);
  });
});

describe('ARM calls', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/slots?')) return json({ value: [{ name: 'web/staging' }, { name: 'web/blue' }] });
      if (u.includes('slotConfigNames')) return json({ properties: { appSettingNames: ['Sticky'] } });
      if (u.includes('connectionstrings/list')) return json({ properties: {} });
      if (u.includes('/slots/staging/config/appsettings')) return json({ properties: { Sticky: 'a', Key: SECRET } });
      return json({ properties: { Sticky: 'b', Key: SECRET } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('lists production plus slot short names', async () => {
    expect(await listSlots('t', 'sub', CONFIG.apps[0])).toEqual(['production', 'blue', 'staging']);
  });

  it('reads a slot through /slots/<name> and diffs it against production', async () => {
    const res = await compare('t', CONFIG, { appKey: 'web', site: 'web', slot: 'staging' }, { appKey: 'web', site: 'web', slot: 'production' });
    expect(res.errors).toEqual({});
    expect(res.rows).toEqual([
      { name: 'Key', kind: 'setting', status: 'same', sticky: false },
      { name: 'Sticky', kind: 'setting', status: 'differs', sticky: true },
    ]);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([u]) => String(u));
    expect(posts.some((u) => u.includes('/sites/web/slots/staging/config/appsettings/list'))).toBe(true);
    expect(posts.some((u) => u.includes('/sites/web/config/appsettings/list'))).toBe(true);
    expect(JSON.stringify(res)).not.toContain('hunter2');
  });

  it('reports a 403 on one side by name, with no response body, and no rows', async () => {
    fetchMock.mockImplementation(async (url) => (String(url).includes('/sites/api/')
      ? { ok: false, status: 403, json: async () => ({ error: { message: SECRET } }), text: async () => SECRET }
      : json({ properties: {} })));
    const res = await compare('t', CONFIG, { appKey: 'web', site: 'web' }, { appKey: 'web', site: 'api' });
    expect(res.rows).toEqual([]);
    expect(res.errors.left).toBeUndefined();
    expect(res.errors.right).toMatch(/Website Contributor.*rg/);
    expect(JSON.stringify(res)).not.toContain('hunter2');
  });
});
