// appsettings.json ⇄ Azure App Service app settings. Azure (and .NET's environment
// configuration provider) reads a nested key `Logging:LogLevel:Default` from a setting
// named `Logging__LogLevel__Default`; arrays use the index as a segment.

export interface SettingRow { name: string; value: string }

export interface FlattenResult {
    rows: SettingRow[];
    /** Names that clash once case is ignored: environment variables are case-insensitive on Windows. */
    collisions: string[];
    error?: string | undefined;
}

/**
 * Drops // and /* *\/ comments and trailing commas, which appsettings.json files often
 * carry (JSON.parse rejects them). String-aware, so "http://…" values survive.
 */
export function stripJsonComments(text: string): string {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const ch = text[i]!;
        if (inString) {
            out += ch;
            if (ch === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
            if (ch === '"') inString = false;
            i += 1;
            continue;
        }
        if (ch === '"') { inString = true; out += ch; i += 1; continue; }
        if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
        if (ch === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
        if (ch === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j]!)) j += 1;
            if (text[j] === '}' || text[j] === ']') { i += 1; continue; }
        }
        out += ch;
        i += 1;
    }
    return out;
}

const scalar = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function flattenAppSettings(text: string, separator = '__'): FlattenResult {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonComments(text));
    } catch (e) {
        return { rows: [], collisions: [], error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { rows: [], collisions: [], error: 'Expected a JSON object at the top level, like appsettings.json.' };
    }
    const rows: SettingRow[] = [];
    const walk = (value: unknown, path: string[]) => {
        if (value && typeof value === 'object') {
            const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
            for (const [k, v] of entries) walk(v, [...path, k]);
            return;
        }
        rows.push({ name: path.join(separator), value: scalar(value) });
    };
    walk(parsed, []);

    const seen = new Map<string, string>();
    const collisions = new Set<string>();
    for (const r of rows) {
        const key = r.name.toLowerCase();
        const prior = seen.get(key);
        if (prior !== undefined && prior !== r.name) { collisions.add(prior); collisions.add(r.name); }
        else if (prior === undefined) seen.set(key, r.name);
    }
    return { rows, collisions: [...collisions] };
}

/** The JSON the portal's Configuration → Advanced edit takes. */
export function toAzureAdvancedEdit(rows: SettingRow[], slotSetting = false): string {
    return JSON.stringify(rows.map(r => ({ name: r.name, value: r.value, slotSetting })), null, 2);
}

/** `NAME=value` lines; values with spaces, quotes, # or line breaks are double-quoted. */
export function toEnvLines(rows: SettingRow[]): string {
    return rows.map(r => {
        const needsQuotes = /[\s"'#=\\]/.test(r.value);
        const v = needsQuotes ? `"${r.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : r.value;
        return `${r.name}=${v}`;
    }).join('\n');
}

/** Rows from Azure Advanced-edit JSON (`[{ name, value }]`) or `NAME=value` lines. */
export function parseSettingRows(text: string): { rows: SettingRow[]; error?: string | undefined } {
    const trimmed = text.trim();
    if (!trimmed) return { rows: [] };
    if (trimmed.startsWith('[')) {
        try {
            const arr: unknown = JSON.parse(trimmed);
            if (!Array.isArray(arr)) throw new Error('not an array');
            return {
                rows: arr
                    .filter((x): x is { name: unknown; value?: unknown } => !!x && typeof x === 'object' && 'name' in x)
                    .map(x => ({ name: String(x.name), value: scalar(x.value) })),
            };
        } catch (e) {
            return { rows: [], error: `Not valid Advanced-edit JSON: ${e instanceof Error ? e.message : String(e)}` };
        }
    }
    const rows: SettingRow[] = [];
    for (const raw of trimmed.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) return { rows: [], error: `Line "${line.slice(0, 60)}" has no NAME=value.` };
        let value = line.slice(eq + 1).trim();
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        }
        rows.push({ name: line.slice(0, eq).trim(), value });
    }
    return { rows };
}

type Tree = { [key: string]: Tree | string };

/** Turns objects whose keys are exactly 0..n-1 into arrays. */
function arrayify(node: Tree | string): unknown {
    if (typeof node === 'string') return node;
    const keys = Object.keys(node);
    const out = Object.fromEntries(keys.map(k => [k, arrayify(node[k]!)]));
    const isList = keys.length > 0 && keys.every((k, i) => k === String(i));
    return isList ? keys.map(k => out[k]) : out;
}

/**
 * Settings back to nested appsettings.json. `__` and `:` both split a key. Values stay
 * strings: the setting alone can't say whether "5" was a number.
 */
export function unflattenAppSettings(rows: SettingRow[]): { json: string; conflicts: string[] } {
    const root: Tree = {};
    const conflicts: string[] = [];
    for (const r of rows) {
        const parts = r.name.split(/__|:/).filter(Boolean);
        if (!parts.length) continue;
        let node = root;
        let ok = true;
        for (const p of parts.slice(0, -1)) {
            const next = node[p];
            if (typeof next === 'string') { ok = false; break; }
            node = next ?? (node[p] = {});
        }
        const leaf = parts[parts.length - 1]!;
        if (!ok || typeof node[leaf] === 'object') { conflicts.push(r.name); continue; }
        node[leaf] = r.value;
    }
    return { json: JSON.stringify(arrayify(root), null, 2), conflicts };
}
