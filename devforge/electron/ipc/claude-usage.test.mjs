import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const usage = require('./claude-usage.cjs');

const NOW = Date.parse('2026-10-21T13:00:00Z');

const RESPONSE = {
  five_hour: { utilization: 47.0, resets_at: '2026-10-21T15:40:00+00:00' },
  seven_day: { utilization: 98.4, resets_at: '2026-10-22T20:00:00+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 12, resets_at: null },
};

let dir;

function writeCreds(oauth) {
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
}

const okFetch = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('claudeConfigDir', () => {
  it('honours CLAUDE_CONFIG_DIR', () => {
    expect(usage._claudeConfigDir({ CLAUDE_CONFIG_DIR: 'X:\\cfg' })).toBe('X:\\cfg');
  });

  it('defaults to ~/.claude', () => {
    expect(usage._claudeConfigDir({})).toBe(path.join(os.homedir(), '.claude'));
  });
});

describe('readAccessToken', () => {
  it('returns the token and plan of a live login', () => {
    writeCreds({ accessToken: 'tok', expiresAt: NOW + 60000, subscriptionType: 'team' });
    expect(usage._readAccessToken(dir, NOW)).toEqual({ token: 'tok', plan: 'team' });
  });

  it('reports NOT_SIGNED_IN when there is no credentials file', () => {
    expect(() => usage._readAccessToken(dir, NOW)).toThrow(expect.objectContaining({ code: 'NOT_SIGNED_IN' }));
  });

  it('reports NOT_SIGNED_IN when the file has no OAuth token', () => {
    writeCreds({});
    expect(() => usage._readAccessToken(dir, NOW)).toThrow(expect.objectContaining({ code: 'NOT_SIGNED_IN' }));
  });

  it('reports EXPIRED once expiresAt has passed', () => {
    writeCreds({ accessToken: 'tok', expiresAt: NOW - 1 });
    expect(() => usage._readAccessToken(dir, NOW)).toThrow(expect.objectContaining({ code: 'EXPIRED' }));
  });
});

describe('parseUsage', () => {
  it('keeps the populated windows in display order, rounded and clamped', () => {
    expect(usage._parseUsage({ ...RESPONSE, five_hour: { utilization: 104, resets_at: 'r' } })).toEqual([
      { id: 'session', label: 'Session', percent: 100, resetsAt: 'r' },
      { id: 'weekly', label: 'Weekly', percent: 98, resetsAt: '2026-10-22T20:00:00+00:00' },
      { id: 'weekly_sonnet', label: 'Weekly · Sonnet', percent: 12, resetsAt: null },
    ]);
  });

  it.each([null, {}, { five_hour: { utilization: 'x' } }])('rejects a response with no limits: %j', (json) => {
    expect(() => usage._parseUsage(json)).toThrow(expect.objectContaining({ code: 'BAD_RESPONSE' }));
  });
});

describe('fetchUsage', () => {
  beforeEach(() => writeCreds({ accessToken: 'tok', expiresAt: NOW + 60000, subscriptionType: 'max' }));

  it('sends the bearer token and returns the parsed limits', async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return okFetch(RESPONSE)(); };
    const result = await usage._fetchUsage({ dir, fetchImpl, now: NOW });

    expect(seen.url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(seen.init.headers.Authorization).toBe('Bearer tok');
    expect(result).toMatchObject({ success: true, plan: 'max', fetchedAt: '2026-10-21T13:00:00.000Z' });
    expect(result.limits.map(l => l.id)).toEqual(['session', 'weekly', 'weekly_sonnet']);
  });

  it('maps a 401 to EXPIRED', async () => {
    const result = await usage._fetchUsage({ dir, fetchImpl: okFetch({}, 401), now: NOW });
    expect(result).toMatchObject({ success: false, code: 'EXPIRED' });
  });

  it('maps other HTTP failures to HTTP_ERROR', async () => {
    const result = await usage._fetchUsage({ dir, fetchImpl: okFetch({}, 503), now: NOW });
    expect(result).toMatchObject({ success: false, code: 'HTTP_ERROR', error: 'Usage request failed (HTTP 503).' });
  });

  it('maps a network failure to NETWORK', async () => {
    const fetchImpl = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
    const result = await usage._fetchUsage({ dir, fetchImpl, now: NOW });
    expect(result).toEqual({ success: false, code: 'NETWORK', error: 'getaddrinfo ENOTFOUND' });
  });

  it('does not call the endpoint without a login', async () => {
    fs.rmSync(path.join(dir, '.credentials.json'));
    let called = false;
    const result = await usage._fetchUsage({ dir, fetchImpl: async () => { called = true; }, now: NOW });
    expect(called).toBe(false);
    expect(result).toMatchObject({ success: false, code: 'NOT_SIGNED_IN' });
  });
});
