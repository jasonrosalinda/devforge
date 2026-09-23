export type JwtSegments = Record<string, unknown> | null;

export type DecodedJwt = {
    header: JwtSegments;
    payload: JwtSegments;
    signature: string | null;
    errors: string[];
};

export type TimeClaimState = 'valid' | 'expired' | 'not-yet-valid';

export type TimeClaim = {
    claim: 'iat' | 'nbf' | 'exp';
    label: string;
    date: Date;
    local: string;
    utc: string;
    relative: string;
    state: TimeClaimState;
};

const TIME_CLAIM_ORDER = [
    { claim: 'iat', label: 'Issued at' },
    { claim: 'nbf', label: 'Not before' },
    { claim: 'exp', label: 'Expires' },
] as const;

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
};

/**
 * Decodes a base64url segment as UTF-8. Plain atob would corrupt any multibyte
 * claim (names, tenant labels), so the bytes go through TextDecoder instead.
 */
function decodeSegment(segment: string): string {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function parseSegment(segment: string, name: string, errors: string[]): JwtSegments {
    let json: string;
    try {
        json = decodeSegment(segment);
    } catch {
        errors.push(`${name} is not valid base64url.`);
        return null;
    }

    try {
        const parsed = JSON.parse(json);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            errors.push(`${name} is not a JSON object.`);
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch (error) {
        errors.push(`${name} is not valid JSON: ${(error as Error).message}`);
        return null;
    }
}

/**
 * Splits a JWT and decodes its header and payload. The signature is returned
 * verbatim and never checked — verifying it would need the issuer's key.
 */
export function decodeJwt(token: string): DecodedJwt {
    const trimmed = token.trim();
    if (!trimmed) {
        return { header: null, payload: null, signature: null, errors: ['Enter a token to decode.'] };
    }

    const parts = trimmed.split('.');
    if (parts.length !== 3) {
        return {
            header: null,
            payload: null,
            signature: null,
            errors: [`A JWT must have three dot-separated parts; found ${parts.length}.`],
        };
    }

    const errors: string[] = [];
    const header = parseSegment(parts[0]!, 'Header', errors);
    const payload = parseSegment(parts[1]!, 'Payload', errors);

    return { header, payload, signature: parts[2]!, errors };
}

function relativeText(target: Date, now: Date): string {
    const seconds = Math.round((target.getTime() - now.getTime()) / 1000);
    const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
    const magnitude = Math.abs(seconds);

    if (magnitude < 60) return formatter.format(seconds, 'second');
    if (magnitude < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
    if (magnitude < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
    if (magnitude < 2592000) return formatter.format(Math.round(seconds / 86400), 'day');
    if (magnitude < 31536000) return formatter.format(Math.round(seconds / 2592000), 'month');
    return formatter.format(Math.round(seconds / 31536000), 'year');
}

function claimState(claim: 'iat' | 'nbf' | 'exp', date: Date, now: Date): TimeClaimState {
    if (claim === 'exp') return date.getTime() <= now.getTime() ? 'expired' : 'valid';
    if (claim === 'nbf') return date.getTime() > now.getTime() ? 'not-yet-valid' : 'valid';
    return 'valid';
}

/**
 * Turns the numeric-date claims into rows carrying both timezones, because a
 * token minted in UTC is always read by someone sitting in another offset.
 */
export function timeClaims(payload: JwtSegments, now: Date = new Date()): TimeClaim[] {
    if (!payload) return [];

    return TIME_CLAIM_ORDER.flatMap(({ claim, label }) => {
        const value = payload[claim];
        if (typeof value !== 'number' || !Number.isFinite(value)) return [];

        const date = new Date(value * 1000);
        return [{
            claim,
            label,
            date,
            local: date.toLocaleString([], DATE_FORMAT),
            utc: date.toLocaleString('en-GB', { ...DATE_FORMAT, timeZone: 'UTC' }),
            relative: relativeText(date, now),
            state: claimState(claim, date, now),
        }];
    });
}
