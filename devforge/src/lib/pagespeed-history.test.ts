import { describe, it, expect } from 'vitest';
import { migrateConfig } from './pagespeed-history';

// Snapshots on disk predate every field added since they were written, so a config
// read back has to come out complete — the results table reads these flags directly.
describe('migrateConfig', () => {
    const legacy = { urls: ['https://example.com/'], comparisonMode: true } as never;

    it('defaults the comparison columns for a snapshot saved before the setting existed', () => {
        expect(migrateConfig(legacy).comparisonColumns).toBe('both');
    });

    it('keeps an explicit choice', () => {
        expect(migrateConfig({ ...(legacy as object), comparisonColumns: 'after' } as never).comparisonColumns).toBe('after');
    });

    it('defaults the warm-up run off for a snapshot saved before the setting existed', () => {
        expect(migrateConfig(legacy).warmUpRun).toBe(false);
        expect(migrateConfig({ ...(legacy as object), warmUpRun: true } as never).warmUpRun).toBe(true);
    });

    it('still derives runs from the retired runMode', () => {
        expect(migrateConfig({ ...(legacy as object), runMode: 'average' } as never).runs).toBe(3);
        expect(migrateConfig({ ...(legacy as object), runMode: 'single' } as never).runs).toBe(1);
    });
});
