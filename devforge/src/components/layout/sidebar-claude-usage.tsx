import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"

import type { IElectronAPI } from "@shared/types/electron"
import { cn } from "@/lib/utils"
import { formatPlan, formatReset, usageErrorText, usageSeverity, type UsageSeverity } from "@/lib/claude-usage"

type UsageResult = Awaited<ReturnType<IElectronAPI["claudeUsage"]["fetch"]>>;

const POLL_MS = 5 * 60 * 1000;
// Refocusing the window refetches, but not more often than this.
const FOCUS_MIN_GAP_MS = 60 * 1000;

const BAR_CLASS: Record<UsageSeverity, string> = {
    normal: "bg-sidebar-primary",
    warning: "bg-warning",
    critical: "bg-error",
};

function useClaudeUsage() {
    const api = window.electronAPI?.claudeUsage;
    const [result, setResult] = useState<UsageResult | null>(null);
    const [loading, setLoading] = useState(false);
    const lastFetch = useRef(0);

    const refresh = useCallback(async () => {
        if (!api) return;
        lastFetch.current = Date.now();
        setLoading(true);
        try {
            setResult(await api.fetch());
        } catch (err) {
            setResult({ success: false, code: "NETWORK", error: err instanceof Error ? err.message : String(err) });
        } finally {
            setLoading(false);
        }
    }, [api]);

    useEffect(() => {
        if (!api) return;
        void refresh();
        const id = setInterval(() => void refresh(), POLL_MS);
        const onFocus = () => {
            if (Date.now() - lastFetch.current >= FOCUS_MIN_GAP_MS) void refresh();
        };
        window.addEventListener("focus", onFocus);
        return () => {
            clearInterval(id);
            window.removeEventListener("focus", onFocus);
        };
    }, [api, refresh]);

    return { available: Boolean(api), result, loading, refresh };
}

/** Re-render once a minute so the reset countdowns stay current between fetches. */
function useMinuteTick() {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 60 * 1000);
        return () => clearInterval(id);
    }, []);
    return now;
}

function LimitRow({ label, percent, resetsAt, now }: { label: string; percent: number; resetsAt: string | null; now: number }) {
    const reset = formatReset(resetsAt, now);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5 whitespace-nowrap leading-none">
                <span className="text-[11px] text-sidebar-foreground/70">{label}</span>
                <span className="text-xs font-semibold tabular-nums">{percent}%</span>
                {reset && (
                    <span
                        className="ml-auto truncate text-[11px] tabular-nums text-sidebar-foreground/60"
                        title={resetsAt ? `Resets ${new Date(resetsAt).toLocaleString()}` : undefined}
                    >
                        {reset === "now" ? "resetting" : `resets ${reset}`}
                    </span>
                )}
            </div>
            <div
                className="h-1 overflow-hidden rounded-full bg-sidebar-foreground/10"
                role="progressbar"
                aria-label={`${label} usage`}
                aria-valuenow={percent}
                aria-valuemin={0}
                aria-valuemax={100}
            >
                <div className={cn("h-full rounded-full transition-[width]", BAR_CLASS[usageSeverity(percent)])} style={{ width: `${percent}%` }} />
            </div>
        </div>
    );
}

/**
 * Claude Code plan usage (session + weekly limits, as `/usage` shows) at the foot of
 * the sidebar. Electron only; the whole block is a refresh button.
 */
export function SidebarClaudeUsage() {
    const { available, result, loading, refresh } = useClaudeUsage();
    const now = useMinuteTick();
    if (!available) return null;

    const plan = result?.success ? formatPlan(result.plan) : "";

    return (
        <button
            type="button"
            onClick={() => void refresh()}
            title={result?.success ? `Updated ${new Date(result.fetchedAt).toLocaleTimeString()} — click to refresh` : "Click to refresh"}
            className="flex w-full flex-col gap-2 rounded-md px-2 py-1.5 text-left outline-none ring-sidebar-ring hover:bg-sidebar-accent/50 focus-visible:ring-2"
        >
            <div className="flex items-center gap-1.5 leading-none">
                <span className="text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/50">Claude Code</span>
                {plan && <span className="text-[10px] text-sidebar-foreground/50">· {plan}</span>}
                <RefreshCw className={cn("ml-auto size-3 text-sidebar-foreground/40", loading && "animate-spin")} aria-hidden />
            </div>
            {result?.success
                ? result.limits.map((l) => <LimitRow key={l.id} {...l} now={now} />)
                : result && <span className="text-[11px] leading-snug text-sidebar-foreground/60">{usageErrorText(result.code)}</span>}
            {!result && <span className="text-[11px] text-sidebar-foreground/50">Loading usage…</span>}
        </button>
    );
}
