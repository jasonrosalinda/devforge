export const HASH_ALGORITHMS = ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const;

export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

/**
 * MD5 is deliberately absent: WebCrypto does not implement it and hand-rolling
 * a broken hash is not worth the bytes. The tab states this rather than
 * quietly leaving it out.
 */

function toBinary(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return binary;
}

/** Base64 of the UTF-8 bytes, so multibyte text survives (raw btoa would throw). */
export function encodeBase64(text: string, urlSafe = false): string {
    const encoded = btoa(toBinary(new TextEncoder().encode(text)));
    return urlSafe ? encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : encoded;
}

/** Accepts standard or url-safe base64, with or without padding. */
export function decodeBase64(text: string): string {
    const normalised = text.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    const padded = normalised + '='.repeat((4 - (normalised.length % 4)) % 4);

    let binary: string;
    try {
        binary = atob(padded);
    } catch {
        throw new Error('Input is not valid base64.');
    }

    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('Input decoded to bytes that are not valid UTF-8 text.');
    }
}

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}

const HTML_UNESCAPES: Record<string, string> = {
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
    '#x27': "'",
    amp: '&',
};

/**
 * Handled in a single pass so `&amp;lt;` decodes to `&lt;` rather than `<` —
 * a second pass over the output would over-decode.
 */
export function unescapeHtml(text: string): string {
    return text.replace(/&(lt|gt|quot|apos|amp|#39|#x27);/g, (_, name: string) => HTML_UNESCAPES[name]!);
}

export async function hashText(text: string, algorithm: HashAlgorithm): Promise<string> {
    const digest = await crypto.subtle.digest(algorithm, new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function uuidV4(): string {
    return crypto.randomUUID();
}

let lastTimestamp = 0;
let sequence = 0;

/**
 * UUID v7: a 48-bit millisecond timestamp followed by randomness, so ids sort
 * by creation time and make usable database keys. A 12-bit counter keeps ids
 * minted within the same millisecond strictly increasing.
 */
export function uuidV7(): string {
    const now = Date.now();
    if (now > lastTimestamp) {
        // Only ever move the stamp forward. Once the counter has borrowed from
        // a future millisecond, or the system clock steps backwards, falling
        // back to Date.now() would emit ids that sort before earlier ones.
        lastTimestamp = now;
        sequence = 0;
    } else {
        sequence += 1;
    }

    // 12 bits of counter; beyond that, borrow from the next millisecond so
    // ordering still holds rather than wrapping back on itself.
    if (sequence > 0xfff) {
        lastTimestamp += 1;
        sequence = 0;
    }

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    const timestamp = lastTimestamp;
    bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
    bytes[5] = timestamp & 0xff;

    bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
    bytes[7] = sequence & 0xff;
    bytes[8] = 0x80 | (bytes[8]! & 0x3f);

    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
