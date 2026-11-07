import { describe, expect, it } from 'vitest';
import { acceptsRcaEvent, newRunId, rcaOutputOf } from './rca-report';

describe('rcaOutputOf', () => {
    it('prefers the edited draft over the streamed text', () => {
        expect(rcaOutputOf('edited', 'raw')).toBe('edited');
        expect(rcaOutputOf('   ', 'raw')).toBe('raw');
        expect(rcaOutputOf('', '')).toBe('');
    });
});

describe('acceptsRcaEvent', () => {
    it('takes only events for this app and this run', () => {
        expect(acceptsRcaEvent({ appKey: 'a', runId: 'r1' }, 'a', 'r1')).toBe(true);
        expect(acceptsRcaEvent({ appKey: 'a', runId: 'r2' }, 'a', 'r1')).toBe(false); // App Investigation vs the card
        expect(acceptsRcaEvent({ appKey: 'b', runId: 'r1' }, 'a', 'r1')).toBe(false);
        expect(acceptsRcaEvent({ appKey: 'a' }, 'a', 'r1')).toBe(false);
    });
});

describe('newRunId', () => {
    it('is unique per call', () => {
        expect(newRunId()).not.toBe(newRunId());
    });
});
