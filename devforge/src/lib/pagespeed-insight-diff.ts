// Which PageSpeed Insights findings are new, or worse, in After than in Before — and
// which Before findings After fixed. Feeds the NEW / WORSE / FIXED badges on the
// insight lists, so a reader sees what the release changed instead of re-reading the
// same ten findings on both sides.
//
// Works on each side's consolidated list (one entry per audit, worst run kept, plus
// how many runs flagged it). Pure: no React.

import type { PageSpeedInsightResult, PageSpeedOpportunity } from '@shared/types/pageSpeedInsight.types';

export interface InsightSet {
    opportunities: PageSpeedOpportunity[];
    /** Per audit: the runs (1-based) that flagged it, out of `total`. Absent for a single run. */
    occurrences?: Record<string, { runs: number[]; total: number }> | undefined;
}

export type InsightChangeStatus = 'new' | 'worse' | 'fixed';

export interface InsightChange {
    status: InsightChangeStatus;
    /** One sentence for the tooltip. */
    detail: string;
}

/** Consolidate run insights: one per audit, the worst-scoring run kept, runs counted. */
export function consolidateInsights(history: PageSpeedInsightResult[]): Required<InsightSet> {
    const total = history.length;
    const byKey = new Map<string, PageSpeedOpportunity>();
    const runsByKey: Record<string, number[]> = {};
    history.forEach((run, runIdx) => {
        for (const o of run.opportunities ?? []) {
            if (o.type !== 'opportunity') continue;
            const key = insightKey(o);
            (runsByKey[key] ??= []).push(runIdx + 1);
            const existing = byKey.get(key);
            if (!existing || (o.score ?? 0) < (existing.score ?? 0)) byKey.set(key, o);
        }
    });
    const occurrences: Record<string, { runs: number[]; total: number }> = {};
    for (const [key, runs] of Object.entries(runsByKey)) occurrences[key] = { runs, total };
    const opportunities = [...byKey.values()].sort((a, b) => (a.score ?? 1) - (b.score ?? 1));
    return { opportunities, occurrences };
}

export const insightKey = (o: PageSpeedOpportunity): string => o.auditKey ?? o.title;

/** Shown as a finding — the lists hide passing (score ≥ 0.9) audits. */
const failing = (o: PageSpeedOpportunity | undefined): o is PageSpeedOpportunity =>
    !!o && !(o.score != null && o.score >= 0.9);

type Amount = { value: number; unit: 'ms' | 'bytes' | 'count' };

/** The size of a finding from its display value: "Est savings of 420 ms", "… 423 KiB", "5 layout shifts found". */
export function insightAmount(o: PageSpeedOpportunity): Amount | undefined {
    const text = String(o.displayValue ?? '').replace(/ /g, ' ');
    const match = /([\d][\d,]*(?:\.\d+)?)\s*(ms|s|KiB|MiB|KB|MB|B)?\b/i.exec(text);
    if (!match) return undefined;
    const n = parseFloat(match[1]!.replace(/,/g, ''));
    if (!Number.isFinite(n)) return undefined;
    switch ((match[2] ?? '').toLowerCase()) {
        case 'ms': return { value: n, unit: 'ms' };
        case 's': return { value: n * 1000, unit: 'ms' };
        case 'kib': case 'kb': return { value: n * 1024, unit: 'bytes' };
        case 'mib': case 'mb': return { value: n * 1024 * 1024, unit: 'bytes' };
        case 'b': return { value: n, unit: 'bytes' };
        default: return { value: n, unit: 'count' };
    }
}

// "Worse" needs a change big enough not to be run-to-run noise.
const WORSE_RATIO = 1.2;
const WORSE_MIN: Record<Amount['unit'], number> = { ms: 50, bytes: 10 * 1024, count: 1 };
const WORSE_SCORE_DROP = 0.1;
const WORSE_FREQUENCY = 0.3;

const share = (set: InsightSet, key: string): { runs: number; total: number } | undefined => {
    const occ = set.occurrences?.[key];
    return occ && occ.total > 1 ? { runs: occ.runs.length, total: occ.total } : undefined;
};

/** Why `now` is worse than `was`, or undefined when it is not (meaningfully). */
function worseReason(was: PageSpeedOpportunity, now: PageSpeedOpportunity, before: InsightSet, after: InsightSet, beforeLabel: string): string | undefined {
    const a = insightAmount(was);
    const b = insightAmount(now);
    if (a && b && a.unit === b.unit && b.value >= a.value * WORSE_RATIO && b.value - a.value >= WORSE_MIN[a.unit]) {
        return `Worse: ${now.displayValue} (was ${was.displayValue} in ${beforeLabel}).`;
    }
    if (was.score != null && now.score != null && was.score - now.score >= WORSE_SCORE_DROP) {
        return `Worse: Lighthouse score ${Math.round(now.score * 100)} (was ${Math.round(was.score * 100)} in ${beforeLabel}).`;
    }
    const key = insightKey(now);
    const s1 = share(before, key);
    const s2 = share(after, key);
    if (s1 && s2 && s2.runs / s2.total - s1.runs / s1.total >= WORSE_FREQUENCY) {
        return `Worse: flagged in ${s2.runs} of ${s2.total} runs (was ${s1.runs} of ${s1.total} in ${beforeLabel}).`;
    }
    return undefined;
}

/**
 * NEW and WORSE for the After list, FIXED for the Before list, keyed by audit.
 * Only findings the lists actually show (failing ones) take part.
 */
export function diffInsights(
    before: InsightSet,
    after: InsightSet,
    labels: { before: string; after: string },
): { after: Record<string, InsightChange>; before: Record<string, InsightChange> } {
    const beforeByKey = new Map(before.opportunities.filter(failing).map(o => [insightKey(o), o]));
    const afterByKey = new Map(after.opportunities.filter(failing).map(o => [insightKey(o), o]));
    const afterChanges: Record<string, InsightChange> = {};
    const beforeChanges: Record<string, InsightChange> = {};

    for (const [key, now] of afterByKey) {
        const was = beforeByKey.get(key);
        if (!was) {
            afterChanges[key] = { status: 'new', detail: `New: not flagged in ${labels.before}.` };
            continue;
        }
        const reason = worseReason(was, now, before, after, labels.before);
        if (reason) afterChanges[key] = { status: 'worse', detail: reason };
    }
    for (const key of beforeByKey.keys()) {
        if (!afterByKey.has(key)) beforeChanges[key] = { status: 'fixed', detail: `Fixed: no longer flagged in ${labels.after}.` };
    }
    return { after: afterChanges, before: beforeChanges };
}
