import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  parseActivitySwaps, parseKuduDeployments, parseRevisions, mergeReleases, fetchReleases, MAX_ACTIVITY_PAGES,
} = require('./azure-releases.cjs');

const SITE = '/subscriptions/sub/resourceGroups/PRDMEDU-RG/providers/Microsoft.Web/sites/prdmeduapp';
const SITE_UPPER = SITE.toUpperCase();

const activity = (over = {}) => ({
  eventTimestamp: '2026-10-20T09:11:56.8475109Z',
  operationName: { value: 'Microsoft.Web/sites/slots/slotsswap/action' },
  status: { value: 'Succeeded' },
  resourceId: `${SITE}/slots/swapslot`,
  correlationId: 'c1',
  caller: 'pipeline@mims.com',
  ...over,
});

// The release pipeline's Kudu records, as Azure DevOps writes them on the production site.
const kudu = (type, time, releaseId, over = {}) => ({
  properties: {
    status: 4,
    start_time: time,
    end_time: time,
    author: 'Rio Cadelina',
    deployer: 'VSTS',
    message: JSON.stringify({ type, commitId: 'b0fa303cbceda3b2ad6ccaa7a817ddd0f1f2fd52', buildId: '29540', releaseId, buildNumber: '20261015.2' }),
    ...over,
  },
});

describe('parseActivitySwaps', () => {
  it('keeps a succeeded swap on one of the site\'s slots', () => {
    const [ev] = parseActivitySwaps([activity()], SITE);
    expect(ev).toEqual({ at: '2026-10-20T09:11:56.847Z', source: 'swap', by: 'pipeline@mims.com', message: 'Swap from slot swapslot' });
  });

  it('matches the resource id case-insensitively and accepts the classic op casing', () => {
    const out = parseActivitySwaps([activity({ resourceId: `${SITE_UPPER}/SLOTS/SWAPSLOT`, operationName: { value: 'Microsoft.Web/sites/slots/SlotsSwap/action' } })], SITE);
    expect(out).toHaveLength(1);
  });

  it('accepts a swap logged on the site itself', () => {
    const out = parseActivitySwaps([activity({ resourceId: SITE, operationName: { value: 'Microsoft.Web/sites/slotsswap/action' } })], SITE);
    expect(out[0].message).toBe('Slot swap');
  });

  it('drops started/accepted records, other operations, and other sites sharing the prefix', () => {
    const out = parseActivitySwaps([
      activity({ status: { value: 'Accepted' } }),
      activity({ operationName: { value: 'Microsoft.Web/sites/restart/action' } }),
      activity({ resourceId: `${SITE}2/slots/swapslot` }),
      activity({ resourceId: SITE.replace('prdmeduapp', 'prdmeduapi') }),
    ], SITE);
    expect(out).toEqual([]);
  });

  it('keeps one record per correlation id and skips unparseable timestamps', () => {
    const out = parseActivitySwaps([activity(), activity(), activity({ correlationId: 'c2', eventTimestamp: 'nope' })], SITE);
    expect(out).toHaveLength(1);
  });

  it('leaves out a service principal\'s object id as the caller', () => {
    const [ev] = parseActivitySwaps([activity({ caller: 'b5f460a8-33f9-44e9-8bc8-4e3ea42a153d' })], SITE);
    expect(ev.by).toBeUndefined();
  });

  it('tolerates a missing list', () => {
    expect(parseActivitySwaps(undefined, SITE)).toEqual([]);
  });
});

describe('parseKuduDeployments', () => {
  it('drops the slot deploy that a swap of the same release followed', () => {
    const out = parseKuduDeployments([
      kudu('SlotSwap', '2026-10-20T09:12:08.1519026Z', '13599'),
      kudu('Deployment', '2026-10-20T09:10:17.0600957Z', '13599'),
    ]);
    expect(out).toEqual([{
      at: '2026-10-20T09:12:08.151Z', source: 'swap', by: 'Rio Cadelina', build: '20261015.2', commit: 'b0fa303c', message: undefined,
    }]);
  });

  it('keeps a pipeline deploy that no swap followed', () => {
    const [ev] = parseKuduDeployments([kudu('Deployment', '2026-07-23T10:12:27Z', '4502', {})]);
    expect(ev.source).toBe('deploy');
  });

  it('reads a plain-text OneDeploy record, falling back to the deployer when author is N/A', () => {
    const [ev] = parseKuduDeployments([{ properties: { status: 4, start_time: '2026-08-10T09:25:27Z', end_time: '2026-08-10T09:25:35Z', author: 'N/A', deployer: 'OneDeploy', message: 'OneDeploy' } }]);
    expect(ev).toMatchObject({ at: '2026-08-10T09:25:35.000Z', source: 'deploy', by: 'OneDeploy', message: 'OneDeploy' });
  });

  it('skips failed deployments, records without a time, and broken JSON as plain text', () => {
    const out = parseKuduDeployments([
      kudu('Deployment', '2026-10-01T00:00:00Z', '1', { status: 3 }),
      { properties: { status: 4 } },
      { properties: { status: 4, end_time: 'garbage' } },
      { properties: { status: 4, end_time: '2026-10-02T00:00:00Z', message: '{not json' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe('{not json');
  });
});

describe('parseRevisions', () => {
  it('turns each revision into a release', () => {
    expect(parseRevisions([
      { name: 'api--r2', properties: { createdTime: '2026-10-01T01:00:00Z' } },
      { name: 'api--r1', properties: {} },
    ])).toEqual([{ at: '2026-10-01T01:00:00.000Z', source: 'revision', message: 'Revision api--r2' }]);
  });
});

describe('mergeReleases', () => {
  it('collapses the Activity Log and Kudu views of one swap, keeping the earliest time and both details', () => {
    const merged = mergeReleases(
      [{ at: '2026-10-20T09:11:56.847Z', source: 'swap', by: 'pipeline@mims.com' }],
      [{ at: '2026-10-20T09:12:08.151Z', source: 'swap', by: 'Rio Cadelina', build: '20261015.2', commit: 'b0fa303c' }],
    );
    expect(merged).toEqual([{ at: '2026-10-20T09:11:56.847Z', source: 'swap', by: 'pipeline@mims.com', build: '20261015.2', commit: 'b0fa303c' }]);
  });

  it('upgrades a collapsed deploy to a swap and keeps distant releases apart, oldest first', () => {
    const merged = mergeReleases(
      [{ at: '2026-10-20T09:12:00Z', source: 'swap' }],
      [{ at: '2026-10-20T09:11:00Z', source: 'deploy', message: 'x' }, { at: '2026-09-23T09:15:00Z', source: 'deploy' }],
    );
    expect(merged.map(e => e.source)).toEqual(['deploy', 'swap']);
    expect(merged[1]).toEqual({ at: '2026-10-20T09:11:00Z', source: 'swap', message: 'x' });
  });
});

describe('fetchReleases', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const ok = (json) => ({ ok: true, status: 200, statusText: 'OK', json: async () => json });
  const fail = (status) => ({ ok: false, status, statusText: 'Nope', json: async () => ({}) });
  const opts = {
    subscriptionId: 'sub', resourceGroup: 'PRDMEDU-RG', siteResId: SITE, isAppService: true,
    startIso: '2026-10-20T00:00:00Z', endIso: '2026-10-21T00:00:00Z',
  };

  it('merges both sources for an App Service and reports each as ok', async () => {
    const fetchMock = vi.fn(async (url) => {
      if (url.includes('eventtypes/management')) return ok({ value: [activity()] });
      if (url.includes('/deployments')) return ok({ value: [kudu('SlotSwap', '2026-10-20T09:12:08Z', '13599'), kudu('SlotSwap', '2026-10-21T05:00:00Z', '13600')] });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchReleases('tok', opts);
    expect(r.sources).toEqual({ activityLog: 'ok', kudu: 'ok' });
    // The later Kudu record is past the window's end and is cut.
    expect(r.events).toHaveLength(1);
    expect(r.last).toMatchObject({ source: 'swap', build: '20261015.2', by: 'pipeline@mims.com' });
    const alUrl = decodeURIComponent(fetchMock.mock.calls.find(([u]) => u.includes('eventtypes'))[0]);
    expect(alUrl).toContain("resourceGroupName eq 'PRDMEDU-RG'");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
  });

  it('looks back 30 days even for a short window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
    try {
      const fetchMock = vi.fn(async (url) => ok({ value: [] }));
      vi.stubGlobal('fetch', fetchMock);
      await fetchReleases('tok', opts);
      const alUrl = decodeURIComponent(fetchMock.mock.calls.find(([u]) => u.includes('eventtypes'))[0]);
      expect(alUrl).toContain("eventTimestamp ge '2026-09-21T00:00:00.000Z'");
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks a 403 source denied and still returns the other', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url) => (url.includes('eventtypes')
      ? fail(403)
      : ok({ value: [kudu('Deployment', '2026-10-20T09:00:00Z', '1')] }))));
    const r = await fetchReleases('tok', opts);
    expect(r.sources).toEqual({ activityLog: 'denied', kudu: 'ok' });
    expect(r.last.source).toBe('deploy');
  });

  it('marks a thrown or 500 source as error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('eventtypes')) throw new Error('network');
      return fail(500);
    }));
    const r = await fetchReleases('tok', opts);
    expect(r).toEqual({ events: [], last: null, sources: { activityLog: 'error', kudu: 'error' } });
  });

  it('follows nextLink up to the page cap and keeps earlier pages when a later one fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let pages = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/deployments')) return ok({ value: [] });
      pages++;
      return ok({ value: [activity({ correlationId: `c${pages}`, eventTimestamp: `2026-10-${String(pages).padStart(2, '0')}T00:00:00Z` })], nextLink: 'https://management.azure.com/next' });
    }));
    const r = await fetchReleases('tok', opts);
    expect(pages).toBe(MAX_ACTIVITY_PAGES);
    expect(r.events).toHaveLength(MAX_ACTIVITY_PAGES);

    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (url.includes('/deployments')) return ok({ value: [] });
      calls++;
      return calls === 1 ? ok({ value: [activity()], nextLink: 'https://management.azure.com/next' }) : fail(500);
    }));
    const r2 = await fetchReleases('tok', opts);
    expect(r2.sources.activityLog).toBe('ok');
    expect(r2.events).toHaveLength(1);
  });

  it('reads revisions for a Container App', async () => {
    const fetchMock = vi.fn(async () => ok({ value: [{ name: 'r1', properties: { createdTime: '2026-10-20T03:00:00Z' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchReleases('tok', { ...opts, isAppService: false, siteResId: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.App/containerApps/api' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/revisions?');
    expect(r.sources).toEqual({ revisions: 'ok' });
    expect(r.last.source).toBe('revision');
  });

  it('reports a failed revisions call as error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const r = await fetchReleases('tok', { ...opts, isAppService: false });
    expect(r.sources).toEqual({ revisions: 'error' });
  });
});
