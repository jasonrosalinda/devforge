// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { parseRunbookSections } from './parse-runbook';

// A bare table parses fine (section title defaults to "Runbook"); we skip a
// heading element so the test doesn't exercise headingText's namespaced
// selector, which happy-dom can't parse (Chromium, the real runtime, can).
function page(tableHtml: string): string {
  return tableHtml;
}

const HEADER =
  '<tr><th>Date</th><th>Time</th><th>Activity</th><th>Duration</th><th>Status</th><th>PIC(s)</th></tr>';

function firstTable(html: string) {
  const sections = parseRunbookSections(html, []);
  expect(sections.length).toBe(1);
  return sections[0]!.table;
}

describe('parseTable — merged cells (colspan / rowspan)', () => {
  it('keeps columns aligned when a cell has rowspan', () => {
    // Date cell on row 1 spans 2 rows; row 2 has no Date cell of its own.
    const html = page(`<table>
      ${HEADER}
      <tr>
        <td rowspan="2">22 Jun 2026</td><td>5:30 PM</td><td>GA Monitoring</td>
        <td>&lt; 5m</td><td>DONE</td><td>Jubilee</td>
      </tr>
      <tr>
        <td>6:00 PM</td><td>Pre-PROD release stats</td>
        <td>&lt; 5m</td><td>DONE</td><td>Dityo</td>
      </tr>
    </table>`);

    const { columns, rows } = firstTable(html);
    expect(columns).toEqual(['Date', 'Time', 'Activity', 'Duration', 'Status', 'PIC(s)']);
    expect(rows.length).toBe(2);
    // Every row is padded to the column width.
    expect(rows.every(r => r.length === 6)).toBe(true);

    const text = (r: number) => rows[r]!.map(c => c.text);
    expect(text(0)).toEqual(['22 Jun 2026', '5:30 PM', 'GA Monitoring', '< 5m', 'DONE', 'Jubilee']);
    // Row 2: the rowspan'd Date slot is empty; remaining cells stay under their headers.
    expect(text(1)).toEqual(['', '6:00 PM', 'Pre-PROD release stats', '< 5m', 'DONE', 'Dityo']);
  });

  it('keeps columns aligned when a cell has colspan', () => {
    // Activity cell spans Activity + Duration (2 columns).
    const html = page(`<table>
      ${HEADER}
      <tr>
        <td>22 Jun 2026</td><td>7:00 PM</td>
        <td colspan="2">Take CLS/LCP PageSpeed insights</td>
        <td>DONE</td><td>Dityo / Jason</td>
      </tr>
    </table>`);

    const { rows } = firstTable(html);
    expect(rows[0]!.length).toBe(6);
    const text = rows[0]!.map(c => c.text);
    // colspan continuation slot (Duration) is empty; Status/PIC stay aligned.
    expect(text).toEqual(['22 Jun 2026', '7:00 PM', 'Take CLS/LCP PageSpeed insights', '', 'DONE', 'Dityo / Jason']);
  });

  it('does not let a nested table leak extra columns', () => {
    // Logbook cell contains its own little table.
    const html = page(`<table>
      ${HEADER}
      <tr>
        <td>22 Jun 2026</td><td>5:30 PM</td><td>GA Monitoring</td>
        <td>&lt; 5m</td><td>DONE</td>
        <td>Jubilee<table><tr><td>nested-a</td><td>nested-b</td></tr></table></td>
      </tr>
    </table>`);

    const { columns, rows } = firstTable(html);
    expect(columns.length).toBe(6);
    expect(rows[0]!.length).toBe(6);
    expect(rows[0]![0]!.text).toBe('22 Jun 2026');
  });

  it('drops "rollback confirmation" rows (marker), even when merged cells shift the text', () => {
    const html = page(`<table>
      ${HEADER}
      <tr><td>22 Jun</td><td>5:30 PM</td><td>GA Monitoring</td><td>&lt; 5m</td><td>DONE</td><td>Jubilee</td></tr>
      <tr><td colspan="2">rollback confirmation→ after qc verification</td><td>&lt; 15m</td><td>DONE</td><td>Sam</td></tr>
    </table>`);

    const { rows } = firstTable(html);
    expect(rows.length).toBe(1);
    expect(rows[0]![2]!.text).toBe('GA Monitoring');
  });
});
