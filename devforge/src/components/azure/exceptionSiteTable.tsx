// Throw sites behind one exception type, as a table.
//
// Replaces a list that printed one row per endpoint. A shared component that
// throws on 300 pages produced 300 rows all reading "1" and all repeating the
// same stack frame, which buried the only fact that mattered: it is one defect
// with twenty thousand occurrences. Here the frame is the row and the endpoint
// is an attribute of it — named when it is the only one, counted when it is not.

import type { ExceptionSiteRow } from '@shared/types/azureMetrics.types';

/** Line numbers as the table shows them: "24, 54", or blank when the frames
 *  carried none. Zero is the sentinel for "no line info", never a real line. */
export function formatLines(lines: number[]): string {
  return lines.filter(n => n > 0).sort((a, b) => a - b).join(', ');
}

/** The endpoint column. One endpoint is worth naming; several are worth
 *  counting, because the list of them is exactly the noise this table removes. */
export function endpointLabel(row: Pick<ExceptionSiteRow, 'endpoints' | 'sampleEndpoint'>): string {
  if (row.endpoints > 1) return `${row.endpoints.toLocaleString()} endpoints`;
  return row.sampleEndpoint || '';
}

/** `method @ file` — the frame as it reads in a stack trace. */
export function stackLabel(row: Pick<ExceptionSiteRow, 'assembly' | 'method' | 'file'>): string {
  if (row.method && row.file) return `${row.method} @ ${row.file}`;
  return row.method || row.file || row.assembly || '(unknown site)';
}

// Row content here is a wrapped file path several lines tall, so the vertical
// padding has to be enough to keep one row's last line off the next row's first.
const TH: React.CSSProperties = {
  textAlign: 'left', fontWeight: 600, color: '#6e7681',
  padding: '5px 12px 6px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)',
  whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '7px 12px', verticalAlign: 'top',
  borderBottom: '1px solid rgba(255,255,255,0.03)',
  lineHeight: 1.5,
};

export function ExceptionSiteTable({ rows, topN }: {
  /** Already filtered to one exception type by the caller. */
  rows: ExceptionSiteRow[];
  topN?: number | null | undefined;
}) {
  if (!rows.length) return null;
  const ranked = [...rows].sort((a, b) => b.trueCount - a.trueCount);

  return (
    <div style={{ fontSize: 9 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr>
            <th style={TH}>Source / Stack</th>
            <th style={{ ...TH, width: 96 }}>Line Number</th>
            {/* Wide enough that the header itself does not clip — it is the
                longest label in the row and the table layout is fixed. */}
            <th style={{ ...TH, width: 205 }} title="Endpoint that reached this site, or how many did">Source / Endpoints</th>
            <th style={{ ...TH, width: 92, textAlign: 'right' }}>Total Errors</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r, i) => {
            const lines = formatLines(r.lines);
            const endpoint = endpointLabel(r);
            return (
              <tr key={i}>
                <td style={{ ...TD, fontFamily: 'monospace', color: '#3fb950', wordBreak: 'break-all' }} title={stackLabel(r)}>
                  {stackLabel(r)}
                </td>
                <td
                  style={{ ...TD, fontFamily: 'monospace', color: '#8b949e' }}
                  title={r.lines.length > 1 ? `${r.lines.length} distinct lines in this file threw` : undefined}
                >
                  {lines}
                </td>
                <td style={{ ...TD, color: 'var(--muted-foreground)', wordBreak: 'break-all' }} title={r.endpoints > 1 ? undefined : r.sampleEndpoint}>
                  {endpoint}
                </td>
                <td
                  className="tabular-nums"
                  style={{ ...TD, textAlign: 'right', color: '#f85149', fontWeight: 600 }}
                  title={r.records !== r.trueCount
                    ? `${r.trueCount.toLocaleString()} occurrences, reconstructed from ${r.records.toLocaleString()} sampled records`
                    : undefined}
                >
                  {r.trueCount.toLocaleString()}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {topN != null && ranked.length >= topN && (
        <div style={{ color: '#6e7681', paddingTop: 3 }}>
          Showing the {topN} highest-volume throw sites for this type.
        </div>
      )}
    </div>
  );
}
