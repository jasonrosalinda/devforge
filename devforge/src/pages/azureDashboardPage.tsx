// pages/azureDashboardPage.tsx
// Single-page layout:
//   [Dashboard URL input]  [Authenticate btn]  [Capture btn]
//   ──────────────────────────────────────────────────────────
//   Chart tiles gallery

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import AzureCharts from "@/components/azure/azureCharts";
import {
    useAzureAuth,
    useAzureCapture,
    type AzureSettings,
} from "@/hooks/useAzureCapture";
import { CircleDashed, CircleDot, CircleDotDashed, Dot } from "lucide-react";
import { useEffect, useRef } from "react";

// waitSeconds is hardcoded — not exposed in the UI
const HARDCODED_WAIT_SECONDS = 120;

// ── Predefined dashboard URLs ─────────────────────────────────────────────────
export const DASHBOARDS = [
    {
        label: 'MEDU',
        url: 'https://portal.azure.com/#@mims.com/dashboard/arm/subscriptions/044d478b-62ae-4658-a14b-ac179f55b057/resourcegroups/mpfalerts-rg/providers/microsoft.portal/dashboards/c1ab52ee-0554-4d0f-9178-68619af06c08',
    },
    {
        label: 'MSP',
        url: 'https://portal.azure.com/#@mims.com/dashboard/arm/subscriptions/044d478b-62ae-4658-a14b-ac179f55b057/resourcegroups/prdmsp-rg/providers/microsoft.portal/dashboards/c1a1ebb9-6655-4c55-a952-69e27379a693',
    },
] as const;

const DEFAULTS: AzureSettings = {
    dashboardUrl: '',
    timezone: 'Asia/Singapore',
    waitSeconds: HARDCODED_WAIT_SECONDS,
    hiDpi: true,
    headless: false,
};

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
    bg: '#07090f',
    surf: '#0d1520',
    border: '#1a2535',
    border2: '#243044',
    accent: '#3b82f6',
    green: '#22c55e',
    red: '#ef4444',
    yellow: '#f59e0b',
    cyan: '#06b6d4',
    purple: '#a78bfa',
    text: '#e2e8f0',
    muted: '#4b6280',
    dim: '#1e2d40',
} as const;

// ─── LogConsole ───────────────────────────────────────────────────────────────
function LogConsole({ logs }: { logs: string[] }) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
    }, [logs]);

    const col = (m: string): string =>
        m.startsWith('info:') ? C.green :
            m.startsWith('error:') ? C.red :
                m.startsWith('warn:') ? C.yellow :
                    C.muted;

    return (
        <div ref={ref} style={{
            background: C.bg,
            border: `1px solid ${C.border}`,
            borderRadius: 8,
            padding: '10px 14px',
            height: 140,
            overflowY: 'auto',
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.8,
        }}>
            {logs.length === 0
                ? <span style={{ color: C.dim }}>Waiting to start...</span>
                : logs.map((l, i) => <div key={i} style={{ color: col(l) }}>{l}</div>)
            }
        </div>
    );
}

// ─────────────────────────────────────────────────────────────────────────────

export default function AzureDashboardPage() {
    const [settings, setSettings] = useState<AzureSettings>(DEFAULTS);
    const [jumpTo, setJumpTo] = useState<string | null>(null);

    const {
        status: authStatus,
        logs: authLogs,
        authOk,
        saveAuth,
    } = useAzureAuth(settings);

    const {
        status: captureStatus,
        logs: captureLogs,
        tileCount,
        progress,
        capture,
    } = useAzureCapture(settings, (session) => setJumpTo(session));

    const isAuthRunning = authStatus === 'running';
    const isCaptureRunning = captureStatus === 'running';
    const isAnyRunning = isAuthRunning || isCaptureRunning;

    // Show capture logs while capturing, auth logs otherwise
    const activeLogs = isCaptureRunning || captureStatus === 'done' || captureStatus === 'error'
        ? captureLogs
        : authLogs;

    const showLog = activeLogs.length > 0 || isAnyRunning;

    return (
        <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            height: '100%',
            minHeight: 0,
            background: C.bg,
        }}>

            {/* ── Control bar ──────────────────────────────────────────────── */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: C.surf,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                padding: '12px 16px',
            }}>

                {/* Authenticate button */}
                <Button
                    onClick={saveAuth}
                    variant="outline"
                    disabled={isAnyRunning || authOk}
                    className="shrink-0"
                >
                    {authOk ? (
                        <><Dot className="mr-1 h-4 w-4 animate-pulse" color="#2cf239" strokeWidth={12} fill="currentColor" /> Authenticated</>
                    ) : isAuthRunning ? (
                        <><CircleDotDashed className="mr-1 h-4 w-4 animate-pulse" color="yellow" /> Authenticating...</>
                    ) : (
                        <><CircleDashed className="mr-1 h-4 w-4" color="red" /> Authenticate</>
                    )}
                </Button>

                {/* Dashboard URL dropdown */}
                <div style={{ flex: 1 }}>
                    <Select
                        value={settings.dashboardUrl}
                        onValueChange={(url) => setSettings(p => ({ ...p, dashboardUrl: url }))}
                        disabled={isAnyRunning}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Select a dashboard…" />
                        </SelectTrigger>
                        <SelectContent>
                            {DASHBOARDS.map(d => (
                                <SelectItem key={d.label} value={d.url}>
                                    {d.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* Capture button */}
                <Button
                    onClick={capture}
                    variant="outline"
                    disabled={isAnyRunning || !authOk || !settings.dashboardUrl}
                    className="shrink-0"
                >
                    {isCaptureRunning ? (
                        <><CircleDotDashed className="mr-1 h-4 w-4 animate-pulse" color="#031cffff" /> Capturing {progress > 0 ? `${progress}%` : ''}...</>
                    ) : captureStatus === 'done' ? (
                        <><CircleDot className="mr-1 h-4 w-4" color="#2cf239" /> Capture</>
                    ) : (
                        <><CircleDashed className="mr-1 h-4 w-4" /> Capture</>
                    )}
                </Button>

                {/* Tile count badge — shows after capture */}
                {tileCount !== null && (
                    <span style={{
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: C.cyan,
                        background: `${C.cyan}18`,
                        border: `1px solid ${C.cyan}44`,
                        borderRadius: 5,
                        padding: '3px 10px',
                        whiteSpace: 'nowrap',
                    }}>
                        {tileCount} tiles
                    </span>
                )}
            </div>

            {/* ── Log console (visible only when active) ────────────────────── */}
            {showLog && <LogConsole logs={activeLogs} />}

            {/* ── Divider ───────────────────────────────────────────────────── */}
            <div style={{ height: 1, background: C.border }} />

            {/* ── Chart tiles gallery ───────────────────────────────────────── */}
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                <AzureCharts jumpTo={jumpTo} />
            </div>
        </div>
    );
}