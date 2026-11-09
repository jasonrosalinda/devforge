import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const handler = require('./cert-expiry.cjs');
const { _certStatus: certStatus, _hostsFor: hostsFor, _checkApps: checkApps, _trustOf: trustOf } = handler;

describe('trustOf', () => {
  // Codes as Node reports them for expired / wrong.host / self-signed .badssl.com.
  it('keeps the dates of an expired certificate, flags a host mismatch, distrusts a broken chain', () => {
    expect(trustOf(true, undefined)).toBe('ok');
    expect(trustOf(false, 'CERT_HAS_EXPIRED')).toBe('ok');
    expect(trustOf(false, 'CERT_NOT_YET_VALID')).toBe('ok');
    expect(trustOf(false, 'ERR_TLS_CERT_ALTNAME_INVALID')).toBe('host');
    expect(trustOf(false, 'DEPTH_ZERO_SELF_SIGNED_CERT')).toBe('chain');
    expect(trustOf(false, 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')).toBe('chain');
  });
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-09T00:00:00Z');

describe('certStatus', () => {
  it('buckets days left at 0, 14 and 30', () => {
    expect(certStatus(NOW - 1, NOW)).toEqual({ daysLeft: -1, status: 'expired' });
    expect(certStatus(NOW + 13 * DAY, NOW).status).toBe('critical');
    expect(certStatus(NOW + 14 * DAY, NOW).status).toBe('warning');
    expect(certStatus(NOW + 29 * DAY, NOW).status).toBe('warning');
    expect(certStatus(NOW + 30 * DAY, NOW)).toEqual({ daysLeft: 30, status: 'ok' });
  });
});

describe('hostsFor', () => {
  it('takes platform URLs, then App Service host names, deduped, without Kudu', () => {
    const app = { name: 'web', platformUrls: ['https://www.Example.com/path', 'example.com'] };
    const web = { properties: { hostNames: ['www.example.com', 'web.azurewebsites.net', 'web.scm.azurewebsites.net'] } };
    expect(hostsFor(app, { web })).toEqual([
      { host: 'www.example.com', site: 'url' },
      { host: 'example.com', site: 'url' },
      { host: 'web.azurewebsites.net', site: 'web' },
    ]);
  });

  it('reads a Container App ingress FQDN and custom domains for the API', () => {
    const api = { properties: { configuration: { ingress: { fqdn: 'api.x.azurecontainerapps.io', customDomains: [{ name: 'api.example.com' }] } } } };
    expect(hostsFor({ name: 'a' }, { api }).map((h) => [h.host, h.site])).toEqual([
      ['api.x.azurecontainerapps.io', 'api'], ['api.example.com', 'api'],
    ]);
  });

  it('falls back to platform URLs alone when ARM is denied', () => {
    expect(hostsFor({ platformUrls: ['https://a.com'] }, { web: null, api: null })).toEqual([{ host: 'a.com', site: 'url' }]);
    expect(hostsFor({ platformUrls: ['::not a url::'] })).toEqual([]);
  });
});

describe('checkApps', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url) => ({
      ok: !String(url).includes('/sites/api'),
      status: String(url).includes('/sites/api') ? 403 : 200,
      json: async () => ({ properties: { hostNames: ['web.azurewebsites.net'] } }),
    })));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('checks every host of the picked apps and adds days left', async () => {
    const readCert = vi.fn(async (host) => (host === 'down.example.com'
      ? { host, error: 'Host not found.' }
      : { host, validTo: new Date(NOW + 10 * DAY).toISOString(), issuer: 'R3', sans: [host], authorized: true }));
    const config = {
      subscriptionId: 'sub',
      apps: [
        { name: 'web', type: 'appservice', resourceGroup: 'rg', apiName: 'api', platformUrls: ['https://down.example.com'] },
        { name: 'other', type: 'appservice', resourceGroup: 'rg', platformUrls: ['https://skip.example.com'] },
      ],
    };
    const { results } = await checkApps({ appKeys: ['web'], config }, { readCert, now: () => NOW, armToken: async () => 't' });
    expect(results.map((r) => [r.host, r.site, r.status ?? r.error])).toEqual([
      ['down.example.com', 'url', 'Host not found.'],
      ['web.azurewebsites.net', 'web', 'critical'],
    ]);
    expect(readCert).not.toHaveBeenCalledWith('skip.example.com');
  });

  it('checks platform URLs alone when signed out of Azure', async () => {
    const readCert = vi.fn(async (host) => ({ host, validTo: new Date(NOW + 90 * DAY).toISOString(), authorized: true }));
    const config = { subscriptionId: 'sub', apps: [{ name: 'web', type: 'appservice', resourceGroup: 'rg', platformUrls: ['https://a.com'] }] };
    const { results } = await checkApps({ appKeys: ['web'], config }, { readCert, now: () => NOW, armToken: async () => { throw new Error('az login'); } });
    expect(results.map((r) => [r.host, r.status])).toEqual([['a.com', 'ok']]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
