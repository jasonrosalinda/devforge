import { useState } from "react"

import { CopyButton } from "@/components/toolbox/toolbox-shared"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { combineGroups, formatKpi, formatMoney, toTsv } from "@/lib/service-kpi"
import type { CostLine, ServiceKpiCost } from "@shared/types/serviceKpi.types"

function Money({ name, cost }: CostLine) {
    return (
        <span className="inline-flex items-center gap-0.5 tabular-nums">
            {formatMoney(cost)}
            <CopyButton value={formatKpi(cost)} label={`Copy ${name} cost`} />
        </span>
    )
}

interface CostTableProps {
    title: string
    lines: CostLine[]
    currency: string
    /** When set, each row gets a checkbox; keys are lower-case names. */
    selected?: Set<string> | undefined
    onToggle?: ((name: string) => void) | undefined
}

function CostTable({ title, lines, currency, selected, onToggle }: CostTableProps) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
                <CopyButton
                    value={toTsv([title, `Cost (${currency})`], lines.map((l) => [l.name, formatKpi(l.cost)]))}
                    label={`Copy ${title.toLowerCase()} (tab-separated)`}
                    disabled={!lines.length}
                />
            </div>
            <div className="max-h-80 overflow-auto rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            {selected && <TableHead className="w-8"><span className="sr-only">Select</span></TableHead>}
                            <TableHead>Name</TableHead>
                            <TableHead className="text-right">{currency}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {lines.length === 0 && (
                            <TableRow><TableCell colSpan={3} className="py-2 text-muted-foreground">Nothing to show.</TableCell></TableRow>
                        )}
                        {lines.map((l) => (
                            <TableRow key={l.name}>
                                {selected && onToggle && (
                                    <TableCell className="py-1">
                                        <Checkbox checked={selected.has(l.name.toLowerCase())} onCheckedChange={() => onToggle(l.name)} aria-label={`Include ${l.name}`} />
                                    </TableCell>
                                )}
                                <TableCell className="py-1">{l.name}</TableCell>
                                <TableCell className="py-1 text-right"><Money {...l} /></TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
        </div>
    )
}

interface CostCardProps {
    cost: ServiceKpiCost | null
    loading: boolean
    /** Resource groups ticked at first: the configured apps' groups. */
    defaultGroups: string[]
}

/**
 * Subscription cost for the month: total and by service, then by resource group. Ticking
 * groups gives their combined cost by service, which is how a platform's report lines read
 * (the "MEDU (last month)" view is MEDU's prod and UAT groups together).
 */
export function CostCard({ cost, loading, defaultGroups }: CostCardProps) {
    const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultGroups.map((g) => g.toLowerCase())))
    const toggle = (name: string) => setSelected((prev) => {
        const next = new Set(prev)
        const key = name.toLowerCase()
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })

    const combined = cost?.ok ? combineGroups(cost.byResourceGroup, selected) : null
    const selectedNames = cost?.ok ? cost.byResourceGroup.filter((g) => selected.has(g.name.toLowerCase())).map((g) => g.name) : []

    return (
        <Card>
            <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                    Cloud cost
                    {cost?.ok && (
                        <span className="inline-flex items-center gap-0.5 text-sm font-normal text-muted-foreground">
                            subscription total <Money name="total" cost={cost.total} /> {cost.currency}
                        </span>
                    )}
                </CardTitle>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <p className="text-sm text-muted-foreground">Fetching cost…</p>
                ) : !cost ? (
                    <p className="text-sm text-muted-foreground">Fetch a month to see its cost.</p>
                ) : !cost.ok ? (
                    <p className="text-sm text-destructive">{cost.error}</p>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-3">
                        <CostTable title="By resource group" lines={cost.byResourceGroup} currency={cost.currency} selected={selected} onToggle={toggle} />
                        <div className="flex min-w-0 flex-col gap-1">
                            <CostTable title="Selected groups by service" lines={combined?.services ?? []} currency={cost.currency} />
                            <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                                {selectedNames.length ? (
                                    <>Total of {selectedNames.join(" + ")}: <Money name="selected groups" cost={combined?.total ?? 0} /></>
                                ) : (
                                    "Tick resource groups to add them up by service."
                                )}
                            </div>
                        </div>
                        <CostTable title="Subscription by service" lines={cost.byService} currency={cost.currency} />
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
