import { useMemo } from "react"
import { Activity, Settings as SettingsIcon, Telescope } from "lucide-react"

import { useSettings } from "@/context/settings-context"
import { useSettingsUi } from "@/context/settings-ui-context"
import { buildPaletteItems, PALETTE_GROUPS, PALETTE_HEALTH_WINDOW_MS, type PaletteItem } from "@/lib/command-palette"
import { requestHealthCheckReload } from "@/lib/health-check-reload"
import { loadLibrary } from "@/lib/telemetry-library"
import { requestTelemetryRun } from "@/lib/telemetry-request"
import { HEALTH_CHECK_PAGE, TELEMETRY_PAGE, findPage, pages } from "@/routes/page-routes"
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command"

function ItemIcon({ item }: { item: PaletteItem }) {
    const a = item.action
    const Icon = a.kind === "page" ? (findPage(a.title)?.icon ?? Activity)
        : a.kind === "health-check" ? Activity
        : a.kind === "telemetry-query" ? Telescope
        : SettingsIcon
    return <Icon aria-hidden />
}

/** Ctrl+K: jump to any page, an app's Health Check, a saved telemetry query or Settings. */
export function CommandPalette({ open, onOpenChange, onOpenPage }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onOpenPage: (title: string) => void
}) {
    const { settings } = useSettings()
    const { openSettings } = useSettingsUi()
    // Read the saved queries on each open, so a query saved a moment ago is listed.
    const items = useMemo(
        () => (open ? buildPaletteItems(pages, settings.azure.apps, loadLibrary()) : []),
        [open, settings.azure.apps],
    )

    const run = (item: PaletteItem) => {
        onOpenChange(false)
        const a = item.action
        switch (a.kind) {
            case "page":
                onOpenPage(a.title)
                break
            case "health-check": {
                // The request goes first so a tab that mounts from this open still picks it up.
                const now = Date.now()
                requestHealthCheckReload({ range: { startMs: now - PALETTE_HEALTH_WINDOW_MS, endMs: now }, appKeys: [a.appKey] })
                onOpenPage(HEALTH_CHECK_PAGE)
                break
            }
            case "telemetry-query":
                requestTelemetryRun({ queryId: a.queryId })
                onOpenPage(TELEMETRY_PAGE)
                break
            case "settings":
                openSettings()
                break
        }
    }

    return (
        <CommandDialog open={open} onOpenChange={onOpenChange}>
            <CommandInput placeholder="Go to a page, an app or a saved query…" />
            <CommandList className="max-h-[420px]">
                <CommandEmpty>No matches.</CommandEmpty>
                {PALETTE_GROUPS.map((group) => {
                    const list = items.filter((i) => i.group === group)
                    if (!list.length) return null
                    return (
                        <CommandGroup key={group} heading={group}>
                            {list.map((item) => (
                                <CommandItem key={item.id} value={`${item.label} ${item.id}`} keywords={item.keywords} onSelect={() => run(item)}>
                                    <ItemIcon item={item} />
                                    <span className="truncate">{item.label}</span>
                                    {item.hint && <CommandShortcut className="tracking-normal">{item.hint}</CommandShortcut>}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    )
                })}
            </CommandList>
        </CommandDialog>
    )
}
