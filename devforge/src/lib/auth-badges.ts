import type { IElectronAPI } from "@shared/types/electron"
import type { TokenStatus } from "@/components/release-pilot/tokenStatusPill"

export type CredState = "checking" | "ok" | "error"
export type BadgeTone = "ok" | "warn" | "bad" | "idle" | "checking"

export interface AuthBadge {
    label: string
    text: string
    tone: BadgeTone
    /** Tooltip: what the state means and how to fix it. */
    hint: string
    /** Shown before the label, e.g. "12% / 34%" (Claude's session / weekly usage). */
    prefix?: string | undefined
}

type UsageResult = Awaited<ReturnType<IElectronAPI["claudeUsage"]["fetch"]>>

/** "team" → "Team"; unknown plans pass through capitalised. */
export function formatPlan(plan: string | null): string {
    if (!plan) return ""
    return plan.charAt(0).toUpperCase() + plan.slice(1)
}

export function azureBadge(status: CredState, error: string | null): AuthBadge {
    const label = "Azure"
    if (status === "checking") return { label, text: "Checking…", tone: "checking", hint: "Checking the Azure CLI sign-in" }
    if (status === "ok") return { label, text: "Signed in", tone: "ok", hint: "Azure CLI is signed in. Click to re-check." }
    return { label, text: "Not signed in", tone: "bad", hint: `${error || "Azure CLI not authenticated"} — run \`az login\`, then click to re-check.` }
}

export interface ConfluenceSession {
    connected: boolean
    connecting: boolean
}

/** Token state plus the Confluence browser session (screenshots need it, page fetches don't). */
export function atlassianBadge(s: TokenStatus, session: ConfluenceSession = { connected: true, connecting: false }): AuthBadge {
    const label = "Atlassian"
    switch (s.state) {
        case "checking": return { label, text: "Checking…", tone: "checking", hint: "Checking the Confluence API token" }
        case "no-base": return { label, text: "Not set up", tone: "idle", hint: "Add the Confluence URL in Settings → Atlassian." }
        case "missing": return { label, text: "No token", tone: "bad", hint: "No account email / API token saved in Settings → Atlassian." }
        case "valid": {
            const who = s.displayName ? ` — ${s.displayName}` : ""
            if (session.connecting) return { label, text: "Connecting…", tone: "checking", hint: "Connecting the Confluence browser session" }
            if (!session.connected) return { label, text: "Not connected", tone: "warn", hint: `API token valid${who}, but the Confluence browser session is not connected. Screenshots need it: use Connect Confluence.` }
            return { label, text: "Connected", tone: "ok", hint: `API token valid${who} and the Confluence session is connected. Click to re-check.` }
        }
        case "expired": return { label, text: "Token expired", tone: "bad", hint: "Confluence answered 401: the token expired, was revoked, or does not match the email in Settings → Atlassian." }
        case "forbidden": return { label, text: "Token rejected", tone: "bad", hint: `Confluence answered 403: the token is not allowed to read this site${s.detail ? ` (${s.detail})` : ""}.` }
        default: return { label, text: "Can't verify", tone: "warn", hint: s.detail || "Could not reach Confluence to validate the token. Click to retry." }
    }
}

/** "12% / 34%": the 5-hour session limit, then the weekly one. "–" when a window isn't reported. */
export function claudeUsagePrefix(limits: { id: string; percent: number }[]): string | undefined {
    const pct = (id: string) => {
        const l = limits.find((x) => x.id === id)
        return l ? `${Math.round(l.percent)}%` : "–"
    }
    return limits.some((l) => l.id === "session" || l.id === "weekly") ? `${pct("session")} / ${pct("weekly")}` : undefined
}

/** Claude Code's login, read from the same OAuth credential the usage probe uses. */
export function claudeBadge(result: UsageResult | null): AuthBadge {
    const label = "Claude"
    if (!result) return { label, text: "Checking…", tone: "checking", hint: "Checking the Claude Code login" }
    if (result.success) {
        const plan = formatPlan(result.plan)
        const prefix = claudeUsagePrefix(result.limits)
        return { label, prefix, text: "Signed in", tone: "ok", hint: `Claude Code is signed in${plan ? ` (${plan} plan)` : ""}${prefix ? `. Usage: ${prefix} (session / weekly)` : ""}. Click to re-check.` }
    }
    if (result.code === "NOT_SIGNED_IN") return { label, text: "Not signed in", tone: "bad", hint: "Run `claude` in a terminal and sign in, then click to re-check." }
    if (result.code === "EXPIRED") return { label, text: "Login expired", tone: "bad", hint: "Run `claude` in a terminal to refresh the login, then click to re-check." }
    // Any other failure happened after the local login was found and unexpired, so it is
    // the usage endpoint (rate limit, outage, offline) failing, not the sign-in.
    return { label, text: "Signed in", tone: "ok", hint: `Claude Code login found, but Anthropic could not confirm it: ${result.error || "request failed"}` }
}
