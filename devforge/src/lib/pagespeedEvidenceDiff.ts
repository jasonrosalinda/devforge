// Before/after Lighthouse EVIDENCE diff.
//
// The AI assessment used to see only formatted metric strings ("LCP 3.3 s → 4.1 s")
// and audit titles, so it could report that a metric moved but never why. Everything
// that explains a movement — which resource appeared, how many bytes it added, which
// element became the LCP — already sits in `details.items` and was simply never
// compared. This module turns two results into a compact, ranked, model-readable
// account of what actually changed on the page.
//
// Pure functions, no React, no I/O — the whole thing is unit-testable.

import type {
    AuditDetails,
    PageSpeedInsightResult,
    PageSpeedOpportunity,
} from '@shared/types/pageSpeedInsight.types';

export type AuditStatus = 'appeared' | 'worsened' | 'resolved' | 'improved' | 'unchanged';
export type ResourceStatus = 'added' | 'removed' | 'changed' | 'same';

/** One Lighthouse audit flattened from `opportunities` + `passedAudits`. */
export interface AuditSnapshot {
    auditKey: string;
    title: string;
    score: number | null;
    passed: boolean;
    displayValue?: string | undefined;
    savingsMs?: number | undefined;
    metricSavings?: Record<string, number> | undefined;
    details?: AuditDetails | undefined;
}

/** A row extracted from `details.items` — a resource, a resource type, a third-party
 *  entity or a DOM node, depending on the audit. */
export interface ResourceDelta {
    key: string;
    label: string;
    status: ResourceStatus;
    beforeBytes?: number | undefined;
    afterBytes?: number | undefined;
    beforeMs?: number | undefined;
    afterMs?: number | undefined;
    beforeCount?: number | undefined;
    afterCount?: number | undefined;
    thirdParty?: boolean | undefined;
    note?: string | undefined;
}

export interface AuditDiff {
    auditKey: string;
    title: string;
    status: AuditStatus;
    before?: { score: number | null; displayValue?: string | undefined; savingsMs?: number | undefined } | undefined;
    after?: { score: number | null; displayValue?: string | undefined; savingsMs?: number | undefined } | undefined;
    savingsDeltaMs?: number | undefined;
    affectedMetrics: string[];
    resources: ResourceDelta[];
    rank: number;
}

export interface LcpElementDiff {
    changed: boolean;
    beforeSelector?: string | undefined;
    afterSelector?: string | undefined;
    beforeLabel?: string | undefined;
    afterLabel?: string | undefined;
    phases?: { name: string; beforeMs?: number | undefined; afterMs?: number | undefined }[] | undefined;
}

export interface EvidenceDiff {
    audits: AuditDiff[];
    lcpElement?: LcpElementDiff | undefined;
    network: ResourceDelta[];
    resourceSummary: ResourceDelta[];
    beforeRunLabel?: string | undefined;
    afterRunLabel?: string | undefined;
    /** True when the "before" result predates `passedAudits` — "resolved" is then
     *  only partly knowable, so the rendered section says so instead of guessing. */
    legacyBefore: boolean;
    omitted: { audits: number; resources: number };
}

export interface EvidenceDiffOptions {
    /** Metrics whose aggregate actually regressed — up-ranks the audits that
     *  plausibly caused the movement so they survive truncation. e.g. ['LCP'] */
    regressedMetrics?: string[] | undefined;
    /** Metric columns the user has switched on. Audits affecting only hidden
     *  metrics are down-ranked, never dropped outright. */
    shownMetrics?: Record<string, boolean> | undefined;
    maxAudits?: number | undefined;
    maxResourcesPerAudit?: number | undefined;
    maxNetworkRows?: number | undefined;
    maxChars?: number | undefined;
    minBytesDelta?: number | undefined;
    minMsDelta?: number | undefined;
    pageOrigin?: string | undefined;
}

const DEFAULTS = {
    maxAudits: 12,
    maxResourcesPerAudit: 6,
    maxNetworkRows: 8,
    maxChars: 6000,
    minBytesDelta: 2048,
    minMsDelta: 20,
};

const MAX_LABEL_CHARS = 90;

// ─── small guards ──────────────────────────────────────────────────────────
// Lighthouse item shapes drift between versions; every read goes through these so
// a renamed or missing field degrades to "no delta" instead of NaN or a throw.

const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

const elide = (s: string, max = MAX_LABEL_CHARS): string => {
    if (s.length <= max) return s;
    const head = Math.ceil((max - 1) / 2);
    return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
};

export const formatBytes = (b: number): string =>
    Math.abs(b) >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;

export const formatMs = (ms: number): string =>
    Math.abs(ms) >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;

// ─── URL normalization ─────────────────────────────────────────────────────

// Build fingerprints change on every deploy, so `theme.9f2ab1.css` and
// `theme.7c04de.css` are the SAME resource and must collapse to one key — without
// this, every deploy reads as "every file replaced" and nothing is attributable.
const FINGERPRINT_RULES: [RegExp, string][] = [
    [/\.[0-9a-f]{8,32}\.(js|mjs|css|map)$/i, '.$1'],           // theme.9f2ab1a0.css
    [/-[0-9a-f]{8,32}\.(js|mjs|css|map)$/i, '.$1'],            // main-4f3a2b1c.js
    [/\.[A-Za-z0-9_-]{8,12}\.(js|mjs|css)$/, '.$1'],           // vite: index.DkX9_2aA.js
    [/\/_next\/static\/[^/]{16,}\//, '/_next/static/<build>/'],
    [/\.v[0-9]+\.(js|css)$/i, '.$1'],
];

export function normalizeResourceUrl(
    raw: string,
    pageOrigin?: string | undefined,
): { key: string; label: string; thirdParty: boolean; fingerprinted: boolean } {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        // Relative or malformed (inline scripts, data: URIs) — keep it verbatim.
        return { key: raw, label: elide(raw), thirdParty: false, fingerprinted: false };
    }

    // Cache busters live in the query (?v=, ?ver=), so dropping it is part of the
    // same job as stripping filename hashes.
    let fingerprinted = url.search.length > 0;
    let path = url.pathname;
    for (const [re, replacement] of FINGERPRINT_RULES) {
        const next = path.replace(re, replacement);
        if (next !== path) {
            path = next;
            fingerprinted = true;
        }
    }

    const thirdParty = !!pageOrigin && url.origin !== pageOrigin;
    // First-party keys drop the origin so a staging→www comparison doesn't desync
    // every single row.
    const key = thirdParty ? `${url.host}${path}` : path;
    return { key, label: elide(key), thirdParty, fingerprinted };
}

// ─── audit collection ──────────────────────────────────────────────────────

const savingsOf = (o: Pick<PageSpeedOpportunity, 'details' | 'metricSavings'>): number | undefined => {
    const overall = num(o.details?.overallSavingsMs);
    if (overall !== undefined) return overall;
    const values = Object.values(o.metricSavings ?? {}).map(num).filter((v): v is number => v !== undefined);
    return values.length ? Math.max(...values) : undefined;
};

const metricsOf = (savings: Record<string, number> | undefined): string[] =>
    Object.entries(savings ?? {}).filter(([, v]) => (num(v) ?? 0) > 0).map(([k]) => k);

/** Flattens `opportunities` + `passedAudits` into the complete audit universe for
 *  one side of the comparison — the only way "appeared" and "resolved" can be told
 *  apart from "was never recorded". */
export function collectAudits(result: PageSpeedInsightResult | undefined): Map<string, AuditSnapshot> {
    const map = new Map<string, AuditSnapshot>();
    if (!result) return map;

    for (const o of result.opportunities ?? []) {
        const key = o.auditKey ?? o.title;
        if (!key || map.has(key)) continue;
        map.set(key, {
            auditKey: key,
            title: o.title,
            score: o.score,
            passed: typeof o.score === 'number' && o.score >= 0.9,
            displayValue: o.displayValue,
            savingsMs: savingsOf(o),
            metricSavings: o.metricSavings,
            details: o.details,
        });
    }
    for (const p of result.passedAudits ?? []) {
        if (map.has(p.auditKey)) continue;
        map.set(p.auditKey, {
            auditKey: p.auditKey,
            title: p.title,
            score: p.score,
            passed: true,
            displayValue: p.displayValue,
            metricSavings: p.metricSavings,
        });
    }
    return map;
}

/** The run whose metrics sit closest to the aggregate.
 *
 *  Aggregation keeps `opportunities` from the LAST non-error run, which may be
 *  nothing like the averaged numbers on screen. Explaining the displayed averages
 *  with a run that produced them is the whole point. */
export function representativeRun(
    result: PageSpeedInsightResult | undefined,
): PageSpeedInsightResult | undefined {
    if (!result) return undefined;
    const history = result.runHistory;
    if (!history?.length) return result;

    const keys = ['speedIndex', 'largestContentfulPaint', 'cumulativeLayoutShift', 'totalBlockingTime', 'firstContentfulPaint'] as const;
    let best: PageSpeedInsightResult | undefined;
    let bestScore = Infinity;
    for (const run of history) {
        // Normalized L1 distance — metrics are on wildly different scales (CLS ~1,
        // TBT ~1000), so each term is divided by the aggregate it is compared to.
        let distance = 0;
        let counted = 0;
        for (const key of keys) {
            const agg = num(result[key]?.numericValue);
            const value = num(run[key]?.numericValue);
            if (agg === undefined || value === undefined || agg <= 0) continue;
            distance += Math.abs(value - agg) / agg;
            counted++;
        }
        if (!counted) continue;
        const score = distance / counted;
        if (score < bestScore) {
            bestScore = score;
            best = run;
        }
    }
    return best ?? history[history.length - 1] ?? result;
}

// ─── per-audit item readers ────────────────────────────────────────────────

type ReadRow = { key: string; label: string; bytes?: number | undefined; ms?: number | undefined; count?: number | undefined; thirdParty?: boolean | undefined; note?: string | undefined };
type ItemReader = (item: Record<string, unknown>, opts: EvidenceDiffOptions) => ReadRow | null;

const urlReader = (bytesKey?: string, msKey?: string): ItemReader => (item, opts) => {
    const url = str(item.url) ?? str(item.source) ?? str((item.node as Record<string, unknown> | undefined)?.url);
    if (!url) return null;
    const n = normalizeResourceUrl(url, opts.pageOrigin);
    return {
        key: n.key,
        label: n.label,
        bytes: bytesKey ? num(item[bytesKey]) : undefined,
        ms: msKey ? num(item[msKey]) : undefined,
        thirdParty: n.thirdParty,
        ...(n.fingerprinted ? { note: 'fingerprinted' } : {}),
    };
};

const typeReader: ItemReader = (item) => {
    const type = str(item.resourceType) ?? str(item.label);
    if (!type) return null;
    return { key: type, label: type, bytes: num(item.transferSize), count: num(item.requestCount) };
};

const entityReader: ItemReader = (item) => {
    // `entity` is a bare string in older Lighthouse and { type:'link', text } in newer.
    const entity = item.entity;
    const name = typeof entity === 'string'
        ? entity
        : str((entity as Record<string, unknown> | undefined)?.text);
    if (!name) return null;
    return {
        key: name,
        label: elide(name),
        bytes: num(item.transferSize),
        ms: num(item.mainThreadTime) ?? num(item.blockingTime),
        thirdParty: true,
    };
};

const nodeReader: ItemReader = (item) => {
    const node = item.node as Record<string, unknown> | undefined;
    const selector = str(node?.selector) ?? str(node?.nodeLabel);
    if (!selector) return null;
    const score = num(item.score);
    return {
        key: selector,
        label: elide(selector),
        // Layout-shift score has no unit; scaling by 1000 puts it on the same
        // "bigger is worse" footing as the ms columns for ranking purposes.
        ms: score !== undefined ? score * 1000 : undefined,
    };
};

const phaseReader: ItemReader = (item) => {
    const phase = str(item.phase) ?? str(item.label);
    if (!phase) return null;
    return { key: phase, label: phase, ms: num(item.timing) ?? num(item.duration) };
};

const ITEM_READERS: Record<string, ItemReader> = {
    'render-blocking-resources': urlReader('totalBytes', 'wastedMs'),
    'render-blocking-insight': urlReader('totalBytes', 'wastedMs'),
    'unused-javascript': urlReader('wastedBytes'),
    'unused-css-rules': urlReader('wastedBytes'),
    'modern-image-formats': urlReader('wastedBytes'),
    'uses-responsive-images': urlReader('wastedBytes'),
    'uses-optimized-images': urlReader('wastedBytes'),
    'legacy-javascript': urlReader('wastedBytes'),
    'duplicated-javascript': urlReader('wastedBytes'),
    'network-requests': urlReader('transferSize'),
    'long-tasks': urlReader(undefined, 'duration'),
    'bootup-time': urlReader(undefined, 'total'),
    'resource-summary': typeReader,
    'third-party-summary': entityReader,
    'layout-shift-elements': nodeReader,
    'lcp-phases': phaseReader,
};

const readRows = (
    auditKey: string,
    details: AuditDetails | undefined,
    opts: EvidenceDiffOptions,
): Map<string, ReadRow> => {
    const out = new Map<string, ReadRow>();
    const reader = ITEM_READERS[auditKey];
    if (!reader || !details?.items) return out;
    for (const item of details.items) {
        let row: ReadRow | null = null;
        try {
            row = reader(item, opts);
        } catch {
            row = null; // schema drift — skip the row, never the audit
        }
        if (!row) continue;
        const existing = out.get(row.key);
        if (existing) {
            // Same resource listed twice (e.g. one row per chunk) — sum it.
            existing.bytes = (existing.bytes ?? 0) + (row.bytes ?? 0);
            existing.ms = (existing.ms ?? 0) + (row.ms ?? 0);
            existing.count = (existing.count ?? 0) + (row.count ?? 0);
        } else {
            out.set(row.key, row);
        }
    }
    return out;
};

/** Per-resource before/after deltas for one audit. Rows below the noise thresholds
 *  are dropped, so what survives is worth a commit hunt. */
export function diffAuditItems(
    auditKey: string,
    before: AuditDetails | undefined,
    after: AuditDetails | undefined,
    opts: EvidenceDiffOptions = {},
): ResourceDelta[] {
    const minBytes = opts.minBytesDelta ?? DEFAULTS.minBytesDelta;
    const minMs = opts.minMsDelta ?? DEFAULTS.minMsDelta;
    const b = readRows(auditKey, before, opts);
    const a = readRows(auditKey, after, opts);
    const deltas: ResourceDelta[] = [];

    for (const key of new Set([...b.keys(), ...a.keys()])) {
        const rb = b.get(key);
        const ra = a.get(key);
        const status: ResourceStatus = !rb ? 'added' : !ra ? 'removed' : 'changed';
        const byteDelta = (ra?.bytes ?? 0) - (rb?.bytes ?? 0);
        const msDelta = (ra?.ms ?? 0) - (rb?.ms ?? 0);
        const countDelta = (ra?.count ?? 0) - (rb?.count ?? 0);

        // An unchanged row is only interesting when it appeared or vanished.
        if (status === 'changed' && Math.abs(byteDelta) < minBytes && Math.abs(msDelta) < minMs && countDelta === 0) continue;

        const row = ra ?? rb!;
        deltas.push({
            key,
            label: row.label,
            status,
            ...(rb?.bytes !== undefined ? { beforeBytes: rb.bytes } : {}),
            ...(ra?.bytes !== undefined ? { afterBytes: ra.bytes } : {}),
            ...(rb?.ms !== undefined ? { beforeMs: rb.ms } : {}),
            ...(ra?.ms !== undefined ? { afterMs: ra.ms } : {}),
            ...(rb?.count !== undefined ? { beforeCount: rb.count } : {}),
            ...(ra?.count !== undefined ? { afterCount: ra.count } : {}),
            ...(row.thirdParty !== undefined ? { thirdParty: row.thirdParty } : {}),
            ...(row.note ? { note: row.note } : {}),
        });
    }

    return deltas.sort((x, y) => magnitude(y) - magnitude(x));
}

const magnitude = (d: ResourceDelta): number =>
    Math.abs((d.afterBytes ?? 0) - (d.beforeBytes ?? 0)) / 1024 +
    Math.abs((d.afterMs ?? 0) - (d.beforeMs ?? 0));

// ─── status + ranking ──────────────────────────────────────────────────────

const statusOf = (b: AuditSnapshot | undefined, a: AuditSnapshot | undefined): AuditStatus => {
    if (!b && !a) return 'unchanged';
    if (!b) return a!.passed ? 'unchanged' : 'appeared';
    if (!a) return b.passed ? 'unchanged' : 'resolved';
    if (b.passed && !a.passed) return 'appeared';
    if (!b.passed && a.passed) return 'resolved';
    if (b.passed && a.passed) return 'unchanged';
    const delta = (a.savingsMs ?? 0) - (b.savingsMs ?? 0);
    if (delta > 0) return 'worsened';
    if (delta < 0) return 'improved';
    return 'unchanged';
};

const STATUS_WEIGHT: Record<AuditStatus, number> = {
    appeared: 1000, worsened: 800, resolved: 600, improved: 400, unchanged: 0,
};

export function rankAuditDiff(d: Omit<AuditDiff, 'rank'>, opts: EvidenceDiffOptions = {}): number {
    const byteDelta = d.resources.reduce(
        (sum, r) => sum + Math.abs((r.afterBytes ?? 0) - (r.beforeBytes ?? 0)), 0);
    return STATUS_WEIGHT[d.status]
        + (d.affectedMetrics.some(m => opts.regressedMetrics?.includes(m)) ? 250 : 0)
        + d.affectedMetrics.filter(m => opts.shownMetrics?.[m]).length * 40
        + Math.min(200, Math.abs(d.savingsDeltaMs ?? 0) / 5)
        + Math.min(100, byteDelta / 10_240)
        + (d.resources.some(r => r.status === 'added' || r.status === 'removed') ? 60 : 0);
}

// ─── LCP element ───────────────────────────────────────────────────────────

const lcpNode = (snap: AuditSnapshot | undefined): { selector?: string; label?: string } | undefined => {
    const items = snap?.details?.items;
    if (!items) return undefined;
    for (const item of items) {
        const node = item.node as Record<string, unknown> | undefined;
        if (!node) continue;
        const selector = str(node.selector);
        const label = str(node.nodeLabel) ?? str(node.snippet);
        if (selector || label) {
            return {
                ...(selector ? { selector } : {}),
                ...(label ? { label } : {}),
            };
        }
    }
    return undefined;
};

const lcpPhases = (
    b: AuditSnapshot | undefined,
    a: AuditSnapshot | undefined,
): { name: string; beforeMs?: number | undefined; afterMs?: number | undefined }[] | undefined => {
    const rb = readRows('lcp-phases', b?.details, {});
    const ra = readRows('lcp-phases', a?.details, {});
    const keys = [...new Set([...rb.keys(), ...ra.keys()])];
    if (!keys.length) return undefined;
    return keys.map(name => ({
        name,
        ...(rb.get(name)?.ms !== undefined ? { beforeMs: rb.get(name)!.ms } : {}),
        ...(ra.get(name)?.ms !== undefined ? { afterMs: ra.get(name)!.ms } : {}),
    }));
};

// ─── composition ───────────────────────────────────────────────────────────

export function buildEvidenceDiff(
    before: PageSpeedInsightResult | undefined,
    after: PageSpeedInsightResult | undefined,
    opts: EvidenceDiffOptions = {},
): EvidenceDiff {
    const b = representativeRun(before);
    const a = representativeRun(after);
    const auditsB = collectAudits(b);
    const auditsA = collectAudits(a);

    const diffs: AuditDiff[] = [];
    for (const key of new Set([...auditsB.keys(), ...auditsA.keys()])) {
        const sb = auditsB.get(key);
        const sa = auditsA.get(key);
        const status = statusOf(sb, sa);
        const resources = diffAuditItems(key, sb?.details, sa?.details, opts);

        // An unchanged audit still earns its place when a file under it appeared or
        // vanished — that's the "same audit, different resource" case that points
        // straight at a commit.
        if (status === 'unchanged' && !resources.some(r => r.status === 'added' || r.status === 'removed')) continue;

        const savingsDelta = (sa?.savingsMs ?? 0) - (sb?.savingsMs ?? 0);
        const partial: Omit<AuditDiff, 'rank'> = {
            auditKey: key,
            title: sa?.title ?? sb?.title ?? key,
            status,
            ...(sb ? { before: { score: sb.score, displayValue: sb.displayValue, savingsMs: sb.savingsMs } } : {}),
            ...(sa ? { after: { score: sa.score, displayValue: sa.displayValue, savingsMs: sa.savingsMs } } : {}),
            ...(savingsDelta !== 0 ? { savingsDeltaMs: savingsDelta } : {}),
            affectedMetrics: [...new Set([...metricsOf(sb?.metricSavings), ...metricsOf(sa?.metricSavings)])],
            resources: resources.slice(0, opts.maxResourcesPerAudit ?? DEFAULTS.maxResourcesPerAudit),
        };
        diffs.push({ ...partial, rank: rankAuditDiff(partial, opts) });
    }

    // Ties broken by key so identical data always produces an identical prompt.
    diffs.sort((x, y) => y.rank - x.rank || x.auditKey.localeCompare(y.auditKey));

    const maxAudits = opts.maxAudits ?? DEFAULTS.maxAudits;
    const kept = diffs.slice(0, maxAudits);

    const lcpB = auditsB.get('largest-contentful-paint-element');
    const lcpA = auditsA.get('largest-contentful-paint-element');
    const nodeB = lcpNode(lcpB);
    const nodeA = lcpNode(lcpA);
    const phases = lcpPhases(auditsB.get('lcp-phases'), auditsA.get('lcp-phases'));
    const lcpElement: LcpElementDiff | undefined = (nodeB || nodeA || phases)
        ? {
            changed: (nodeB?.selector ?? nodeB?.label) !== (nodeA?.selector ?? nodeA?.label),
            ...(nodeB?.selector ? { beforeSelector: nodeB.selector } : {}),
            ...(nodeA?.selector ? { afterSelector: nodeA.selector } : {}),
            ...(nodeB?.label ? { beforeLabel: nodeB.label } : {}),
            ...(nodeA?.label ? { afterLabel: nodeA.label } : {}),
            ...(phases ? { phases } : {}),
        }
        : undefined;

    const network = diffAuditItems('network-requests', auditsB.get('network-requests')?.details, auditsA.get('network-requests')?.details, opts)
        .slice(0, opts.maxNetworkRows ?? DEFAULTS.maxNetworkRows);
    const resourceSummary = diffAuditItems('resource-summary', auditsB.get('resource-summary')?.details, auditsA.get('resource-summary')?.details, opts);

    return {
        audits: kept,
        ...(lcpElement ? { lcpElement } : {}),
        network,
        resourceSummary,
        ...(b?.fetchTime ? { beforeRunLabel: b.fetchTime } : {}),
        ...(a?.fetchTime ? { afterRunLabel: a.fetchTime } : {}),
        // Results captured before `passedAudits` existed can't prove an audit was
        // passing, only that it wasn't failing.
        legacyBefore: !!b && b.passedAudits === undefined && !!a?.passedAudits,
        omitted: {
            audits: diffs.length - kept.length,
            resources: diffs.reduce((sum, d) => sum + Math.max(0, d.resources.length - (opts.maxResourcesPerAudit ?? DEFAULTS.maxResourcesPerAudit)), 0),
        },
    };
}

// ─── markdown rendering ────────────────────────────────────────────────────

const deltaText = (d: ResourceDelta): string => {
    const parts: string[] = [];
    const bb = d.beforeBytes;
    const ab = d.afterBytes;
    if (bb !== undefined || ab !== undefined) {
        if (d.status === 'added') parts.push(`${formatBytes(ab ?? 0)} (new)`);
        else if (d.status === 'removed') parts.push(`${formatBytes(bb ?? 0)} (removed)`);
        else parts.push(`${formatBytes(bb ?? 0)} → ${formatBytes(ab ?? 0)} (${(ab ?? 0) - (bb ?? 0) >= 0 ? '+' : '−'}${formatBytes(Math.abs((ab ?? 0) - (bb ?? 0)))})`);
    }
    const bm = d.beforeMs;
    const am = d.afterMs;
    if (bm !== undefined || am !== undefined) {
        if (d.status === 'added') parts.push(`${formatMs(am ?? 0)}`);
        else if (d.status === 'removed') parts.push(`${formatMs(bm ?? 0)}`);
        else parts.push(`${formatMs(bm ?? 0)} → ${formatMs(am ?? 0)}`);
    }
    if (d.beforeCount !== undefined || d.afterCount !== undefined) {
        parts.push(`${d.beforeCount ?? 0} → ${d.afterCount ?? 0} requests`);
    }
    if (d.note) parts.push(`(${d.note})`);
    return parts.join(', ');
};

const sign = (d: ResourceDelta): string =>
    d.status === 'added' ? '+' : d.status === 'removed' ? '−' : '=';

const auditLine = (d: AuditDiff): string => {
    const bits: string[] = [];
    const bs = d.before?.savingsMs;
    const as = d.after?.savingsMs;
    if (bs !== undefined && as !== undefined && bs !== as) bits.push(`${formatMs(bs)} → ${formatMs(as)} savings`);
    else if (as !== undefined && d.status === 'appeared') bits.push(`${formatMs(as)} potential savings`);
    else if (bs !== undefined && d.status === 'resolved') bits.push(`was ${formatMs(bs)} savings, now passing`);
    const display = d.after?.displayValue ?? d.before?.displayValue;
    if (!bits.length && display) bits.push(display);
    if (d.affectedMetrics.length) bits.push(`[affects: ${d.affectedMetrics.join(', ')}]`);
    return `- \`${d.auditKey}\` — ${d.title}${bits.length ? ` — ${bits.join(' ')}` : ''}`;
};

const GROUPS: { status: AuditStatus; heading: string }[] = [
    { status: 'appeared', heading: 'Appeared' },
    { status: 'worsened', heading: 'Worsened' },
    { status: 'resolved', heading: 'Resolved' },
    { status: 'improved', heading: 'Improved' },
    { status: 'unchanged', heading: 'Same audit, different resources' },
];

export function renderEvidenceDiffMarkdown(
    diff: EvidenceDiff,
    labels: { before: string; after: string },
    opts: EvidenceDiffOptions = {},
): string {
    const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
    const blocks: string[] = [];

    blocks.push(`### Evidence diff (${labels.before} → ${labels.after})`);
    blocks.push(
        'Lighthouse audits and per-resource details compared between the two runs. Resource URLs are '
        + 'fingerprint-normalized (`theme.9f2ab1.css` → `theme.css`), so a row marked "new" is a genuinely '
        + 'new resource, not a rebuilt one. Use this as the causal evidence for WHY a metric moved.',
    );
    if (diff.beforeRunLabel || diff.afterRunLabel) {
        blocks.push(`Compared runs: ${diff.beforeRunLabel ?? 'n/a'} vs ${diff.afterRunLabel ?? 'n/a'} — the run closest to each aggregate.`);
    }
    if (diff.legacyBefore) {
        blocks.push('_Caveat: the "before" result predates passing-audit capture, so an audit listed as Resolved may simply not have been recorded._');
    }

    for (const group of GROUPS) {
        const rows = diff.audits.filter(d => d.status === group.status);
        if (!rows.length) continue;
        const lines = [`**${group.heading} (${rows.length})**`];
        for (const d of rows) {
            lines.push(auditLine(d));
            for (const r of d.resources) lines.push(`  - ${sign(r)} ${r.label} — ${deltaText(r)}`);
        }
        blocks.push(lines.join('\n'));
    }

    if (diff.lcpElement) {
        const e = diff.lcpElement;
        const lines = [`**LCP element ${e.changed ? 'changed' : 'unchanged'}**`];
        if (e.beforeSelector || e.beforeLabel) lines.push(`- before: \`${e.beforeSelector ?? '?'}\`${e.beforeLabel ? ` — ${elide(e.beforeLabel)}` : ''}`);
        if (e.afterSelector || e.afterLabel) lines.push(`- after: \`${e.afterSelector ?? '?'}\`${e.afterLabel ? ` — ${elide(e.afterLabel)}` : ''}`);
        if (e.phases?.length) {
            lines.push(`- phases: ${e.phases.map(p => `${p.name} ${formatMs(p.beforeMs ?? 0)}→${formatMs(p.afterMs ?? 0)}`).join(' · ')}`);
        }
        blocks.push(lines.join('\n'));
    }

    if (diff.network.length) {
        const lines = [`**Network deltas (top ${diff.network.length} by byte change)**`, '| resource | before | after | Δ |', '| --- | --- | --- | --- |'];
        for (const r of diff.network) {
            const bb = r.beforeBytes;
            const ab = r.afterBytes;
            const d = (ab ?? 0) - (bb ?? 0);
            lines.push(`| ${r.label} | ${bb === undefined ? '—' : formatBytes(bb)} | ${ab === undefined ? '—' : formatBytes(ab)} | ${d >= 0 ? '+' : '−'}${formatBytes(Math.abs(d))}${r.status !== 'changed' ? ` (${r.status})` : ''} |`);
        }
        blocks.push(lines.join('\n'));
    }

    if (diff.resourceSummary.length) {
        const lines = ['**Resource summary**'];
        for (const r of diff.resourceSummary) lines.push(`- ${r.label} ${deltaText(r)}`);
        blocks.push(lines.join('\n'));
    }

    // Truncate by dropping whole blocks from the bottom (least causal first), never
    // by slicing the string — a half-written table is worse than no table.
    let out = blocks.join('\n\n');
    let dropped = 0;
    while (out.length > maxChars && blocks.length > 3) {
        blocks.pop();
        dropped++;
        out = blocks.join('\n\n');
    }

    const omitted = diff.omitted.audits + diff.omitted.resources;
    if (omitted > 0 || dropped > 0) {
        out += `\n\n_${diff.omitted.audits} lower-ranked audit(s) and ${diff.omitted.resources} resource row(s) omitted`
            + `${dropped ? `, plus ${dropped} section(s) trimmed for length` : ''}. Each omitted row is below `
            + `${formatBytes(opts.minBytesDelta ?? DEFAULTS.minBytesDelta)} / ${formatMs(opts.minMsDelta ?? DEFAULTS.minMsDelta)} or ranked lower than what is shown._`;
    }
    return out;
}

/** Convenience wrapper used by the summary builder. Returns '' when there is
 *  nothing worth telling the model. */
export function buildEvidenceDiffSection(
    before: PageSpeedInsightResult | undefined,
    after: PageSpeedInsightResult | undefined,
    labels: { before: string; after: string },
    opts: EvidenceDiffOptions = {},
): string {
    if (!before || !after) return '';
    const diff = buildEvidenceDiff(before, after, opts);
    if (!diff.audits.length && !diff.network.length && !diff.resourceSummary.length && !diff.lcpElement) return '';
    return `\n${renderEvidenceDiffMarkdown(diff, labels, opts)}\n`;
}
