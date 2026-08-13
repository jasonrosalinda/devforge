import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseCrashKey, parseCrashStackTrace, parseCrashEvents, crashTotals, eventsByExceptionType, CRASH_KEYWORDS, CRASH_CHART_MATCH } = require('./azure-crashmonitoring.cjs');
const { findDetector, parseDetectorCharts } = require('./azure-detectors.cjs');

// Shapes confirmed live against a real site's `appcrashes` detector.
const timeline = {
  renderingProperties: { type: 2, title: 'Application Crashes Timeline' },
  table: {
    columns: [
      { columnName: 'TimeStamp', dataType: 'DateTime' },
      { columnName: 'Crashes', dataType: 'Int32' },
    ],
    rows: [
      ['2026-08-12T02:25:00Z', 2],
      ['2026-08-13T03:50:00Z', 4],
    ],
  },
};

const dropdown = {
  renderingProperties: { type: 11, title: '' },
  table: {
    columns: [
      { columnName: 'Label', dataType: 'String' },
      { columnName: 'Key', dataType: 'String' },
      { columnName: 'Selected', dataType: 'Boolean' },
      { columnName: 'Value', dataType: 'String' },
      { columnName: 'DropdownType', dataType: 'String' },
      { columnName: 'DropdownPosition', dataType: 'String' },
    ],
    rows: [
      [
        'Select a crash event',
        '08/13/2026 03:35:49 0xE0434352 - CLR Exception System.ObjectDisposedException',
        true,
        JSON.stringify([{ table: { tableName: '', columns: [{ columnName: 'Markdown' }], rows: [["<ul><li><span style='color:gray'>Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()\r</span></li>\n<li><span>MIMS.Education.Repos.SeriesRepo+d__28.MoveNext()\r</span></li></ul>"]] } }]),
        'Legacy',
        'FloatLeft',
      ],
      [
        'Select a crash event',
        '08/12/2026 08:32:20 0xE0434352 - CLR Exception System.ObjectDisposedException',
        false,
        JSON.stringify([{ table: { tableName: '', columns: [{ columnName: 'Markdown' }], rows: [['<ul><li>at Foo.Bar()</li></ul>']] } }]),
        'Legacy',
        'FloatLeft',
      ],
    ],
  },
};

describe('findDetector — crash keyword priority', () => {
  it('finds the confirmed live id ahead of the human label', () => {
    const list = { value: [
      { name: 'crashmonitoring', properties: { metadata: { name: 'Crash Monitoring' } } },
      { name: 'appcrashes', properties: { metadata: { name: 'Application Crashes' } } },
    ] };
    expect(findDetector(list, CRASH_KEYWORDS)).toBe('appcrashes');
  });

  it('returns null when nothing matches', () => {
    const list = { value: [{ name: 'sitecpuanalysis' }] };
    expect(findDetector(list, CRASH_KEYWORDS)).toBeNull();
  });
});

describe('parseDetectorCharts — crash timeline', () => {
  it('reads the single Crashes series off the timeline dataset', () => {
    const out = parseDetectorCharts({ properties: { dataset: [timeline] } }, 'appcrashes', { titleMatch: CRASH_CHART_MATCH });
    expect(out.charts).toHaveLength(1);
    expect(out.charts[0].series[0].series.map(p => p.count)).toEqual([2, 4]);
  });

  it('ignores the per-event dropdown dataset — no time column to key off', () => {
    expect(parseDetectorCharts({ properties: { dataset: [dropdown] } }, 'appcrashes', { titleMatch: CRASH_CHART_MATCH })).toBeNull();
  });
});

describe('parseCrashKey', () => {
  it('splits timestamp, exit code, category and exception type', () => {
    expect(parseCrashKey('08/13/2026 03:35:49 0xE0434352 - CLR Exception System.ObjectDisposedException')).toEqual({
      t: '2026-08-13T03:35:49.000Z',
      exitCode: '0xE0434352',
      category: 'CLR Exception',
      exceptionType: 'System.ObjectDisposedException',
    });
  });

  it('falls back to a null exception type for a key with no dotted identifier', () => {
    expect(parseCrashKey('08/13/2026 03:35:49 0xC0000005 - Access Violation')).toEqual({
      t: '2026-08-13T03:35:49.000Z',
      exitCode: '0xC0000005',
      category: 'Access Violation',
      exceptionType: null,
    });
  });

  it('returns null for text that is not a crash key', () => {
    expect(parseCrashKey('Select a crash event')).toBeNull();
    expect(parseCrashKey('')).toBeNull();
  });
});

describe('parseCrashStackTrace', () => {
  it('reads through the JSON + HTML wrappers to a plain, newline-joined trace', () => {
    const [row] = dropdown.table.rows;
    expect(parseCrashStackTrace(row[3])).toBe(
      'Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()\nMIMS.Education.Repos.SeriesRepo+d__28.MoveNext()',
    );
  });

  it('falls back to plain tag-stripping when the value is not the expected JSON shape', () => {
    expect(parseCrashStackTrace('<b>boom</b>')).toBe('boom');
  });
});

describe('parseCrashEvents', () => {
  it('reads one event per dropdown row, newest first', () => {
    const out = parseCrashEvents({ properties: { dataset: [dropdown] } });
    expect(out).toHaveLength(2);
    expect(out[0].t).toBe('2026-08-13T03:35:49.000Z');
    expect(out[0].stackTrace).toContain('CheckDisposed');
    expect(out.at(-1)?.t).toBe('2026-08-12T08:32:20.000Z');
  });

  it('skips a dataset with no Key/Value columns rather than assuming table position', () => {
    expect(parseCrashEvents({ properties: { dataset: [timeline] } })).toEqual([]);
  });

  it('handles a site with no dataset at all', () => {
    expect(parseCrashEvents({ properties: { dataset: [] } })).toEqual([]);
    expect(parseCrashEvents({})).toEqual([]);
  });
});

describe('crashTotals', () => {
  it('sums the timeline series', () => {
    const charts = parseDetectorCharts({ properties: { dataset: [timeline] } }, 'appcrashes', { titleMatch: CRASH_CHART_MATCH }).charts;
    expect(crashTotals(charts)).toEqual({ total: 6 });
  });

  it('handles a site with no crash chart at all', () => {
    expect(crashTotals(null)).toEqual({ total: 0 });
    expect(crashTotals([])).toEqual({ total: 0 });
  });
});

describe('eventsByExceptionType', () => {
  it('groups captured events by exception type and ranks them', () => {
    const events = parseCrashEvents({ properties: { dataset: [dropdown] } });
    expect(eventsByExceptionType(events)).toEqual([{ cause: 'System.ObjectDisposedException', count: 2 }]);
  });

  it('groups an unreadable exception under "Unknown exception" rather than dropping it', () => {
    expect(eventsByExceptionType([{ t: '10:00', exitCode: '', category: '', exceptionType: null, stackTrace: '' }]))
      .toEqual([{ cause: 'Unknown exception', count: 1 }]);
  });

  it('handles no events at all', () => {
    expect(eventsByExceptionType([])).toEqual([]);
  });
});
