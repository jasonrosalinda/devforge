import { describe, it, expect } from 'vitest';
import { crashTotals, crashEvents, eventsByExceptionType, groupCrashEvents } from './crashMonitoringSection';

const crashes = {
  detector: 'appcrashes',
  charts: [{
    title: 'Application Crashes Timeline',
    series: [{ name: 'Application Crashes Timeline', series: [{ t: '2026-08-12T02:25:00Z', count: 2 }, { t: '2026-08-13T03:50:00Z', count: 4 }] }],
  }],
  events: [
    { t: '2026-08-13T03:35:49Z', exitCode: '0xE0434352', category: 'CLR Exception', exceptionType: 'System.ObjectDisposedException', stackTrace: 'at Foo.Bar()' },
    { t: '2026-08-12T08:32:20Z', exitCode: '0xE0434352', category: 'CLR Exception', exceptionType: 'System.ObjectDisposedException', stackTrace: 'at Foo.Bar()' },
    { t: '2026-08-12T09:00:00Z', exitCode: '0xE0434352', category: 'CLR Exception', exceptionType: 'System.OutOfMemoryException', stackTrace: 'at Baz.Qux()' },
  ],
};

describe('crashTotals', () => {
  it('sums the timeline series', () => {
    expect(crashTotals(crashes)).toEqual({ total: 6 });
  });

  it('handles a site with no crash chart at all', () => {
    expect(crashTotals(null)).toEqual({ total: 0 });
    expect(crashTotals(undefined)).toEqual({ total: 0 });
    expect(crashTotals({ charts: [], events: [] })).toEqual({ total: 0 });
  });
});

describe('crashEvents', () => {
  it('passes the detector\'s captured events through as-is', () => {
    expect(crashEvents(crashes)).toBe(crashes.events);
  });

  it('is empty when there is no crash data', () => {
    expect(crashEvents(null)).toEqual([]);
    expect(crashEvents({ charts: [], events: [] })).toEqual([]);
  });
});

describe('eventsByExceptionType', () => {
  it('groups captured events by exception type and ranks them', () => {
    expect(eventsByExceptionType(crashes.events)).toEqual([
      { cause: 'System.ObjectDisposedException', count: 2 },
      { cause: 'System.OutOfMemoryException', count: 1 },
    ]);
  });

  it('groups an unnamed exception under "Unknown exception"', () => {
    const out = eventsByExceptionType([{ t: '10:00', exitCode: '', category: '', exceptionType: null, stackTrace: '' }]);
    expect(out).toEqual([{ cause: 'Unknown exception', count: 1 }]);
  });

  it('handles no events at all', () => {
    expect(eventsByExceptionType([])).toEqual([]);
  });
});

describe('groupCrashEvents', () => {
  it('merges events with the same exception type and stack trace, joining their times', () => {
    const out = groupCrashEvents(crashes.events);
    expect(out).toHaveLength(2);
    const disposed = out.find(g => g.exceptionType === 'System.ObjectDisposedException');
    expect(disposed?.times).toEqual(['2026-08-13T03:35:49Z', '2026-08-12T08:32:20Z']);
  });

  it('keeps events with the same exception type but a different stack trace separate', () => {
    const out = groupCrashEvents([
      { t: '2026-08-13T00:00:00Z', exitCode: '0x1', category: 'CLR Exception', exceptionType: 'System.ObjectDisposedException', stackTrace: 'at A()' },
      { t: '2026-08-13T01:00:00Z', exitCode: '0x1', category: 'CLR Exception', exceptionType: 'System.ObjectDisposedException', stackTrace: 'at B()' },
    ]);
    expect(out).toHaveLength(2);
  });

  it('sorts groups newest-occurrence-first', () => {
    const out = groupCrashEvents(crashes.events);
    expect(out[0]?.times[0]).toBe('2026-08-13T03:35:49Z');
  });

  it('handles no events at all', () => {
    expect(groupCrashEvents([])).toEqual([]);
  });
});
