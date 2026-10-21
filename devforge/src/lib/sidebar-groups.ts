/**
 * Collapsed sidebar groups. Every group starts expanded; only the ones the user
 * collapses are stored, so a group added later shows up expanded.
 */
export function restoreCollapsedGroups(raw: unknown, validGroups: readonly string[]): string[] {
    if (!Array.isArray(raw)) return [];
    return validGroups.filter((g) => raw.includes(g));
}

export function toggleCollapsedGroup(collapsed: readonly string[], group: string): string[] {
    return collapsed.includes(group) ? collapsed.filter((g) => g !== group) : [...collapsed, group];
}
