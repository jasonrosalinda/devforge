import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const mod = require('./toolbox-fetch.cjs');
const { _checkUrl: checkUrl, _fetchText: fetchText, MAX_BYTES } = mod;

const response = (body, { status = 200, headers = {} } = {}) => ({
  ok: status < 400,
  status,
  url: 'https://example.com/final.json',
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

describe('checkUrl', () => {
  it('accepts http(s) only', () => {
    expect(checkUrl(' https://example.com/a.json ')).toEqual({ url: 'https://example.com/a.json' });
    expect(checkUrl('http://localhost:8080/x.yml').url).toBe('http://localhost:8080/x.yml');
    expect(checkUrl('file:///C:/secret.json').error).toMatch(/http/);
    expect(checkUrl('javascript:alert(1)').error).toMatch(/http/);
    expect(checkUrl('not a url').error).toMatch(/valid URL/);
  });
});

describe('fetchText', () => {
  it('returns the text, content type and final URL, sending no credentials', async () => {
    const fetchImpl = vi.fn(async () => response('{"a":1}', { headers: { 'content-type': 'application/json' } }));
    expect(await fetchText('https://example.com/a', fetchImpl)).toEqual({
      ok: true, text: '{"a":1}', contentType: 'application/json', finalUrl: 'https://example.com/final.json',
    });
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit' });
  });

  it('reports a bad status, a bad URL and a file over 5 MB without fetching it whole', async () => {
    expect(await fetchText('https://x/a', async () => response('', { status: 404 }))).toEqual({ ok: false, error: 'The server responded 404.' });
    expect((await fetchText('ftp://x/a', vi.fn())).error).toMatch(/http/);
    const big = await fetchText('https://x/a', async () => response('x', { headers: { 'content-length': String(MAX_BYTES + 1) } }));
    expect(big).toEqual({ ok: false, error: 'The file is larger than 5 MB.' });
  });

  it('turns an abort into a timeout message', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(await fetchText('https://x/a', async () => { throw err; })).toEqual({ ok: false, error: 'Timed out after 15 s.' });
  });
});
