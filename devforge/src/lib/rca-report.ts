/** Pure pieces of the RCA run shared by App Health Check and App Investigation. */

/** The card's RCA section is an editable form; its composed markdown wins over the raw stream. */
export function rcaOutputOf(draft: string, text: string): string {
    return draft.trim() ? draft : text;
}

/** Two RCA runs for the same app (the card and App Investigation) share channels; runId keeps them apart. */
export function acceptsRcaEvent(data: { appKey: string; runId?: string | undefined }, appKey: string, runId: string): boolean {
    return data.appKey === appKey && data.runId === runId;
}

export function newRunId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * An App Investigation report is the findings (Summary … Gaps & Next Checks) followed by
 * the RCA, which opens at its "# RCA Report:" title. Older reports carry only one of the
 * two, so a missing part comes back empty and the findings fall back to the whole text.
 */
export function splitInvestigationReport(markdown: string): { findings: string; rca: string } {
    const at = markdown.search(/^#[ \t]+RCA Report\b/m);
    if (at < 0) return { findings: markdown, rca: '' };
    const findings = markdown.slice(0, at).trim();
    return { findings: findings || markdown, rca: markdown.slice(at).trim() };
}
