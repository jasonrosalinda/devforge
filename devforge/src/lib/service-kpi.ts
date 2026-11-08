import type { AzureAppEntry } from "@/types/settings.types"
import type { CostLine, KpiCell, ResourceGroupCost, ServiceKpiCost, ServiceKpiTarget, ServiceKpiTargetResult, ServiceKpiWindow } from "@shared/types/serviceKpi.types"

/** Singapore time, which the KPI report is always read in (no daylight saving). */
const SGT_OFFSET_MS = 8 * 3_600_000

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export interface KpiMonth {
    year: number
    /** 0-11, as Date uses. */
    month: number
}

/** The month `now` falls in, in SGT. */
export function currentMonthSgt(now: Date = new Date()): KpiMonth {
    const sgt = new Date(now.getTime() + SGT_OFFSET_MS)
    return { year: sgt.getUTCFullYear(), month: sgt.getUTCMonth() }
}

/** The month before `now`, in SGT. January rolls back to the previous December. */
export function previousMonthSgt(now: Date = new Date()): KpiMonth {
    const { year, month } = currentMonthSgt(now)
    return month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }
}

/** The metric window (SGT calendar month) and the cost window (UTC calendar month). */
export function kpiWindow({ year, month }: KpiMonth): ServiceKpiWindow {
    return {
        startIso: new Date(Date.UTC(year, month, 1) - SGT_OFFSET_MS).toISOString(),
        endIso: new Date(Date.UTC(year, month + 1, 1) - SGT_OFFSET_MS).toISOString(),
        costFrom: new Date(Date.UTC(year, month, 1)).toISOString(),
        costTo: new Date(Date.UTC(year, month + 1, 1) - 1000).toISOString(),
    }
}

/** "01 Mar 2024 12:00:00 AM to 31 Mar 2024 11:59:59 PM (UTC+08)", the wording the runbook asks for. */
export function formatWindowLabel({ year, month }: KpiMonth): string {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    const mon = MONTHS[month]
    return `01 ${mon} ${year} 12:00:00 AM to ${String(lastDay).padStart(2, "0")} ${mon} ${year} 11:59:59 PM (UTC+08)`
}

export function monthLabel({ year, month }: KpiMonth): string {
    return `${MONTHS[month]} ${year}`
}

/** A value to show or copy: `dp` places, "-" when there is none. */
export function formatKpi(value: number | null | undefined, dp = 2): string {
    return value == null || Number.isNaN(value) ? "-" : value.toFixed(dp)
}

/** Cost with thousands separators, 2 dp. Copying uses {@link formatKpi} so Excel gets a plain number. */
export function formatMoney(value: number): string {
    return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function targetKey(t: ServiceKpiTarget): string {
    return `${t.appName}::${t.site}`
}

export interface KpiRowSpec extends ServiceKpiTarget {
    key: string
    /** What the row is called: the platform, with "API" for its API site. */
    label: string
    /** The Azure resource name of this site (the API's own name for an API row). */
    resourceName: string
    resourceGroup: string
    type: "appservice" | "containerapp"
    /** The platform's UptimeRobot monitors, web row only. */
    uptimeMonitorIds: string[]
}

/** One row per configured web site, plus one for its API where the entry names one. */
export function buildKpiRows(apps: AzureAppEntry[]): KpiRowSpec[] {
    const rows: KpiRowSpec[] = []
    for (const app of apps) {
        const platform = app.platformName || app.name
        rows.push({
            appName: app.name,
            site: "web",
            key: targetKey({ appName: app.name, site: "web" }),
            label: platform,
            resourceName: app.name,
            resourceGroup: app.resourceGroup,
            type: app.type,
            uptimeMonitorIds: app.uptimeRobotMonitorIds ?? [],
        })
        if (app.apiName) {
            rows.push({
                appName: app.name,
                site: "api",
                key: targetKey({ appName: app.name, site: "api" }),
                label: `${platform} API`,
                resourceName: app.apiName,
                resourceGroup: app.resourceGroup,
                type: app.apiType ?? "appservice",
                uptimeMonitorIds: [],
            })
        }
    }
    return rows
}

/** Mean of UptimeRobot's `custom_uptime_ranges` values ("99.94"), skipping any that don't parse. Null when none do. */
export function averageUptime(ranges: (string | undefined)[]): number | null {
    const values = ranges.map((r) => Number.parseFloat(r ?? "")).filter((n) => Number.isFinite(n))
    return values.length ? values.reduce((s, n) => s + n, 0) / values.length : null
}

/** One row's figures, resolved: `undefined` = not applicable to this row (no DB, no monitor...). */
export interface KpiRowValues {
    scope: string | null
    cpu?: KpiCell | undefined
    memory?: KpiCell | undefined
    db?: KpiCell | undefined
    errors5xx?: KpiCell | undefined
    uptime?: KpiCell | undefined
    cost?: KpiCell | undefined
}

/** Column order, shared by the table, Copy row and Copy all, so a pasted row lines up with the header. */
export const KPI_COLUMNS = [
    { id: "cpu", title: "CPU % (avg)", dp: 2, missing: "No CPU data" },
    { id: "memory", title: "Memory % (avg)", dp: 2, missing: "No memory data" },
    { id: "db", title: "DB CPU % (avg)", dp: 2, missing: "No database in Settings for this app" },
    { id: "errors5xx", title: "5xx errors", dp: 0, missing: "No App Insights resource for this site" },
    { id: "uptime", title: "Uptime %", dp: 1, missing: "No UptimeRobot monitor in Settings for this app" },
    { id: "cost", title: "RG cost (USD)", dp: 2, missing: "No cost data" },
] as const

export function rowCopyValues(values: KpiRowValues | undefined): string[] {
    return KPI_COLUMNS.map((c) => formatKpi(values?.[c.id]?.value, c.dp))
}

/**
 * Each row's resource-group cost, and a hint naming the group (and how many rows share it,
 * since adding those cells up would count the group more than once).
 */
export function rgCostCells(rows: KpiRowSpec[], cost: ServiceKpiCost): { cells: Record<string, KpiCell>; hints: Record<string, string> } {
    const cells: Record<string, KpiCell> = {}
    const hints: Record<string, string> = {}
    const sharing = new Map<string, number>()
    for (const r of rows) sharing.set(r.resourceGroup.toLowerCase(), (sharing.get(r.resourceGroup.toLowerCase()) ?? 0) + 1)
    for (const r of rows) {
        if (!cost.ok) {
            cells[r.key] = { value: null, error: cost.error }
            continue
        }
        const rg = r.resourceGroup.toLowerCase()
        // A group with no line had no charges in the month (zero lines are dropped).
        cells[r.key] = { value: cost.byResourceGroup.find((l) => l.name.toLowerCase() === rg)?.cost ?? 0 }
        const n = sharing.get(rg) ?? 1
        hints[r.key] = n > 1 ? `Whole resource group ${r.resourceGroup}, shared by ${n} rows` : `Whole resource group ${r.resourceGroup}`
    }
    return { cells, hints }
}

/**
 * Several resource groups' cost added up, with a combined per-service split, largest first.
 * A platform's report figure often spans groups (e.g. its prod and UAT groups).
 */
export function combineGroups(groups: ResourceGroupCost[], selected: Set<string>): { total: number; services: CostLine[] } {
    const services = new Map<string, number>()
    let total = 0
    for (const g of groups) {
        if (!selected.has(g.name.toLowerCase())) continue
        total += g.cost
        for (const s of g.services) services.set(s.name, (services.get(s.name) ?? 0) + s.cost)
    }
    return { total, services: [...services].map(([name, cost]) => ({ name, cost })).sort((a, b) => b.cost - a.cost) }
}

/** Merges the IPC result, uptime and cost into what each row shows. */
export function assembleRowValues(
    rows: KpiRowSpec[],
    targets: Record<string, ServiceKpiTargetResult>,
    uptime: Record<string, KpiCell>,
    costCells: Record<string, KpiCell>,
): Record<string, KpiRowValues> {
    const out: Record<string, KpiRowValues> = {}
    for (const r of rows) {
        const t = targets[r.key]
        out[r.key] = {
            scope: t?.scope ?? null,
            cpu: t?.cpu,
            memory: t?.memory,
            db: t?.db ?? undefined,
            errors5xx: t?.errors5xx ?? undefined,
            uptime: uptime[r.key],
            cost: costCells[r.key],
        }
    }
    return out
}

/** Rows to tab-separated text, which Excel pastes into cells. Tabs and newlines inside a cell would break the grid, so they become spaces. */
export function toTsv(header: string[], rows: string[][]): string {
    const clean = (s: string) => s.replace(/[\t\r\n]+/g, " ")
    return [header, ...rows].map((r) => r.map(clean).join("\t")).join("\n")
}
