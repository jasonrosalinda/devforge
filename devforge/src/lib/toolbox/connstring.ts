// Split an Azure-style connection string into its fields. Runs offline; secrets are
// flagged so the UI can mask them by default.

export interface ConnField { key: string; value: string; secret: boolean }

export interface ParsedConnString {
    kind: string;
    fields: ConnField[];
}

const SECRET_KEYS = /^(password|pwd|accountkey|sharedaccesskey|sharedaccesssignature|clientsecret|client secret|secret|accesskey|key|token)$/i;

export const isSecretKey = (key: string): boolean => SECRET_KEYS.test(key.trim());

/** `;`-separated `key=value` pairs; a value may be quoted to hold a `;`. */
function splitPairs(s: string, sep: string): string[] {
    const parts: string[] = [];
    let cur = '';
    let quote: string | null = null;
    for (const ch of s) {
        if (quote) {
            if (ch === quote) quote = null;
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === sep) {
            parts.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    parts.push(cur);
    return parts.map(p => p.trim()).filter(Boolean);
}

function field(key: string, value: string): ConnField {
    return { key, value, secret: isSecretKey(key) };
}

function detectKind(fields: ConnField[], redis: boolean): string {
    if (redis) return 'Redis';
    const has = (k: string) => fields.some(f => f.key.toLowerCase() === k);
    const endpoint = fields.find(f => f.key.toLowerCase() === 'endpoint')?.value ?? '';
    if (has('accountendpoint')) return 'Cosmos DB';
    if (endpoint.startsWith('sb://')) return 'Service Bus / Event Hubs';
    if (has('accountname') || has('defaultendpointsprotocol') || has('blobendpoint')) return 'Storage account';
    if (has('instrumentationkey')) return 'Application Insights';
    if ((has('server') || has('data source')) && (has('initial catalog') || has('database'))) return 'SQL Server';
    if (has('host') && has('username')) return 'PostgreSQL / MySQL';
    return 'Unknown';
}

export function parseConnectionString(input: string): ParsedConnString {
    const s = input.trim();
    if (!s) return { kind: '', fields: [] };
    // StackExchange.Redis: "host:6380,password=…,ssl=True" — commas, and a first part with no `=`.
    const firstSemi = s.indexOf(';');
    const head = s.split(',')[0] ?? '';
    const redis = firstSemi < 0 && s.includes(',') && !head.includes('=');
    const parts = splitPairs(s, redis ? ',' : ';');
    const fields = parts.map((p, i) => {
        const eq = p.indexOf('=');
        if (eq < 0) return field(redis && i === 0 ? 'Host' : `(part ${i + 1})`, p);
        return field(p.slice(0, eq).trim(), p.slice(eq + 1).trim());
    });
    return { kind: detectKind(fields, redis), fields };
}

/** Masks all but the last 4 characters of a long value, everything of a short one. */
export function maskValue(value: string): string {
    if (value.length <= 8) return '•'.repeat(value.length);
    return `${'•'.repeat(8)}${value.slice(-4)}`;
}
