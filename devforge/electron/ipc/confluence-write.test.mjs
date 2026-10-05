import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { getPage, updatePage, createPage, searchUsers, lookupUsers, uploadAttachment, fetchAttachment } = require('./confluence-write.cjs');

const CREDS = { baseUrl: 'https://x.atlassian.net/', email: 'me@x.com', apiToken: 'tok' };
const AUTH = 'Basic ' + Buffer.from('me@x.com:tok').toString('base64');

// Records each request and answers from a queue of canned responses.
function fakeFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', headers: init.headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body });
    const r = responses.shift() ?? { status: 500, json: {} };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
      text: async () => (typeof r.json === 'string' ? r.json : JSON.stringify(r.json)),
    };
  };
  return { fetchImpl, calls };
}

const PAGE_JSON = {
  id: '42', title: '26 Oct 2026 MSP V3.16.0 Deployment Runbook',
  version: { number: 5, by: { displayName: 'Hanes' }, when: '2026-10-05T09:07:00.000Z' },
  space: { key: 'MIMSCOM' },
  ancestors: [{ id: '1', title: 'Releases' }, { id: '7', title: '2026' }],
  body: { storage: { value: '<p>hi</p>' } },
  _links: { webui: '/spaces/MIMSCOM/pages/42/Runbook' },
};

describe('getPage', () => {
  it('reads storage, version, space and direct parent with the API token', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, json: PAGE_JSON });

    const res = await getPage({ ...CREDS, pageUrl: 'https://x.atlassian.net/wiki/spaces/MIMSCOM/pages/42/Runbook' }, fetchImpl);

    expect(calls[0].url).toBe('https://x.atlassian.net/wiki/rest/api/content/42?expand=body.storage,version,space,ancestors');
    expect(calls[0].headers.Authorization).toBe(AUTH);
    expect(res).toEqual({
      ok: true, pageId: '42', title: '26 Oct 2026 MSP V3.16.0 Deployment Runbook', version: 5,
      by: 'Hanes', when: '2026-10-05T09:07:00.000Z', spaceKey: 'MIMSCOM', parentId: '7', storage: '<p>hi</p>',
      url: 'https://x.atlassian.net/wiki/spaces/MIMSCOM/pages/42/Runbook',
    });
  });

  it('rejects a URL with no page id before calling Confluence', async () => {
    const { fetchImpl, calls } = fakeFetch();
    expect(await getPage({ ...CREDS, pageUrl: 'https://x/wiki/home' }, fetchImpl)).toEqual({
      ok: false, error: 'Could not parse a page ID from that URL.',
    });
    expect(calls).toEqual([]);
  });

  it('passes on Confluence\'s reason for a failure', async () => {
    const { fetchImpl } = fakeFetch({ status: 404, json: { message: 'No content found with id 42' } });
    expect(await getPage({ ...CREDS, pageUrl: '42' }, fetchImpl)).toEqual({
      ok: false, status: 404, error: 'Confluence responded 404. No content found with id 42',
    });
  });
});

describe('updatePage', () => {
  const edit = { ...CREDS, pageId: '42', title: 'T', storage: '<p>new</p>', baseVersion: 5 };

  it('saves the storage body as the next version with a devForge message', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, json: { version: { number: 6 }, _links: { webui: '/x' } } });

    const res = await updatePage(edit, fetchImpl);

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://x.atlassian.net/wiki/rest/api/content/42');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({
      id: '42', type: 'page', title: 'T',
      version: { number: 6, message: 'Updated via devForge Runbook Editor' },
      body: { storage: { value: '<p>new</p>', representation: 'storage' } },
    });
    expect(res).toEqual({ ok: true, version: 6 });
  });

  it('reports who changed the page when the version is out of date, and never retries', async () => {
    const { fetchImpl, calls } = fakeFetch(
      { status: 409, json: { message: 'Version must be incremented on update. Current version is: 7' } },
      { status: 200, json: { version: { number: 7, by: { displayName: 'Jubilee Almonte' }, when: '2026-10-26T10:15:00.000Z' } } },
    );

    const res = await updatePage(edit, fetchImpl);

    expect(calls.map(c => c.method)).toEqual(['PUT', 'GET']);
    expect(calls[1].url).toBe('https://x.atlassian.net/wiki/rest/api/content/42?expand=version');
    expect(res).toEqual({
      ok: false, conflict: true, latestVersion: 7, by: 'Jubilee Almonte', when: '2026-10-26T10:15:00.000Z',
      error: 'The page changed in Confluence since you loaded it.',
    });
  });

  it('explains a 403 as missing edit permission', async () => {
    const { fetchImpl } = fakeFetch({ status: 403, json: { message: 'Not permitted' } });
    expect(await updatePage(edit, fetchImpl)).toEqual({
      ok: false, status: 403,
      error: 'Confluence responded 403. Not permitted — your account (or a scoped API token) cannot edit this page.',
    });
  });
});

describe('createPage', () => {
  it('creates the page in the space under the given parent', async () => {
    const { fetchImpl, calls } = fakeFetch({ status: 200, json: { id: '99', version: { number: 1 }, _links: { webui: '/spaces/MIMSCOM/pages/99/New' } } });

    const res = await createPage({ ...CREDS, spaceKey: 'MIMSCOM', parentId: '7', title: '2 Nov 2026 Runbook', storage: '<p>x</p>' }, fetchImpl);

    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('https://x.atlassian.net/wiki/rest/api/content');
    expect(calls[0].body).toEqual({
      type: 'page', title: '2 Nov 2026 Runbook', space: { key: 'MIMSCOM' }, ancestors: [{ id: '7' }],
      body: { storage: { value: '<p>x</p>', representation: 'storage' } },
    });
    expect(res).toEqual({ ok: true, pageId: '99', version: 1, url: 'https://x.atlassian.net/wiki/spaces/MIMSCOM/pages/99/New' });
  });

  it('says so when the title is already taken in the space', async () => {
    const { fetchImpl } = fakeFetch({ status: 400, json: { message: 'A page with this title already exists: A page already exists with the title 2 Nov 2026 Runbook in this space' } });
    const res = await createPage({ ...CREDS, spaceKey: 'MIMSCOM', parentId: '7', title: '2 Nov 2026 Runbook', storage: '' }, fetchImpl);
    expect(res).toMatchObject({ ok: false, status: 400, duplicateTitle: true });
  });
});

describe('searchUsers', () => {
  it('finds people by name for the PIC picker', async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      json: { results: [
        { user: { accountId: 'a1', displayName: 'Jason Rosalinda', email: 'jason@x.com' } },
        { user: { accountId: 'a2', displayName: 'Jason Lim' } },
        { title: 'not a user' },
      ] },
    });

    const res = await searchUsers({ ...CREDS, query: 'Jas"on' }, fetchImpl);

    expect(calls[0].url).toBe(
      'https://x.atlassian.net/wiki/rest/api/search/user?limit=8&cql=' + encodeURIComponent('user.fullname~"Jason"'),
    );
    expect(res).toEqual({ ok: true, users: [
      { accountId: 'a1', displayName: 'Jason Rosalinda' },
      { accountId: 'a2', displayName: 'Jason Lim' },
    ] });
  });

  it('skips the call for a blank query', async () => {
    const { fetchImpl, calls } = fakeFetch();
    expect(await searchUsers({ ...CREDS, query: '  ' }, fetchImpl)).toEqual({ ok: true, users: [] });
    expect(calls).toEqual([]);
  });
});

describe('lookupUsers', () => {
  it('resolves mention account ids to names in one call', async () => {
    const { fetchImpl, calls } = fakeFetch({
      status: 200,
      json: { results: [{ accountId: 'a1', displayName: 'Jason Rosalinda' }, { accountId: 'a2', publicName: 'Hanes' }] },
    });

    const res = await lookupUsers({ ...CREDS, accountIds: ['a1', 'a2', 'a1'] }, fetchImpl);

    expect(calls[0].url).toBe('https://x.atlassian.net/wiki/rest/api/user/bulk?accountId=a1&accountId=a2');
    expect(res).toEqual({ ok: true, users: [
      { accountId: 'a1', displayName: 'Jason Rosalinda' },
      { accountId: 'a2', displayName: 'Hanes' },
    ] });
  });

  it('skips the call when there is nobody to look up', async () => {
    const { fetchImpl, calls } = fakeFetch();
    expect(await lookupUsers({ ...CREDS, accountIds: [] }, fetchImpl)).toEqual({ ok: true, users: [] });
    expect(calls).toEqual([]);
  });
});

describe('uploadAttachment', () => {
  it('posts the file as multipart with the no-check header', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ results: [{ id: 'att1' }] }), text: async () => '' }; };

    const res = await uploadAttachment({ ...CREDS, pageId: '42', filename: 'devforge-20261109-180000-1.png', mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }, fetchImpl);

    expect(res).toEqual({ ok: true });
    expect(calls[0].url).toBe('https://x.atlassian.net/wiki/rest/api/content/42/child/attachment');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers['X-Atlassian-Token']).toBe('nocheck');
    expect(calls[0].init.headers.Authorization).toBe(AUTH);
    const file = calls[0].init.body.get('file');
    expect(file.name).toBe('devforge-20261109-180000-1.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(4);
  });

  it('reports a rejected upload with Confluence\'s reason', async () => {
    const { fetchImpl } = fakeFetch({ status: 400, json: { message: 'Cannot add a new attachment with same file name as an existing attachment' } });
    expect(await uploadAttachment({ ...CREDS, pageId: '42', filename: 'a.png', mediaType: 'image/png', bytes: new Uint8Array([1]) }, fetchImpl))
      .toEqual({ ok: false, status: 400, error: 'Confluence responded 400. Cannot add a new attachment with same file name as an existing attachment' });
  });
});

describe('fetchAttachment', () => {
  it('finds the attachment by filename and returns it as a data URI', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push(url);
      if (url.includes('/child/attachment')) return { ok: true, status: 200, json: async () => ({ results: [{ _links: { download: '/download/attachments/42/a.png?version=1' } }] }) };
      return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    };

    const res = await fetchAttachment({ ...CREDS, pageId: '42', filename: 'a b.png' }, fetchImpl);

    expect(calls).toEqual([
      'https://x.atlassian.net/wiki/rest/api/content/42/child/attachment?filename=a%20b.png',
      'https://x.atlassian.net/wiki/download/attachments/42/a.png?version=1',
    ]);
    expect(res).toEqual({ ok: true, dataUri: 'data:image/png;base64,AQID' });
  });

  it('says so when the page has no attachment with that name', async () => {
    const { fetchImpl } = fakeFetch({ status: 200, json: { results: [] } });
    expect(await fetchAttachment({ ...CREDS, pageId: '42', filename: 'gone.png' }, fetchImpl))
      .toEqual({ ok: false, error: 'No attachment named gone.png on this page.' });
  });
});

