import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, ShieldCheck } from "lucide-react"

import type { CertResult, CertStatus } from "@shared/types/certs.types"
import { AppDropdown } from "@/components/app-health-check/appDropdown"
import { PageHeader } from "@/components/layout/page-header"
import { Button } from "@/components/ui/button"
import { Hint } from "@/components/ui/hint"
import { useSettings } from "@/context/settings-context"
import { cn } from "@/lib/utils"
import { sortCerts } from "@/monitor/certAlerts"

const STATUS_CLASS: Record<CertStatus, string> = {
    expired: "border-destructive/50 bg-destructive/10 text-destructive",
    critical: "border-destructive/40 bg-destructive/10 text-destructive",
    warning: "border-warning/50 bg-warning/10 text-warning",
    ok: "border-success/50 bg-success/10 text-success",
}

const SITE_LABEL: Record<CertResult["site"], string> = { url: "Platform URL", web: "Web app", api: "API" }

const sgt = (iso: string) =>
    new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Singapore", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })

/** TLS certificate expiry for every host of the picked apps. */
export default function CertExpiryPage() {
    const { settings } = useSettings()
    const apps = settings.azure.apps
    const allKeys = useMemo(() => apps.map((a) => a.name), [apps])
    const labels = useMemo(() => Object.fromEntries(apps.map((a) => [a.name, a.platformName || a.name])), [apps])
    const [selected, setSelected] = useState<string[]>([])
    const [rows, setRows] = useState<CertResult[] | null>(null)
    const [checkedAt, setCheckedAt] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const requestId = useRef(0)

    // Settings load after first render: start with every app picked.
    useEffect(() => { setSelected((s) => (s.length ? s.filter((k) => allKeys.includes(k)) : allKeys)) }, [allKeys])

    const run = async () => {
        const api = window.electronAPI?.certs
        if (!api) { setError("Cert & Domain Expiry needs the devForge desktop app."); return }
        const id = ++requestId.current
        setLoading(true)
        setError(null)
        try {
            const res = await api.check({ appKeys: selected, config: settings.azure })
            if (id !== requestId.current) return
            if (res.error) setError(res.error)
            setRows(sortCerts(res.results))
            setCheckedAt(res.checkedAt ?? null)
        } catch (err) {
            if (id === requestId.current) setError(err instanceof Error ? err.message : String(err))
        } finally {
            if (id === requestId.current) setLoading(false)
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <PageHeader
                icon={ShieldCheck}
                title="Cert & Domain Expiry"
                subtitle="Days left on the TLS certificate of every host your apps answer on: the platform URLs in Settings, plus the host names bound in Azure."
            />

            {apps.length === 0 ? (
                <p className="text-sm text-muted-foreground">No Azure apps configured. Add them in Settings → Azure.</p>
            ) : (
                <div className="flex flex-wrap items-center gap-3">
                    <AppDropdown selected={selected} allKeys={allKeys} onChange={setSelected} labels={labels} />
                    <Button onClick={() => void run()} disabled={loading || !selected.length}>
                        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Check certificates
                    </Button>
                    {checkedAt && <span className="text-xs text-muted-foreground">Checked {sgt(checkedAt)} SGT</span>}
                </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            {rows && (rows.length === 0 ? (
                <p className="text-sm text-muted-foreground">No hosts found. Add platform URLs in Settings → Azure, or check Reader access on the apps.</p>
            ) : (
                <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                            <tr>
                                <th className="px-3 py-2 font-medium">Host</th>
                                <th className="px-3 py-2 font-medium">App</th>
                                <th className="px-3 py-2 font-medium">Expires (SGT)</th>
                                <th className="px-3 py-2 font-medium">Days left</th>
                                <th className="px-3 py-2 font-medium">Issuer</th>
                                <th className="px-3 py-2 font-medium">Trusted</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y">
                            {rows.map((r) => {
                                const unverified = r.trust === "chain"
                                const trusted = r.error ? "—" : unverified ? "No" : r.trust === "host" ? "Wrong host" : r.status === "expired" ? "Expired" : "Yes"
                                return (
                                    <tr key={`${r.appKey}:${r.host}`}>
                                        <td className="px-3 py-1.5 font-mono text-xs break-all">{r.host}</td>
                                        <td className="px-3 py-1.5 text-xs">{labels[r.appKey] ?? r.appKey} <span className="text-muted-foreground">· {SITE_LABEL[r.site]}</span></td>
                                        <td className="px-3 py-1.5 text-xs tabular-nums">{r.validTo ? sgt(r.validTo) : "—"}</td>
                                        <td className="px-3 py-1.5 text-xs">
                                            {r.error ? (
                                                <span className="text-destructive">{r.error}</span>
                                            ) : unverified ? (
                                                <Hint label={`The certificate came from ${r.issuer || "an unknown issuer"}, which this machine doesn't trust (${r.authorizationError ?? "untrusted chain"}). A TLS-inspecting proxy often does this, so its date may not be the site's.`}>
                                                    <span className="text-warning">Can&apos;t verify from this network</span>
                                                </Hint>
                                            ) : r.status && r.daysLeft != null ? (
                                                <span className={cn("rounded border px-2 py-0.5 tabular-nums", STATUS_CLASS[r.status])}>
                                                    {r.status === "expired" ? `Expired ${-r.daysLeft}d ago` : `${r.daysLeft} days`}
                                                </span>
                                            ) : "—"}
                                        </td>
                                        <td className="px-3 py-1.5 text-xs">{r.issuer || "—"}</td>
                                        <td className="px-3 py-1.5 text-xs">
                                            {r.trust === "host" ? (
                                                <Hint label={`The certificate doesn't name ${r.host}. It covers: ${(r.sans ?? []).join(", ") || "no names"}. Browsers will show a warning.`}>
                                                    <span className="text-destructive">Doesn&apos;t cover this host</span>
                                                </Hint>
                                            ) : trusted}
                                        </td>
                                    </tr>
                                )
                            })}
                        </tbody>
                    </table>
                </div>
            ))}

            <p className="text-xs text-muted-foreground">
                Red under 14 days, amber under 30. With the background monitor on, devForge also checks once a day and alerts when a certificate drops under 14 days or expires.
            </p>
        </div>
    )
}
