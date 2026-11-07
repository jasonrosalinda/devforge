import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { Copy, ExternalLink, Loader2, LogIn, RefreshCw, Settings as SettingsIcon } from "lucide-react"
import { toast } from "sonner"

import type { IElectronAPI } from "@shared/types/electron"
import { cn } from "@/lib/utils"
import { atlassianBadge, azureBadge, claudeBadge, type AuthBadge, type BadgeTone, type CredState } from "@/lib/auth-badges"
import { useConfluenceConnection } from "@/hooks/useConfluenceConnection"
import { useSettings } from "@/context/settings-context"
import { useSettingsUi } from "@/context/settings-ui-context"
import { TOKEN_PAGE_URL, TokenSteps } from "@/components/release-pilot/tokenStatusPill"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

type UsageResult = Awaited<ReturnType<IElectronAPI["claudeUsage"]["fetch"]>>

const POLL_MS = 5 * 60 * 1000

const TONE_CLASS: Record<BadgeTone, string> = {
    ok: "border-success/60 bg-success/10 text-success",
    warn: "border-warning/50 bg-warning/10 text-warning",
    bad: "border-destructive/40 bg-destructive/10 text-destructive",
    idle: "border-sidebar-border text-sidebar-foreground/60",
    checking: "border-sidebar-border text-sidebar-foreground/60",
}

function useAzureAuth() {
    const [status, setStatus] = useState<CredState>("checking")
    const [error, setError] = useState<string | null>(null)
    const inFlight = useRef(false)

    const check = useCallback(async () => {
        const api = window.electronAPI?.azureMetrics
        if (!api || inFlight.current) return
        inFlight.current = true
        setStatus("checking")
        try {
            const r = await api.checkCredential()
            setStatus(r.ok ? "ok" : "error")
            setError(r.ok ? null : (r.error ?? "Authentication failed"))
        } catch (err) {
            setStatus("error")
            setError(err instanceof Error ? err.message : String(err))
        } finally {
            inFlight.current = false
        }
    }, [])

    useEffect(() => {
        void check()
        const id = setInterval(() => void check(), POLL_MS)
        return () => clearInterval(id)
    }, [check])

    return { badge: azureBadge(status, error), check }
}

function useClaudeAuth() {
    const [result, setResult] = useState<UsageResult | null>(null)

    const check = useCallback(async () => {
        const api = window.electronAPI?.claudeUsage
        if (!api) return
        try {
            setResult(await api.fetch())
        } catch (err) {
            setResult({ success: false, code: "NETWORK", error: err instanceof Error ? err.message : String(err) })
        }
    }, [])

    useEffect(() => {
        void check()
        const id = setInterval(() => void check(), POLL_MS)
        return () => clearInterval(id)
    }, [check])

    return { badge: claudeBadge(result), check }
}

interface RowAction {
    label: string
    icon: typeof Copy
    onSelect: () => void
}

function copyCommand(command: string): RowAction {
    return {
        label: `Copy \`${command}\``,
        icon: Copy,
        onSelect: () => {
            void navigator.clipboard.writeText(command)
            toast.info(`Copied \`${command}\``, { description: "Run it in your terminal, then Re-check." })
        },
    }
}

function Steps({ children }: { children: ReactNode }) {
    return <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">{children}</ol>
}

const AZURE_GUIDE = (
    <Steps>
        <li>Run <span className="font-mono text-foreground">az login</span> in your terminal.</li>
        <li>Sign in with your work account in the browser window.</li>
        <li>Come back here and click <span className="text-foreground">Re-check</span>.</li>
    </Steps>
)

const CLAUDE_GUIDE = (
    <Steps>
        <li>Run <span className="font-mono text-foreground">claude</span> in your terminal.</li>
        <li>If it asks, run <span className="font-mono text-foreground">/login</span> and finish signing in.</li>
        <li>Come back here and click <span className="text-foreground">Re-check</span>.</li>
    </Steps>
)

/** One badge; its menu carries the fix and sign-in guide (when the state needs one) and a re-check. */
function BadgeRow({ badge, actions, guide, onRecheck }: { badge: AuthBadge; actions: RowAction[]; guide?: ReactNode; onRecheck: () => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={`${badge.label}: ${badge.text}. ${badge.hint}`}
                    aria-label={`${badge.label}: ${badge.text}`}
                    className={cn(
                        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] leading-none outline-none ring-sidebar-ring transition-colors hover:brightness-110 focus-visible:ring-2",
                        TONE_CLASS[badge.tone],
                    )}
                >
                    {badge.tone === "checking" ? <Loader2 className="size-2.5 animate-spin" aria-hidden /> : <span className="size-1.5 rounded-full bg-current" aria-hidden />}
                    {badge.label}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" className={guide ? "w-80" : "w-64"}>
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{badge.label}: {badge.text}</span>
                    <br />
                    {badge.hint}
                </div>
                {guide && (
                    <>
                        <DropdownMenuSeparator />
                        <div className="px-2 py-1.5">
                            <div className="mb-1 text-xs font-medium text-foreground">How to sign in:</div>
                            {guide}
                        </div>
                        <DropdownMenuSeparator />
                    </>
                )}
                {actions.map((a) => (
                    <DropdownMenuItem key={a.label} onClick={a.onSelect}>
                        <a.icon className="mr-2 h-3.5 w-3.5" /> {a.label}
                    </DropdownMenuItem>
                ))}
                <DropdownMenuItem onClick={onRecheck}>
                    <RefreshCw className="mr-2 h-3.5 w-3.5" /> Re-check
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}

/**
 * Connection state of the three things devForge needs, at the foot of the sidebar: the Azure CLI,
 * the Confluence API token and the Claude Code login. Each is a badge named for the service and
 * colored by status; click one for its detail, sign-in guide and a re-check.
 */
export function SidebarAuthStatus() {
    const { settings } = useSettings()
    const { openSettings } = useSettingsUi()
    const azure = useAzureAuth()
    const claude = useClaudeAuth()
    const confluence = useConfluenceConnection(settings.atlassian)
    const atlassian = atlassianBadge(confluence.tokenStatus, { connected: confluence.connected, connecting: confluence.connecting })
    const { checkSession } = confluence
    const recheckAtlassian = () => { void confluence.checkToken(); void checkSession() }
    // The login window lives in another Electron window: coming back to this one is when the session may have changed.
    useEffect(() => {
        const refresh = () => void checkSession()
        window.addEventListener("focus", refresh)
        const id = setInterval(refresh, POLL_MS)
        return () => { window.removeEventListener("focus", refresh); clearInterval(id) }
    }, [checkSession])
    const needsFix = (b: AuthBadge) => b.tone === "bad"
    const atlassianActions: RowAction[] =
        atlassian.tone === "bad" || atlassian.tone === "idle"
            ? [
                  { label: "Settings → Atlassian", icon: SettingsIcon, onSelect: () => openSettings("atlassian") },
                  ...(atlassian.tone === "bad" ? [{ label: "Create API token", icon: ExternalLink, onSelect: () => window.open(TOKEN_PAGE_URL, "_blank", "noopener,noreferrer") }] : []),
              ]
            : confluence.tokenStatus.state === "valid" && !confluence.connected && !confluence.connecting
              ? [{ label: "Connect Confluence", icon: LogIn, onSelect: () => void confluence.connect() }]
              : []

    return (
        <div className="flex flex-col gap-1.5 px-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/50">Connections</span>
            <div className="flex flex-wrap gap-1.5">
                <BadgeRow badge={azure.badge} guide={needsFix(azure.badge) ? AZURE_GUIDE : undefined} actions={needsFix(azure.badge) ? [copyCommand("az login")] : []} onRecheck={() => void azure.check()} />
                <BadgeRow badge={atlassian} guide={atlassian.tone === "bad" || atlassian.tone === "idle" ? <TokenSteps compact /> : undefined} actions={atlassianActions} onRecheck={recheckAtlassian} />
                <BadgeRow badge={claude.badge} guide={needsFix(claude.badge) ? CLAUDE_GUIDE : undefined} actions={needsFix(claude.badge) ? [copyCommand("claude")] : []} onRecheck={() => void claude.check()} />
            </div>
        </div>
    )
}
