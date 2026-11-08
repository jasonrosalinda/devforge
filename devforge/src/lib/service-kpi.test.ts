import { describe, expect, it } from "vitest"
import type { AzureAppEntry } from "@/types/settings.types"
import {
    assembleRowValues, averageUptime, buildKpiRows, combineGroups, currentMonthSgt, formatKpi, formatMoney, formatWindowLabel,
    kpiWindow, monthLabel, previousMonthSgt, rgCostCells, rowCopyValues, targetKey, toTsv,
} from "./service-kpi"

describe("month helpers", () => {
    it("reads the current month in SGT, so 1 Nov 01:00 SGT is already November", () => {
        expect(currentMonthSgt(new Date("2026-10-31T17:00:00Z"))).toEqual({ year: 2026, month: 10 })
        expect(currentMonthSgt(new Date("2026-10-31T15:59:59Z"))).toEqual({ year: 2026, month: 9 })
    })

    it("rolls January back to the previous December", () => {
        expect(previousMonthSgt(new Date("2026-01-15T00:00:00Z"))).toEqual({ year: 2025, month: 11 })
        expect(previousMonthSgt(new Date("2026-11-09T00:00:00Z"))).toEqual({ year: 2026, month: 9 })
    })

    it("builds the SGT metric window and the UTC cost window", () => {
        expect(kpiWindow({ year: 2024, month: 2 })).toEqual({
            startIso: "2024-02-29T16:00:00.000Z",
            endIso: "2024-03-31T16:00:00.000Z",
            costFrom: "2024-03-01T00:00:00.000Z",
            costTo: "2024-03-31T23:59:59.000Z",
        })
    })

    it("rolls December into the next year", () => {
        const w = kpiWindow({ year: 2025, month: 11 })
        expect(w.endIso).toBe("2025-12-31T16:00:00.000Z")
        expect(w.costTo).toBe("2025-12-31T23:59:59.000Z")
    })

    it("labels the window the way the runbook words it, with leap-year February", () => {
        expect(formatWindowLabel({ year: 2024, month: 2 })).toBe("01 Mar 2024 12:00:00 AM to 31 Mar 2024 11:59:59 PM (UTC+08)")
        expect(formatWindowLabel({ year: 2024, month: 1 })).toContain("to 29 Feb 2024")
        expect(formatWindowLabel({ year: 2026, month: 1 })).toContain("to 28 Feb 2026")
        expect(monthLabel({ year: 2026, month: 9 })).toBe("Oct 2026")
    })
})

describe("formatting", () => {
    it("rounds to the given places and shows a dash for nothing", () => {
        expect(formatKpi(0.9514)).toBe("0.95")
        expect(formatKpi(99.94, 1)).toBe("99.9")
        expect(formatKpi(313, 0)).toBe("313")
        expect(formatKpi(null)).toBe("-")
        expect(formatKpi(undefined)).toBe("-")
        expect(formatKpi(Number.NaN)).toBe("-")
        expect(formatMoney(12321.3005)).toBe("12,321.30")
    })

    it("averages UptimeRobot ranges, skipping unparsable ones", () => {
        expect(averageUptime(["99.9", "100.000"])).toBeCloseTo(99.95)
        expect(averageUptime([undefined, "n/a", "98"])).toBe(98)
        expect(averageUptime([])).toBeNull()
    })

    it("writes tab-separated text with tabs and newlines in cells flattened", () => {
        expect(toTsv(["A", "B"], [["x\ty", "1\n2"]])).toBe("A\tB\nx y\t1 2")
    })
})

const APPS: AzureAppEntry[] = [
    { type: "appservice", resourceGroup: "RG", name: "web", platformName: "MIMS X", apiName: "api", apiType: "containerapp", uptimeRobotMonitorIds: ["1", "2"] },
    { type: "containerapp", resourceGroup: "rg", name: "svc" },
]

describe("buildKpiRows", () => {
    it("makes a web row per app and an API row when one is named", () => {
        const rows = buildKpiRows(APPS)
        expect(rows.map((r) => [r.key, r.label, r.resourceName, r.type])).toEqual([
            ["web::web", "MIMS X", "web", "appservice"],
            ["web::api", "MIMS X API", "api", "containerapp"],
            ["svc::web", "svc", "svc", "containerapp"],
        ])
        expect(rows[0]!.uptimeMonitorIds).toEqual(["1", "2"])
        expect(rows[1]!.uptimeMonitorIds).toEqual([])
        expect(targetKey({ appName: "a", site: "api" })).toBe("a::api")
    })
})

describe("combineGroups", () => {
    const groups = [
        { name: "prdmedu-rg", cost: 60, services: [{ name: "Azure App Service", cost: 40 }, { name: "SQL Database", cost: 20 }] },
        { name: "uatmedu-rg", cost: 25, services: [{ name: "Azure App Service", cost: 25 }] },
        { name: "other-rg", cost: 999, services: [{ name: "Redis Cache", cost: 999 }] },
    ]

    it("adds up the ticked groups (case-insensitive keys) with a combined per-service split, largest first", () => {
        expect(combineGroups(groups, new Set(["prdmedu-rg", "uatmedu-rg"]))).toEqual({
            total: 85,
            services: [{ name: "Azure App Service", cost: 65 }, { name: "SQL Database", cost: 20 }],
        })
    })

    it("is empty when nothing is ticked", () => {
        expect(combineGroups(groups, new Set())).toEqual({ total: 0, services: [] })
    })
})

describe("rgCostCells / assembleRowValues", () => {
    const rows = buildKpiRows(APPS)
    const cost = {
        ok: true as const, currency: "USD", total: 10,
        byService: [], byResourceGroup: [{ name: "RG", cost: 7.5, services: [] }],
    }

    it("gives each row its group's cost, zero for a group with no charges, and says when a group is shared", () => {
        const { cells, hints } = rgCostCells(rows, cost)
        expect(cells["web::web"]).toEqual({ value: 7.5 })
        expect(cells["svc::web"]).toEqual({ value: 7.5 }) // "rg" matches "RG"
        expect(hints["web::web"]).toBe("Whole resource group RG, shared by 3 rows")
        const solo = rgCostCells([rows[2]!], { ...cost, byResourceGroup: [] })
        expect(solo.cells["svc::web"]).toEqual({ value: 0 })
        expect(solo.hints["svc::web"]).toBe("Whole resource group rg")
    })

    it("puts the cost error on every row when cost failed", () => {
        const { cells, hints } = rgCostCells(rows, { ok: false, error: "No access" })
        expect(cells["web::api"]).toEqual({ value: null, error: "No access" })
        expect(hints).toEqual({})
    })

    it("merges target figures, uptime and cost; absent figures stay undefined", () => {
        const values = assembleRowValues(
            rows,
            { "web::web": { scope: "Plan p", cpu: { value: 1.234 }, memory: { value: 50 }, db: null, errors5xx: { value: 3 } } },
            { "web::web": { value: 99.94 } },
            { "web::web": { value: 7.5 } },
        )
        expect(values["web::web"]).toMatchObject({ scope: "Plan p", db: undefined, uptime: { value: 99.94 } })
        expect(values["svc::web"]).toMatchObject({ scope: null, cpu: undefined })
        expect(rowCopyValues(values["web::web"])).toEqual(["1.23", "50.00", "-", "3", "99.9", "7.50"])
        expect(rowCopyValues(undefined)).toEqual(["-", "-", "-", "-", "-", "-"])
    })
})
