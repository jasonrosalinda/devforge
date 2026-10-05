// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { loadRunbook, type RunbookConfluenceApi } from './load-runbook';

const CREDS = { baseUrl: 'https://x.atlassian.net', email: 'me@x.com', apiToken: 'tok' };
const PAGE_URL = 'https://x.atlassian.net/wiki/spaces/S/pages/1/Runbook';

type FetchRunbookResult = Awaited<ReturnType<RunbookConfluenceApi['fetchRunbook']>>;
type FetchImagesResult = Awaited<ReturnType<RunbookConfluenceApi['fetchImages']>>;

// Records what the loader asked the main process for, and answers with canned replies.
function fakeApi(page: FetchRunbookResult, images: FetchImagesResult = { results: [] }) {
  const calls = { fetchRunbook: [] as unknown[], fetchImages: [] as string[][] };
  const api: RunbookConfluenceApi = {
    fetchRunbook: async (opts) => { calls.fetchRunbook.push(opts); return page; },
    fetchImages: async ({ urls }) => { calls.fetchImages.push(urls); return images; },
  };
  return { api, calls };
}

const REST_ATT = { filename: 'ga.png', mediaType: 'image/png', isImage: true, dataUri: 'data:image/png;base64,AAA', id: 'att1' };

describe('loadRunbook — failures', () => {
  it('reports a missing Confluence bridge (browser preview, no Electron)', async () => {
    expect(await loadRunbook(undefined, CREDS, PAGE_URL)).toEqual({
      ok: false, error: 'Confluence bridge unavailable.', authFailed: false,
    });
  });

  it('flags a 401 so the page can re-check the token', async () => {
    const { api } = fakeApi({ ok: false, error: 'HTTP 401 Unauthorized' });
    expect(await loadRunbook(api, CREDS, PAGE_URL)).toEqual({
      ok: false, error: 'HTTP 401 Unauthorized', authFailed: true,
    });
  });

  it('does not flag a server error as an auth failure', async () => {
    const { api } = fakeApi({ ok: false, error: 'HTTP 500' });
    expect(await loadRunbook(api, CREDS, PAGE_URL)).toMatchObject({ ok: false, authFailed: false });
  });

  it('falls back to a generic message when Confluence gives none', async () => {
    const { api } = fakeApi({ ok: false });
    expect(await loadRunbook(api, CREDS, PAGE_URL)).toMatchObject({ ok: false, error: 'Failed to load runbook.' });
  });
});

describe('loadRunbook — page and screenshots', () => {
  it('requests the page with the saved credentials', async () => {
    const { api, calls } = fakeApi({ ok: true, html: '<p>hi</p>' });
    await loadRunbook(api, CREDS, PAGE_URL);
    expect(calls.fetchRunbook).toEqual([{ ...CREDS, pageUrl: PAGE_URL }]);
  });

  it('keeps REST attachments and skips the image fetch when they cover every screenshot', async () => {
    const { api, calls } = fakeApi({
      ok: true, title: 'MSP V3.16.0 Runbook', version: 7,
      html: '<img src="https://x.atlassian.net/wiki/download/attachments/1/ga.png?version=1">',
      attachments: [REST_ATT],
      attDebug: { connected: true, listStatus: 200, listed: 1, downloaded: 1 },
    });

    const res = await loadRunbook(api, CREDS, PAGE_URL);

    expect(calls.fetchImages).toEqual([]);
    expect(res).toMatchObject({
      ok: true,
      page: { title: 'MSP V3.16.0 Runbook', version: 7, attachments: [REST_ATT] },
      imageStats: { fetched: 1, total: 1 },
    });
  });

  it('fetches only the screenshots REST did not list and merges them by source URL', async () => {
    const media = 'https://api.media.atlassian.com/file/u1/image?token=t';
    const { api, calls } = fakeApi(
      {
        ok: true,
        html: `<img src="https://x.atlassian.net/wiki/download/attachments/1/ga.png"><img src="${media}">`,
        attachments: [REST_ATT],
        attDebug: { connected: true, listStatus: 200, listed: 1, downloaded: 1 },
      },
      { results: [{ url: media, ok: true, status: 200, mediaType: 'image/jpeg', isImage: true, dataUri: 'data:image/jpeg;base64,BBB' }] },
    );

    const res = await loadRunbook(api, CREDS, PAGE_URL);

    expect(calls.fetchImages).toEqual([[media]]);
    expect(res.ok && res.page.attachments).toEqual([
      REST_ATT,
      { filename: 'image', mediaType: 'image/jpeg', isImage: true, dataUri: 'data:image/jpeg;base64,BBB', srcUrl: media },
    ]);
    expect(res.ok && res.imageStats).toEqual({
      fetched: 2, total: 2, sampleUrl: 'REST _links.download', status: 200, err: undefined,
    });
  });

  it('records the first failed screenshot fetch and leaves it out of the attachments', async () => {
    const bad = 'https://x.atlassian.net/wiki/download/thumbnails/1/broken.png';
    const { api } = fakeApi(
      { ok: true, html: `<img src="${bad}">`, attachments: [] },
      { results: [{ url: bad, ok: false, status: 403, error: 'Forbidden', textHead: '<html>login' }] },
    );

    const res = await loadRunbook(api, CREDS, PAGE_URL);

    expect(res.ok && res.page.attachments).toEqual([]);
    expect(res.ok && res.imageStats).toEqual({
      fetched: 0, total: 1, sampleUrl: bad, status: 403, err: 'Forbidden', textHead: '<html>login',
    });
  });
});
