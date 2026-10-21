import { useMemo } from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import type { TelemetryCell, TelemetryColumn } from '@shared/types/telemetry.types';
import { formatCell, isNumericType } from '@/lib/telemetry-chart';
import { DataTable } from '@/components/ui/data-table';
import { DataTableSearchBox } from '@/components/ui/data-table-search-box';
import { DataTableColumnHeader } from '@/components/ui/data-table-column-header';

type Row = Record<string, TelemetryCell>;

/** The raw result. Columns come from the query, so they're built at runtime. */
export function TelemetryResultTable({ columns, rows }: { columns: TelemetryColumn[]; rows: TelemetryCell[][] }) {
    const defs = useMemo<ColumnDef<Row>[]>(() => columns.map((c, i) => ({
        id: `c${i}`,
        accessorFn: (row) => row[`c${i}`],
        header: ({ column }) => <DataTableColumnHeader column={column} title={c.name} />,
        cell: ({ getValue }) => {
            const text = formatCell(getValue() as TelemetryCell, c.type);
            return (
                <span
                    title={text.length > 80 ? text : undefined}
                    className={isNumericType(c.type) ? 'block text-right tabular-nums' : 'block max-w-[480px] truncate font-mono text-xs'}
                >
                    {text}
                </span>
            );
        },
    })), [columns]);

    const data = useMemo(
        () => rows.map(r => Object.fromEntries(r.map((v, i) => [`c${i}`, v])) as Row),
        [rows],
    );

    return (
        <DataTable
            columns={defs}
            data={data}
            header={(table) => <DataTableSearchBox table={table} />}
        />
    );
}
