import { describe, it, expect } from 'vitest';
import { decodeJwt, timeClaims } from './jwt';

// Builds a token the way a real issuer does, so the tests exercise base64url
// (-, _, no padding) rather than a hand-written string that happens to decode.
const b64url = (obj: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const makeToken = (header: unknown, payload: unknown, signature = 'sIgNaTuRe') =>
  `${b64url(header)}.${b64url(payload)}.${signature}`;

describe('decodeJwt', () => {
  it('decodes the header, payload and signature of a valid token', () => {
    const token = makeToken({ alg: 'RS256', typ: 'JWT' }, { sub: 'user-1', roles: ['admin'] });

    const result = decodeJwt(token);

    expect(result.errors).toEqual([]);
    expect(result.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(result.payload).toEqual({ sub: 'user-1', roles: ['admin'] });
    expect(result.signature).toBe('sIgNaTuRe');
  });

  // A payload with non-ASCII forces base64url's - and _ characters to appear,
  // which plain base64 decoding would reject.
  it('decodes base64url characters and missing padding', () => {
    const token = makeToken({ alg: 'HS256' }, { name: 'Renée ÿ ~ ?', tenant: 'ü' });

    const result = decodeJwt(token);

    expect(result.errors).toEqual([]);
    expect(result.payload).toEqual({ name: 'Renée ÿ ~ ?', tenant: 'ü' });
  });

  it('decodes multibyte UTF-8 claims without mangling them', () => {
    const token = makeToken({ alg: 'HS256' }, { name: '日本語 😀' });

    expect(decodeJwt(token).payload).toEqual({ name: '日本語 😀' });
  });

  it('reports an error when the token does not have three parts', () => {
    const result = decodeJwt(`${b64url({ alg: 'HS256' })}.${b64url({ sub: 'x' })}`);

    expect(result.errors).toContain('A JWT must have three dot-separated parts; found 2.');
    expect(result.header).toBeNull();
    expect(result.payload).toBeNull();
  });

  it('reports an error when a segment is not valid JSON', () => {
    const token = `${b64url({ alg: 'HS256' })}.bm90LWpzb24.sig`;

    const result = decodeJwt(token);

    expect(result.header).toEqual({ alg: 'HS256' });
    expect(result.payload).toBeNull();
    expect(result.errors.some((e) => e.includes('Payload'))).toBe(true);
  });

  it('reports an error for an empty token rather than throwing', () => {
    const result = decodeJwt('   ');

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.header).toBeNull();
  });
});

describe('timeClaims', () => {
  const now = new Date('2026-09-23T10:00:00Z');

  it('marks an exp in the past as expired with a relative description', () => {
    const claims = timeClaims({ exp: Math.floor(now.getTime() / 1000) - 7200 }, now);

    expect(claims).toHaveLength(1);
    expect(claims[0]!.claim).toBe('exp');
    expect(claims[0]!.state).toBe('expired');
    expect(claims[0]!.relative).toBe('2 hours ago');
  });

  it('marks an exp in the future as valid', () => {
    const claims = timeClaims({ exp: Math.floor(now.getTime() / 1000) + 840 }, now);

    expect(claims[0]!.state).toBe('valid');
    expect(claims[0]!.relative).toBe('in 14 minutes');
  });

  it('returns exp, iat and nbf in a stable order with both UTC and local text', () => {
    const base = Math.floor(now.getTime() / 1000);
    const claims = timeClaims({ nbf: base, iat: base - 60, exp: base + 60 }, now);

    expect(claims.map((c) => c.claim)).toEqual(['iat', 'nbf', 'exp']);
    expect(claims[0]!.utc).toContain('2026');
    expect(claims[0]!.local).not.toHaveLength(0);
  });

  it('flags an nbf that has not been reached yet as not-yet-valid', () => {
    const claims = timeClaims({ nbf: Math.floor(now.getTime() / 1000) + 300 }, now);

    expect(claims[0]!.state).toBe('not-yet-valid');
  });

  it('ignores time claims that are not numbers', () => {
    expect(timeClaims({ exp: 'soon', iat: null }, now)).toEqual([]);
  });

  it('returns nothing for a null payload', () => {
    expect(timeClaims(null, now)).toEqual([]);
  });
});
