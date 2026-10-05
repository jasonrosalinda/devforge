// Loads a Confluence page and every screenshot on it, for Release Pilot and
// Release Runbook. The main process fetches the page and its REST attachments;
// screenshots the REST list misses are fetched by their <img> URL and merged in.

import { collectImageUrls, type RunbookAttachment } from '@/lib/parse-runbook';

/** localStorage key for recently loaded runbook URLs, shared by both runbook pages. */
export const RUNBOOK_URL_HISTORY_KEY = 'release-pilot:runbook-urls';

export type RunbookConfluenceApi = Pick<Window['electronAPI']['confluence'], 'fetchRunbook' | 'fetchImages'>;

type FetchRunbookResult = Awaited<ReturnType<RunbookConfluenceApi['fetchRunbook']>>;

export interface RunbookCreds {
  baseUrl: string;
  email: string;
  apiToken: string;
}

/** The loaded page, with REST and HTML-fetched screenshots merged into `attachments`. */
export type RunbookPage = Omit<FetchRunbookResult, 'attachments'> & { attachments: RunbookAttachment[] };

/** Screenshot fetch diagnostics: how many came down, and the first failure if any. */
export interface ImageFetchStats {
  fetched: number;
  total: number;
  sampleUrl?: string | undefined;
  status?: number | undefined;
  err?: string | undefined;
  textHead?: string | undefined;
}

export type LoadRunbookResult =
  | { ok: true; page: RunbookPage; imageStats: ImageFetchStats }
  | { ok: false; error: string; authFailed: boolean };

const baseOf = (u: string) => decodeURIComponent((u.split('?')[0]?.split('/').pop()) || '').toLowerCase();

export async function loadRunbook(
  api: RunbookConfluenceApi | undefined,
  creds: RunbookCreds,
  pageUrl: string,
): Promise<LoadRunbookResult> {
  const res = await api?.fetchRunbook({ ...creds, pageUrl });
  if (!api || !res) return { ok: false, error: 'Confluence bridge unavailable.', authFailed: false };
  if (!res.ok) {
    const error = res.error || 'Failed to load runbook.';
    // An auth-shaped failure means the token state on screen is stale.
    return { ok: false, error, authFailed: /\b40[13]\b/.test(error) };
  }

  // Primary: attachments downloaded by the main process via the REST
  // _links.download path (accepts API-token Basic auth).
  let attachments: RunbookAttachment[] = (res.attachments ?? []).map(a => ({
    filename: a.filename,
    mediaType: a.mediaType,
    isImage: a.isImage,
    dataUri: a.dataUri,
    id: a.id,
    fileId: a.fileId,
    srcUrl: a.srcUrl,
  }));

  const imageStats: ImageFetchStats = {
    fetched: res.attDebug?.downloaded ?? attachments.length,
    total: res.attDebug?.listed ?? attachments.length,
    err: res.attDebug?.firstErr,
    status: res.attDebug?.listStatus,
    sampleUrl: 'REST _links.download',
  };

  // The REST child/attachment list is unreliable — editor "media" images
  // (download-link <img>s) often aren't listed, so REST may return only a
  // macro icon. Fetch every <img> URL in the HTML that REST didn't already
  // cover (by filename) and merge it in, keyed by its source URL.
  if (res.html) {
    const restNames = new Set(attachments.map(a => a.filename.toLowerCase()));
    const missing = collectImageUrls(res.html).filter(u => {
      const b = baseOf(u);
      return b && !restNames.has(b);
    });
    if (missing.length > 0) {
      const results = (await api.fetchImages({ urls: missing }))?.results ?? [];
      const failed = results.filter(r => !r.ok);
      const firstFail = failed[0];
      imageStats.fetched += results.length - failed.length;
      imageStats.total += missing.length;
      if (firstFail) {
        imageStats.sampleUrl = firstFail.url;
        imageStats.status = firstFail.status;
        imageStats.err = firstFail.error;
        imageStats.textHead = firstFail.textHead;
      }
      attachments = [
        ...attachments,
        ...results
          .filter(r => r.ok && r.dataUri)
          .map(r => ({
            filename: r.url.split('/').pop()?.split('?')[0] || 'image',
            mediaType: r.mediaType || 'image/png',
            isImage: r.isImage ?? true,
            dataUri: r.dataUri as string,
            srcUrl: r.url,
          })),
      ];
    }
  }

  console.info('[runbook] attachments:', attachments.length, 'attDebug:', res.attDebug);
  return { ok: true, page: { ...res, attachments }, imageStats };
}
