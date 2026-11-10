import { describe, expect, it } from 'vitest';
import { acceptsRcaEvent, newRunId, rcaOutputOf, splitInvestigationReport } from './rca-report';

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

describe('splitInvestigationReport', () => {
    it('splits the findings from the RCA at its title', () => {
        const findings = ['## Summary', 'MEDU failed.'].join('\n');
        const rca = ['# RCA Report: MEDU 500s', '', '## 1. Background', 'x'].join('\n');
        expect(splitInvestigationReport(`${findings}\n\n${rca}`)).toEqual({ findings, rca });
    });

    it('treats a report without an RCA as findings only', () => {
        expect(splitInvestigationReport('## Summary')).toEqual({ findings: '## Summary', rca: '' });
    });

    it('keeps an RCA-only report visible as findings too', () => {
        const md = ['# RCA Report: X', '', '## 1. Background', 'x'].join('\n');
        expect(splitInvestigationReport(md)).toEqual({ findings: md, rca: md });
    });
});
