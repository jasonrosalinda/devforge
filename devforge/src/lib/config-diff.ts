// Config Diff page helpers: which sites can be compared, counts, and the copy text.
import type { ConfigDiffRow, ConfigDiffStatus, ConfigSite } from '@shared/types/azureConfig.types';
import type { AzureAppEntry } from '@/types/settings.types';

export interface ConfigSiteOption { key: string; appKey: string; site: ConfigSite; label: string }

/** App Service sites only: a web app, and its API when that is an App Service too. */
export function configSites(apps: AzureAppEntry[]): ConfigSiteOption[] {
    const out: ConfigSiteOption[] = [];
    for (const a of apps) {
        const name = a.platformName || a.name;
        if (a.type === 'appservice') out.push({ key: `${a.name}::web`, appKey: a.name, site: 'web', label: `${name} (${a.name})` });
        if (a.apiName && (a.apiType ?? 'appservice') === 'appservice' && a.type === 'appservice') {
            out.push({ key: `${a.name}::api`, appKey: a.name, site: 'api', label: `${name} API (${a.apiName})` });
        }
    }
    return out;
}

export const STATUS_LABEL: Record<ConfigDiffStatus, string> = {
    'only-left': 'Only left',
    'only-right': 'Only right',
    differs: 'Differs',
    same: 'Same',
};

const ORDER: Record<ConfigDiffStatus, number> = { 'only-left': 0, 'only-right': 1, differs: 2, same: 3 };

/** Differences first, then by kind (settings before connection strings) and name. */
export function sortDiffRows(rows: ConfigDiffRow[]): ConfigDiffRow[] {
    return [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status]
        || (a.kind === b.kind ? 0 : a.kind === 'setting' ? -1 : 1)
        || a.name.localeCompare(b.name));
}

export function countByStatus(rows: ConfigDiffRow[]): Record<ConfigDiffStatus, number> {
    const out: Record<ConfigDiffStatus, number> = { 'only-left': 0, 'only-right': 0, differs: 0, same: 0 };
    for (const r of rows) out[r.status] += 1;
    return out;
}

/** Tab-separated, names and statuses only — never a value. */
export function diffToTsv(rows: ConfigDiffRow[], leftLabel: string, rightLabel: string): string {
    const status = (s: ConfigDiffStatus) => (s === 'only-left' ? `Only in ${leftLabel}` : s === 'only-right' ? `Only in ${rightLabel}` : STATUS_LABEL[s]);
    return [
        ['Name', 'Kind', 'Status', 'Slot setting'].join('\t'),
        ...rows.map(r => [r.name, r.kind === 'setting' ? 'App setting' : `Connection string${r.type ? ` (${r.type})` : ''}`, status(r.status), r.sticky ? 'yes' : ''].join('\t')),
    ].join('\n');
}
