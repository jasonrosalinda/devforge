// The Ctrl+K palette's entries: every page (Toolbox tools included), a Health Check shortcut
// per configured app, every saved Ask Telemetry query, and Settings.
import type { Page } from '@/types/pages.types';
import type { AzureAppEntry } from '@/types/settings.types';
import type { SavedTelemetryQuery } from './telemetry-library';

export type PaletteGroup = 'Pages' | 'Apps' | 'Saved queries' | 'Actions';

export type PaletteAction =
    | { kind: 'page'; title: string }
    | { kind: 'health-check'; appKey: string }
    | { kind: 'telemetry-query'; queryId: string }
    | { kind: 'settings' };

export interface PaletteItem {
    /** Unique; also the value cmdk filters on, so it starts with the label. */
    id: string;
    group: PaletteGroup;
    label: string;
    hint?: string | undefined;
    keywords: string[];
    action: PaletteAction;
}

export const PALETTE_GROUPS: PaletteGroup[] = ['Pages', 'Apps', 'Saved queries', 'Actions'];

/** Window a palette Health Check opens on, the same 6h as Home's cards. */
export const PALETTE_HEALTH_WINDOW_MS = 6 * 3_600_000;

const appLabel = (a: AzureAppEntry) => a.platformName || a.name;

export function buildPaletteItems(
    pages: Page[],
    apps: AzureAppEntry[],
    library: SavedTelemetryQuery[],
): PaletteItem[] {
    const byName = new Map(apps.map(a => [a.name, a]));
    return [
        ...pages.map((p): PaletteItem => ({
            id: `page:${p.title}`,
            group: 'Pages',
            label: p.title,
            hint: p.group,
            keywords: [...(p.keywords ?? []), ...(p.description ? [p.description] : [])],
            action: { kind: 'page', title: p.title },
        })),
        ...apps.map((a): PaletteItem => ({
            id: `app:${a.name}`,
            group: 'Apps',
            label: `Health Check: ${appLabel(a)}`,
            hint: 'last 6h',
            keywords: [a.name, a.resourceGroup, ...(a.apiName ? [a.apiName] : []), 'health', 'cpu', 'memory', '5xx'],
            action: { kind: 'health-check', appKey: a.name },
        })),
        ...library.map((q): PaletteItem => {
            const app = byName.get(q.appKey);
            return {
                id: `query:${q.id}`,
                group: 'Saved queries',
                label: q.name,
                hint: `${app ? appLabel(app) : q.appKey} · ${q.target === 'api' ? 'API' : 'Frontend'}`,
                keywords: [q.question, 'telemetry', 'kql'],
                action: { kind: 'telemetry-query', queryId: q.id },
            };
        }),
        { id: 'action:settings', group: 'Actions', label: 'Open Settings', keywords: ['settings', 'preferences', 'azure', 'api keys', 'atlassian'], action: { kind: 'settings' } },
    ];
}
