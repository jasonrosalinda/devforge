import { describe, expect, it } from 'vitest';
import { isSecretKey, maskValue, parseConnectionString } from './connstring';

describe('parseConnectionString', () => {
    it('splits SQL Server strings, with a quoted value holding a ;', () => {
        const r = parseConnectionString('Server=tcp:db.database.windows.net,1433;Initial Catalog=medu;User ID=app;Password="p;ss=1";Encrypt=True;');
        expect(r.kind).toBe('SQL Server');
        expect(r.fields).toEqual([
            { key: 'Server', value: 'tcp:db.database.windows.net,1433', secret: false },
            { key: 'Initial Catalog', value: 'medu', secret: false },
            { key: 'User ID', value: 'app', secret: false },
            { key: 'Password', value: 'p;ss=1', secret: true },
            { key: 'Encrypt', value: 'True', secret: false },
        ]);
    });

    it('keeps base64 padding in a storage key and marks it secret', () => {
        const r = parseConnectionString('DefaultEndpointsProtocol=https;AccountName=st;AccountKey=abc+/de==;EndpointSuffix=core.windows.net');
        expect(r.kind).toBe('Storage account');
        expect(r.fields.find(f => f.key === 'AccountKey')).toEqual({ key: 'AccountKey', value: 'abc+/de==', secret: true });
    });

    it('detects Service Bus and treats SharedAccessKeyName as not secret', () => {
        const r = parseConnectionString('Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=Root;SharedAccessKey=xyz=');
        expect(r.kind).toBe('Service Bus / Event Hubs');
        expect(r.fields.map(f => f.secret)).toEqual([false, false, true]);
    });

    it('reads StackExchange.Redis comma strings', () => {
        const r = parseConnectionString('cache.redis.cache.windows.net:6380,password=s3cret,ssl=True,abortConnect=False');
        expect(r.kind).toBe('Redis');
        expect(r.fields[0]).toEqual({ key: 'Host', value: 'cache.redis.cache.windows.net:6380', secret: false });
        expect(r.fields[1]!.secret).toBe(true);
    });

    it('handles empty and unknown input', () => {
        expect(parseConnectionString('  ')).toEqual({ kind: '', fields: [] });
        expect(parseConnectionString('foo=bar').kind).toBe('Unknown');
        expect(parseConnectionString('InstrumentationKey=1;IngestionEndpoint=https://x/').kind).toBe('Application Insights');
        expect(parseConnectionString('AccountEndpoint=https://c.documents.azure.com:443/;AccountKey=k==;').kind).toBe('Cosmos DB');
    });
});

describe('secrets', () => {
    it('recognises secret keys case-insensitively', () => {
        expect(['PWD', 'password', 'AccountKey', 'SharedAccessKey', 'Client Secret'].every(isSecretKey)).toBe(true);
        expect(['User ID', 'SharedAccessKeyName', 'AccountName'].some(isSecretKey)).toBe(false);
    });

    it('masks all but the last 4 characters of long values', () => {
        expect(maskValue('abcdefghijkl')).toBe('••••••••ijkl');
        expect(maskValue('short')).toBe('•••••');
    });
});
