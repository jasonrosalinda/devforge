export type UsageSeverity = "normal" | "warning" | "critical";

/** Same bands Claude Code uses for its own usage warnings. */
export function usageSeverity(percent: number): UsageSeverity {
    if (percent >= 90) return "critical";
    if (percent >= 70) return "warning";
    return "normal";
}

/**
 * When a limit window resets, short enough for the sidebar: a countdown inside the
 * next day ("2h 20m", "35m", "now"), else weekday + local time ("Thu 04:00 AM").
 */
export function formatReset(resetsAt: string | null, now: number = Date.now()): string {
    if (!resetsAt) return "";
    const at = Date.parse(resetsAt);
    if (Number.isNaN(at)) return "";
    const mins = Math.ceil((at - now) / 60000);
    if (mins <= 0) return "now";
    if (mins < 60) return `${mins}m`;
    if (mins < 24 * 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
    // The endpoint reports resets a few seconds either side of the minute (19:59:59).
    const rounded = new Date(Math.round(at / 60000) * 60000);
    return rounded.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** "team" → "Team"; unknown plans pass through capitalised. */
export function formatPlan(plan: string | null): string {
    if (!plan) return "";
    return plan.charAt(0).toUpperCase() + plan.slice(1);
}

const ERROR_TEXT: Record<string, string> = {
    NOT_SIGNED_IN: "Sign in to Claude Code to see usage",
    EXPIRED: "Login expired — run claude to refresh",
};

/** One line for the sidebar when usage can't be shown. */
export function usageErrorText(code: string): string {
    return ERROR_TEXT[code] ?? "Usage unavailable — click to retry";
}
