import { describe, expect, it } from 'vitest';
import {
    flattenAppSettings, parseSettingRows, stripJsonComments, toAzureAdvancedEdit, toEnvLines, unflattenAppSettings,
} from './appsettings';

const SAMPLE = `{
  // logging
  "Logging": { "LogLevel": { "Default": "Information", }, },
  /* hosts */
  "AllowedHosts": "https://a.example.com//x",
  "Retry": 5,
  "Enabled": true,
  "Empty": null,
  "Origins": ["https://a", "https://b"],
}`;

describe('stripJsonComments', () => {
    it('drops comments and trailing commas but keeps // inside strings', () => {
        expect(JSON.parse(stripJsonComments(SAMPLE)).AllowedHosts).toBe('https://a.example.com//x');
        expect(stripJsonComments('{"a":"x,}"}')).toBe('{"a":"x,}"}');
        expect(stripJsonComments('{"a":"say \\"hi\\" // no"}')).toBe('{"a":"say \\"hi\\" // no"}');
    });
});

describe('flattenAppSettings', () => {
    it('flattens nested keys and arrays with __, values as strings', () => {
        const { rows, collisions, error } = flattenAppSettings(SAMPLE);
        expect(error).toBeUndefined();
        expect(collisions).toEqual([]);
        expect(rows).toEqual([
            { name: 'Logging__LogLevel__Default', value: 'Information' },
            { name: 'AllowedHosts', value: 'https://a.example.com//x' },
            { name: 'Retry', value: '5' },
            { name: 'Enabled', value: 'true' },
            { name: 'Empty', value: '' },
            { name: 'Origins__0', value: 'https://a' },
            { name: 'Origins__1', value: 'https://b' },
        ]);
    });

    it('flags names that collide when case is ignored', () => {
        expect(flattenAppSettings('{"Api":{"Key":"a"},"api":{"key":"b"}}').collisions).toEqual(['Api__Key', 'api__key']);
    });

    it('explains bad input instead of throwing', () => {
        expect(flattenAppSettings('{oops').error).toMatch(/Not valid JSON/);
        expect(flattenAppSettings('[1,2]').error).toMatch(/JSON object/);
    });
});

describe('output formats', () => {
    const rows = [{ name: 'A__B', value: 'x' }, { name: 'Msg', value: 'hello "world"' }];

    it('writes Azure Advanced-edit JSON', () => {
        expect(JSON.parse(toAzureAdvancedEdit(rows, true))).toEqual([
            { name: 'A__B', value: 'x', slotSetting: true },
            { name: 'Msg', value: 'hello "world"', slotSetting: true },
        ]);
    });

    it('writes .env lines and reads them back unchanged', () => {
        const env = toEnvLines(rows);
        expect(env).toBe('A__B=x\nMsg="hello \\"world\\""');
        expect(parseSettingRows(env).rows).toEqual(rows);
    });
});

describe('parseSettingRows + unflattenAppSettings', () => {
    it('reads Advanced-edit JSON and rebuilds nested JSON with arrays', () => {
        const { rows } = parseSettingRows(toAzureAdvancedEdit(flattenAppSettings(SAMPLE).rows));
        const back = JSON.parse(unflattenAppSettings(rows).json);
        expect(back).toEqual({
            Logging: { LogLevel: { Default: 'Information' } },
            AllowedHosts: 'https://a.example.com//x',
            Retry: '5', Enabled: 'true', Empty: '',
            Origins: ['https://a', 'https://b'],
        });
    });

    it('accepts : as a separator, skips comments, reports bad lines and clashing keys', () => {
        expect(JSON.parse(unflattenAppSettings(parseSettingRows('# c\nA:B=1\nA__C=2').rows).json)).toEqual({ A: { B: '1', C: '2' } });
        expect(parseSettingRows('JUSTANAME').error).toMatch(/NAME=value/);
        expect(unflattenAppSettings([{ name: 'A', value: '1' }, { name: 'A__B', value: '2' }]).conflicts).toEqual(['A__B']);
    });
});
