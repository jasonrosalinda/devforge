import { useMemo, useRef, useState } from "react"
import { ClipboardList, Loader2, RefreshCw } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { CostCard } from "@/components/service-kpi/cost-card"
import { KpiTable } from "@/components/service-kpi/kpi-table"
import { CopyButton } from "@/components/toolbox/toolbox-shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSettings } from "@/context/settings-context"
import { fetchUptimeRobotMonitors } from "@/hooks/useUptimeRobotMonitor"
import {
    assembleRowValues, averageUptime, buildKpiRows, currentMonthSgt, formatWindowLabel, kpiWindow, KPI_COLUMNS, monthLabel,
    previousMonthSgt, rgCostCells, rowCopyValues, toTsv, type KpiMonth, type KpiRowSpec, type KpiRowValues,
} from "@/lib/service-kpi"
import type { KpiCell, ServiceKpiCost, ServiceKpiWindow } from "@shared/types/serviceKpi.types"

/** UptimeRobot's exact uptime % for the window, per row that has monitors. Not Azure, but already in Settings. */
async function fetchUptime(rows: KpiRowSpec[], apiKey: string, win: ServiceKpiWindow): Promise<Record<string, KpiCell>> {
    const out: Record<string, KpiCell> = {}
    await Promise.all(rows.filter((r) => r.uptimeMonitorIds.length).map(async (r) => {
        if (!apiKey) {
            out[r.key] = { value: null, note: "Add the UptimeRobot API key in Settings" }
            return
        }
        try {
            const monitors = await fetchUptimeRobotMonitors(apiKey, r.uptimeMonitorIds, win.startIso, win.endIso, true)
            const value = averageUptime(monitors.map((m) => m.custom_uptime_ranges))
            out[r.key] = value == null ? { value: null, note: "UptimeRobot returned no uptime for this month" } : { value }
        } catch (err) {
            out[r.key] = { value: null, error: err instanceof Error ? err.message : String(err) }
        }
    }))
    return out
}

function toMonthInput({ year, month }: KpiMonth): string {
    return `${year}-${String(month + 1).padStart(2, "0")}`
}

export default function ServiceKpiPage() {
    const { settings } = useSettings()
    const rows = useMemo(() => buildKpiRows(settings.azure.apps), [settings.azure.apps])
    const [month, setMonth] = useState<KpiMonth>(() => previousMonthSgt())
    const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
    const [values, setValues] = useState<Record<string, KpiRowValues>>({})
    const [costHints, setCostHints] = useState<Record<string, string>>({})
    const [cost, setCost] = useState<ServiceKpiCost | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    // A slower earlier fetch must not overwrite a newer one (e.g. after switching month).
    const requestId = useRef(0)

    const included = rows.filter((r) => !excluded.has(r.key))
    const hasResults = Object.keys(values).length > 0

    const run = async () => {
        const api = window.electronAPI?.serviceKpi
        if (!api) { setError("Service KPI needs the devForge desktop app."); return }
        const id = ++requestId.current
        const win = kpiWindow(month)
        setLoading(true)
        setError(null)
        try {
            const [res, uptime] = await Promise.all([
                api.fetch({ config: settings.azure, window: win, targets: included.map(({ appName, site }) => ({ appName, site })) }),
                fetchUptime(included, settings.apiKeys.uptimeRobotApiKey, win),
            ])
            if (id !== requestId.current) return
            if ("_error" in res) { setError(res._error); return }
            const rg = rgCostCells(included, res.cost)
            setValues(assembleRowValues(included, res.targets, uptime, rg.cells))
            setCostHints(rg.hints)
            setCost(res.cost)
        } catch (err) {
            if (id === requestId.current) setError(err instanceof Error ? err.message : String(err))
        } finally {
            if (id === requestId.current) setLoading(false)
        }
    }

    const changeMonth = (value: string) => {
        const [y, m] = value.split("-").map(Number)
        if (!y || !m) return
        requestId.current++ // drop any fetch still running for the old month
        setMonth({ year: y, month: m - 1 })
        setValues({})
        setCost(null)
        setLoading(false)
    }

    const toggle = (key: string) => setExcluded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
    })

    const windowLabel = formatWindowLabel(month)
    const copyAll = toTsv(
        ["App", "Resource", ...KPI_COLUMNS.map((c) => c.title)],
        included.filter((r) => values[r.key]).map((r) => [r.label, r.resourceName, ...rowCopyValues(values[r.key])]),
    )

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={ClipboardList}
                title="Service KPI"
                subtitle="One month's CPU, memory, database, 5xx errors, uptime and cloud cost for every app in Settings, ready to copy into the Service KPI report."
            />

            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Month
                    <Input
                        type="month"
                        className="w-44"
                        value={toMonthInput(month)}
                        max={toMonthInput(currentMonthSgt())}
                        onChange={(e) => changeMonth(e.target.value)}
                    />
                </label>
                <Button onClick={() => void run()} disabled={loading || !included.length}>
                    {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    {hasResults ? "Fetch again" : `Fetch ${monthLabel(month)}`}
                </Button>
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <span>{windowLabel}</span>
                    <CopyButton value={windowLabel} label="Copy the report window" />
                </div>
                <div className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
                    Copy all
                    <CopyButton value={hasResults && !loading ? copyAll : ""} label="Copy the whole table (tab-separated, pastes into Excel)" />
                </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No Azure apps configured. Add them in Settings → Azure.</p>
            ) : (
                <div className="rounded-md border">
                    <KpiTable rows={rows} values={values} excluded={excluded} onToggle={toggle} loading={loading} costHints={costHints} />
                </div>
            )}

            <CostCard cost={cost} loading={loading} defaultGroups={[...new Set(rows.map((r) => r.resourceGroup))]} />

            <p className="text-xs text-muted-foreground">
                CPU, memory and DB are the mean of daily averages over the SGT month (App Service figures are for the plan, so sites on one plan match).
                5xx counts every request with a 5xx code, plus failed requests with no code. Cost is the UTC calendar month and needs the Cost Management Reader role.
                Average page load comes from Google Analytics and is not covered here.
            </p>
        </div>
    )
}
