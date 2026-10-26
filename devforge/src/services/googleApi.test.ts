import { afterEach, describe, expect, it, vi } from 'vitest';
import { googleApi } from './googleApi';

const okResponse = () => ({
    ok: true,
    json: async () => ({ lighthouseResult: { audits: {}, fetchTime: '2026-10-26T11:00:00.000Z' } }),
}) as unknown as Response;

describe('googleApi.runPagespeed', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('bypasses the HTTP cache so a re-run is a fresh audit, not a stored response', async () => {
        const fetchMock = vi.fn(async () => okResponse());
        vi.stubGlobal('fetch', fetchMock);

        await googleApi.runPagespeed('https://example.com/', 'key', 'mobile', 1, 'average', undefined, false);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
        expect(init.cache).toBe('no-store');
    });
});
