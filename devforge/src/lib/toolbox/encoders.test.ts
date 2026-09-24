import { describe, it, expect, vi } from 'vitest';
import {
    encodeBase64,
    decodeBase64,
    escapeHtml,
    unescapeHtml,
    hashText,
    uuidV4,
    uuidV7,
} from './encoders';

describe('base64', () => {
    it('round-trips plain ASCII', () => {
        expect(encodeBase64('hello')).toBe('aGVsbG8=');
        expect(decodeBase64('aGVsbG8=')).toBe('hello');
    });

    // btoa() throws on anything outside Latin-1, which is exactly what a real
    // payload contains; the encoder has to go through UTF-8 bytes instead.
    it('round-trips multibyte UTF-8 that raw btoa cannot handle', () => {
        const text = '日本語 😀 Renée';

        expect(decodeBase64(encodeBase64(text))).toBe(text);
    });

    it('produces url-safe output on request and never emits + / or =', () => {
        const text = '??>>??>>'; // encodes to bytes that use both + and /

        const urlSafe = encodeBase64(text, true);

        expect(urlSafe).not.toMatch(/[+/=]/);
        expect(decodeBase64(urlSafe)).toBe(text);
    });

    it('decodes url-safe input that is missing its padding', () => {
        expect(decodeBase64('aGVsbG8')).toBe('hello');
    });

    it('throws a readable error for input that is not base64', () => {
        expect(() => decodeBase64('not base64!!')).toThrow(/not valid base64/i);
    });
});

describe('html entities', () => {
    it('escapes the five characters that break markup', () => {
        expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`))
            .toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
    });

    it('round-trips without double-unescaping an encoded ampersand', () => {
        const text = '<b>&amp;</b>';

        expect(unescapeHtml(escapeHtml(text))).toBe(text);
    });

    it('unescapes named and numeric apostrophes alike', () => {
        expect(unescapeHtml('&apos;a&#39;b')).toBe("'a'b");
    });
});

describe('hashText', () => {
    it('matches the published SHA-256 vector for "abc"', async () => {
        await expect(hashText('abc', 'SHA-256'))
            .resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('matches the published SHA-1 vector for "abc"', async () => {
        await expect(hashText('abc', 'SHA-1')).resolves.toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    });

    // Fixed digest produced by an independent implementation (Node's crypto),
    // so a bug in the UTF-8 encoding here cannot make the test agree with itself.
    it('hashes the UTF-8 bytes of a multibyte string', async () => {
        await expect(hashText('日本語 😀', 'SHA-256'))
            .resolves.toBe('fde211ca1a740f4758ae554eb97eca48c2aa74cdf8b656adfa31266d72b6106c');
    });

    it('produces the expected digest length per algorithm', async () => {
        expect(await hashText('x', 'SHA-384')).toHaveLength(96);
        expect(await hashText('x', 'SHA-512')).toHaveLength(128);
    });
});

describe('uuid', () => {
    it('generates a well-formed v4', () => {
        expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('generates a well-formed v7', () => {
        expect(uuidV7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    // v7's whole point is that it sorts by creation time, which only holds if
    // ids minted inside the same millisecond still increase.
    it('generates v7 values that sort in creation order under rapid calls', () => {
        const ids = Array.from({ length: 200 }, () => uuidV7());

        expect([...ids].sort()).toEqual(ids);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // The same-millisecond counter is 12 bits. With the clock frozen, every id
    // lands in one millisecond, so the generator must keep climbing past the
    // counter rather than fall back to the wall clock it has already overrun.
    it('keeps v7 ordered past the 4096-per-millisecond counter limit', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-23T10:00:00Z'));

        try {
            const ids = Array.from({ length: 5000 }, () => uuidV7());

            expect([...ids].sort()).toEqual(ids);
            expect(new Set(ids).size).toBe(ids.length);
        } finally {
            vi.useRealTimers();
        }
    });
});
