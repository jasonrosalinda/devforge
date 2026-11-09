import { describe, expect, it } from 'vitest';
import { Activity } from 'lucide-react';
import type { Page } from '@/types/pages.types';
import type { AzureAppEntry } from '@/types/settings.types';
import type { SavedTelemetryQuery } from './telemetry-library';
import { buildPaletteItems } from './command-palette';

const page = (title: string, extra: Partial<Page> = {}): Page => ({ title, icon: Activity, component: () => null, ...extra });
const app = (name: string, extra: Partial<AzureAppEntry> = {}) => ({ name, type: 'appservice', resourceGroup: `${name}-rg`, ...extra }) as AzureAppEntry;
const query = (id: string, appKey: string, target: 'fe' | 'api' = 'fe'): SavedTelemetryQuery =>
    ({ id, name: `Query ${id}`, question: `question ${id}`, kql: 'requests', appKey, target, savedAt: '2026-01-01T00:00:00Z' });

describe('buildPaletteItems', () => {
    it('lists pages, one Health Check per app, saved queries, then Settings', () => {
        const items = buildPaletteItems(
            [page('Home'), page('JWT Decoder', { group: 'Utilities', keywords: ['token'], description: 'Decode a token' })],
            [app('medu-web', { platformName: 'MEDU', apiName: 'medu-api' })],
            [query('q1', 'medu-web', 'api'), query('q2', 'gone-app')],
        );
        expect(items.map(i => [i.group, i.label, i.hint])).toEqual([
            ['Pages', 'Home', undefined],
            ['Pages', 'JWT Decoder', 'Utilities'],
            ['Apps', 'Health Check: MEDU', 'last 6h'],
            ['Saved queries', 'Query q1', 'MEDU · API'],
            ['Saved queries', 'Query q2', 'gone-app · Frontend'],
            ['Actions', 'Open Settings', undefined],
        ]);
        expect(items[1]!.keywords).toEqual(['token', 'Decode a token']);
        expect(items[2]!.keywords).toContain('medu-api');
        expect(items[2]!.action).toEqual({ kind: 'health-check', appKey: 'medu-web' });
        expect(items[3]!.action).toEqual({ kind: 'telemetry-query', queryId: 'q1' });
    });

    it('still offers pages and Settings with no apps or saved queries, with unique ids', () => {
        const items = buildPaletteItems([page('Home')], [], []);
        expect(items.map(i => i.group)).toEqual(['Pages', 'Actions']);
        const ids = buildPaletteItems([page('A')], [app('A')], [query('A', 'A')]).map(i => i.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
