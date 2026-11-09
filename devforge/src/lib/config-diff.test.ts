import { describe, expect, it } from 'vitest';
import type { ConfigDiffRow } from '@shared/types/azureConfig.types';
import type { AzureAppEntry } from '@/types/settings.types';
import { configSites, countByStatus, diffToTsv, sortDiffRows } from './config-diff';

const app = (o: Partial<AzureAppEntry>) => ({ resourceGroup: 'rg', type: 'appservice', ...o }) as AzureAppEntry;

describe('configSites', () => {
    it('offers App Service web apps and App Service APIs only', () => {
        const sites = configSites([
            app({ name: 'medu', platformName: 'MEDU', apiName: 'medu-api' }),
            app({ name: 'msp', apiName: 'msp-api', apiType: 'containerapp' }),
            app({ name: 'ca', type: 'containerapp', apiName: 'ca-api' }),
        ]);
        expect(sites.map(s => [s.key, s.label])).toEqual([
            ['medu::web', 'MEDU (medu)'],
            ['medu::api', 'MEDU API (medu-api)'],
            ['msp::web', 'msp (msp)'],
        ]);
    });
});

describe('rows', () => {
    const rows: ConfigDiffRow[] = [
        { name: 'Z', kind: 'setting', status: 'same', sticky: false },
        { name: 'Db', kind: 'connstr', status: 'differs', sticky: false, type: 'SQLAzure' },
        { name: 'B', kind: 'setting', status: 'differs', sticky: true },
        { name: 'A', kind: 'setting', status: 'only-right', sticky: false },
    ];

    it('sorts differences first, settings before connection strings', () => {
        expect(sortDiffRows(rows).map(r => r.name)).toEqual(['A', 'B', 'Db', 'Z']);
    });

    it('counts statuses', () => {
        expect(countByStatus(rows)).toEqual({ 'only-left': 0, 'only-right': 1, differs: 2, same: 1 });
    });

    it('copies names and statuses as TSV', () => {
        expect(diffToTsv(sortDiffRows(rows).slice(0, 3), 'staging', 'production').split('\n')).toEqual([
            'Name\tKind\tStatus\tSlot setting',
            'A\tApp setting\tOnly in production\t',
            'B\tApp setting\tDiffers\tyes',
            'Db\tConnection string (SQLAzure)\tDiffers\t',
        ]);
    });
});
