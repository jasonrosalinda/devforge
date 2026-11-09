import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeftRight, GitCompareArrows, Loader2 } from "lucide-react"

import type { ConfigDiffResult, ConfigDiffStatus } from "@shared/types/azureConfig.types"
import { PageHeader } from "@/components/layout/page-header"
import { CopyButton } from "@/components/toolbox/toolbox-shared"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useSettings } from "@/context/settings-context"
import { configSites, countByStatus, diffToTsv, sortDiffRows, STATUS_LABEL, type ConfigSiteOption } from "@/lib/config-diff"
import { cn } from "@/lib/utils"

interface SideState { siteKey: string; slot: string; slots: string[]; slotsError?: string | undefined }

const STATUS_CLASS: Record<ConfigDiffStatus, string> = {
    "only-left": "border-warning/50 bg-warning/10 text-warning",
    "only-right": "border-warning/50 bg-warning/10 text-warning",
    differs: "border-destructive/40 bg-destructive/10 text-destructive",
    same: "border-border text-muted-foreground",
}

type Filter = "all" | ConfigDiffStatus

const initialSide = (key = ""): SideState => ({ siteKey: key, slot: "production", slots: ["production"] })

/** Loads a side's deployment slots whenever its site changes. */
function useSlotList(site: ConfigSiteOption | undefined, config: unknown, set: (fn: (s: SideState) => SideState) => void) {
    const configRef = useRef(config)
    useEffect(() => { configRef.current = config })
    const siteKey = site?.key
    useEffect(() => {
        const api = window.electronAPI?.azureConfig
        if (!site || !api) return
        let live = true
        api.slots({ appKey: site.appKey, site: site.site, config: configRef.current })
            .then((r) => {
                if (!live) return
                set((s) => (s.siteKey === site.key
                    ? { ...s, slots: r.slots, slotsError: r.error, slot: r.slots.includes(s.slot) ? s.slot : "production" }
                    : s))
            })
            .catch(() => { /* keeps production only */ })
        return () => { live = false }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the site changes
    }, [siteKey])
}

function SidePicker({ label, sites, side, onSite, onSlot }: {
    label: string
    sites: ConfigSiteOption[]
    side: SideState
    onSite: (key: string) => void
    onSlot: (slot: string) => void
}) {
    return (
        <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            {label}
            <div className="flex gap-2">
                <Select value={side.siteKey} onValueChange={onSite}>
                    <SelectTrigger className="w-64" aria-label={`${label} site`}><SelectValue placeholder="Pick a site" /></SelectTrigger>
                    <SelectContent>
                        {sites.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                <Select value={side.slot} onValueChange={onSlot}>
                    <SelectTrigger className="w-40" aria-label={`${label} slot`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                        {side.slots.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                    </SelectContent>
                </Select>
            </div>
            {side.slotsError && <span className="text-warning">{side.slotsError}</span>}
        </div>
    )
}

/** Compare app setting and connection string names (never values) between two App Service sites or slots. */
export default function ConfigDiffPage() {
    const { settings } = useSettings()
    const sites = useMemo(() => configSites(settings.azure.apps), [settings.azure.apps])
    const [left, setLeft] = useState<SideState>(() => initialSide())
    const [right, setRight] = useState<SideState>(() => initialSide())
    const [result, setResult] = useState<ConfigDiffResult | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [filter, setFilter] = useState<Filter>("all")
    const requestId = useRef(0)

    // Settings load after first render: default both sides to the first site once they arrive.
    useEffect(() => {
        if (!sites.length) return
        setLeft((s) => (sites.some((x) => x.key === s.siteKey) ? s : initialSide(sites[0]!.key)))
        setRight((s) => (sites.some((x) => x.key === s.siteKey) ? s : initialSide(sites[0]!.key)))
    }, [sites])

    const siteOf = (key: string) => sites.find((s) => s.key === key)
    useSlotList(siteOf(left.siteKey), settings.azure, setLeft)
    useSlotList(siteOf(right.siteKey), settings.azure, setRight)

    const sideLabel = (s: SideState) => `${siteOf(s.siteKey)?.label ?? "?"} / ${s.slot}`
    const same = left.siteKey === right.siteKey && left.slot === right.slot

    const compare = async () => {
        const api = window.electronAPI?.azureConfig
        if (!api) { setError("Config Diff needs the devForge desktop app."); return }
        const l = siteOf(left.siteKey)
        const r = siteOf(right.siteKey)
        if (!l || !r) return
        const id = ++requestId.current
        setLoading(true)
        setError(null)
        try {
            const res = await api.diff({
                left: { appKey: l.appKey, site: l.site, slot: left.slot },
                right: { appKey: r.appKey, site: r.site, slot: right.slot },
                config: settings.azure,
            })
            if (id === requestId.current) { setResult(res); setFilter("all") }
        } catch (err) {
            if (id === requestId.current) setError(err instanceof Error ? err.message : String(err))
        } finally {
            if (id === requestId.current) setLoading(false)
        }
    }

    const swap = () => { setLeft(right); setRight(left); setResult(null) }

    const rows = useMemo(() => sortDiffRows(result?.rows ?? []), [result])
    const counts = countByStatus(rows)
    const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter)
    const statusText = (s: ConfigDiffStatus) =>
        s === "only-left" ? `Only in ${sideLabel(left)}` : s === "only-right" ? `Only in ${sideLabel(right)}` : STATUS_LABEL[s]

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={GitCompareArrows}
                title="Config Diff"
                subtitle="Compare the app settings and connection strings of two App Service sites or slots before a swap or release. Names only: values are compared on this machine and never shown."
            />

            {sites.length === 0 ? (
                <p className="text-sm text-muted-foreground">No App Service apps configured. Add them in Settings → Azure.</p>
            ) : (
                <div className="flex flex-wrap items-end gap-3">
                    <SidePicker label="Left" sites={sites} side={left} onSite={(k) => setLeft(initialSide(k))} onSlot={(slot) => setLeft((s) => ({ ...s, slot }))} />
                    <Button variant="ghost" size="icon" onClick={swap} aria-label="Swap left and right"><ArrowLeftRight className="h-4 w-4" /></Button>
                    <SidePicker label="Right" sites={sites} side={right} onSite={(k) => setRight(initialSide(k))} onSlot={(slot) => setRight((s) => ({ ...s, slot }))} />
                    <Button onClick={() => void compare()} disabled={loading || same || !left.siteKey || !right.siteKey}>
                        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Compare
                    </Button>
                    {same && <span className="text-xs text-muted-foreground">Pick two different sites or slots.</span>}
                </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {result?.errors.left && <p className="text-sm text-destructive">Left: {result.errors.left}</p>}
            {result?.errors.right && <p className="text-sm text-destructive">Right: {result.errors.right}</p>}

            {result && rows.length > 0 && (
                <>
                    <div className="flex flex-wrap items-center gap-2">
                        {(["all", "only-left", "only-right", "differs", "same"] as const).map((f) => (
                            <Button key={f} size="sm" variant={filter === f ? "secondary" : "outline"} className="h-7 text-xs" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                                {f === "all" ? `All (${rows.length})` : `${STATUS_LABEL[f]} (${counts[f]})`}
                            </Button>
                        ))}
                        <div className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
                            Copy
                            <CopyButton value={diffToTsv(shown, sideLabel(left), sideLabel(right))} label="Copy names and statuses (tab-separated, pastes into Excel or Teams)" />
                        </div>
                    </div>
                    <div className="rounded-md border divide-y text-sm">
                        {shown.map((r) => (
                            <div key={`${r.kind}:${r.name}`} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                                <span className="font-mono text-xs break-all">{r.name}</span>
                                {r.kind === "connstr" && <Badge variant="outline" className="font-normal">connection string{r.type ? ` · ${r.type}` : ""}</Badge>}
                                {r.sticky && <Badge variant="outline" className="font-normal">slot setting</Badge>}
                                <span className={cn("ml-auto rounded border px-2 py-0.5 text-xs", STATUS_CLASS[r.status])}>{statusText(r.status)}</span>
                            </div>
                        ))}
                        {shown.length === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">Nothing in this filter.</p>}
                    </div>
                </>
            )}
            {result && !rows.length && !result.errors.left && !result.errors.right && (
                <p className="text-sm text-muted-foreground">Neither side has any app settings or connection strings.</p>
            )}

            <p className="text-xs text-muted-foreground">
                Reading settings needs the config/list action (Website Contributor or higher) on each site&apos;s resource group; Reader is not enough.
                A slot setting (sticky) stays with its slot on a swap.
            </p>
        </div>
    )
}
