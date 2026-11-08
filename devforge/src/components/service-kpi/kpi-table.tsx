import { CopyButton } from "@/components/toolbox/toolbox-shared"
import { Checkbox } from "@/components/ui/checkbox"
import { Hint } from "@/components/ui/hint"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatKpi, KPI_COLUMNS, rowCopyValues, type KpiRowSpec, type KpiRowValues } from "@/lib/service-kpi"
import type { KpiCell } from "@shared/types/serviceKpi.types"

interface ValueCellProps {
    cell: KpiCell | undefined
    dp: number
    missing: string
    loading: boolean
    /** Extra context on a present value, e.g. that a resource group's cost is shared. */
    hint?: string | undefined
}

function ValueCell({ cell, dp, missing, loading, hint }: ValueCellProps) {
    if (loading) return <span className="text-muted-foreground">…</span>
    if (!cell) return <Hint label={missing}><span className="text-muted-foreground">-</span></Hint>
    if (cell.error) return <Hint label={cell.error}><span className="text-destructive">Error</span></Hint>
    if (cell.value == null) return <Hint label={cell.note ?? missing}><span className="text-muted-foreground">-</span></Hint>
    const text = formatKpi(cell.value, dp)
    return (
        <span className="inline-flex items-center gap-0.5 tabular-nums">
            <Hint label={hint}><span>{text}</span></Hint>
            <CopyButton value={text} label={`Copy ${text}`} />
        </span>
    )
}

interface KpiTableProps {
    rows: KpiRowSpec[]
    values: Record<string, KpiRowValues>
    excluded: Set<string>
    onToggle: (key: string) => void
    loading: boolean
    /** Per-row note for the RG cost column, e.g. that the resource group is shared. */
    costHints: Record<string, string>
}

export function KpiTable({ rows, values, excluded, onToggle, loading, costHints }: KpiTableProps) {
    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead className="w-8"><span className="sr-only">Include</span></TableHead>
                    <TableHead>App</TableHead>
                    {KPI_COLUMNS.map((c) => <TableHead key={c.id} className="text-right">{c.title}</TableHead>)}
                    <TableHead className="w-10"><span className="sr-only">Copy row</span></TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row) => {
                    const off = excluded.has(row.key)
                    const v = values[row.key]
                    const rowLoading = loading && !off
                    return (
                        <TableRow key={row.key} className={off ? "opacity-50" : undefined}>
                            <TableCell>
                                <Checkbox checked={!off} onCheckedChange={() => onToggle(row.key)} aria-label={`Include ${row.label}`} />
                            </TableCell>
                            <TableCell>
                                <div className="font-medium">{row.label}</div>
                                <div className="text-xs text-muted-foreground">
                                    {row.resourceName} · {row.resourceGroup}
                                    {v?.scope ? ` · ${v.scope}` : ""}
                                </div>
                            </TableCell>
                            {KPI_COLUMNS.map((c) => (
                                <TableCell key={c.id} className="text-right">
                                    {off ? (
                                        <span className="text-muted-foreground">-</span>
                                    ) : (
                                        <ValueCell
                                            cell={v?.[c.id]}
                                            dp={c.dp}
                                            // A row ticked back on after a fetch has no values yet; don't blame Settings for that.
                                            missing={v ? c.missing : "Not fetched yet. Press Fetch."}
                                            loading={rowLoading}
                                            hint={c.id === "cost" ? costHints[row.key] : undefined}
                                        />
                                    )}
                                </TableCell>
                            ))}
                            <TableCell>
                                {!off && v && !loading && (
                                    <CopyButton value={rowCopyValues(v).join("\t")} label={`Copy ${row.label} row (tab-separated, column order as shown)`} />
                                )}
                            </TableCell>
                        </TableRow>
                    )
                })}
            </TableBody>
        </Table>
    )
}
