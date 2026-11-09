// Read-only tree view of parsed JSON / YAML / XML: what each node is, its children, and
// the path to it (`spec.containers[0].image`).

export type NodeKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** Children shown per node before "… N more": a 10,000-item array would freeze the page. */
export const CHILD_LIMIT = 200;

export function nodeKind(value: unknown): NodeKind {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    const t = typeof value;
    if (t === 'object') return 'object';
    if (t === 'number' || t === 'bigint') return 'number';
    if (t === 'boolean') return 'boolean';
    return 'string';
}

/** "3 keys", "12 items", or the scalar as it should read. */
export function nodeSummary(value: unknown): string {
    const kind = nodeKind(value);
    if (kind === 'array') {
        const n = (value as unknown[]).length;
        return `${n} item${n === 1 ? '' : 's'}`;
    }
    if (kind === 'object') {
        const n = Object.keys(value as object).length;
        return `${n} key${n === 1 ? '' : 's'}`;
    }
    if (kind === 'null') return 'null';
    if (kind === 'string') return JSON.stringify(value);
    return String(value);
}

export function childEntries(value: unknown, limit = CHILD_LIMIT): { entries: Array<[string, unknown]>; more: number } {
    const all: Array<[string, unknown]> = Array.isArray(value)
        ? value.map((v, i) => [String(i), v])
        : value && typeof value === 'object' ? Object.entries(value) : [];
    return { entries: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

/** `a.b`, `a[0]`, or `a["odd key"]` for keys that aren't plain identifiers. */
export function childPath(parent: string, key: string, parentIsArray: boolean): string {
    if (parentIsArray) return `${parent}[${key}]`;
    if (/^[A-Za-z_$@][\w$@-]*$/.test(key)) return parent ? `${parent}.${key}` : key;
    return `${parent}[${JSON.stringify(key)}]`;
}
