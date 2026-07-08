import { useState, useCallback } from 'react';
import { TbActivity } from 'react-icons/tb';
import { Loader2, Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAzureMetrics } from '@/hooks/useAzureMetrics';
import { useSettings } from '@/context/settings-context';
import { PageHeader } from '@/components/layout/page-header';
import { AzureAppCard } from '@/components/azure/azureAppCard';
import { ControlBar } from '@/components/app-health-check/controlBar';
import { NotConfiguredBanner, StatusLegend } from '@/components/app-health-check/banners';
import { C, maxEndDt, toDatetimeLocal, todayMidnight } from '@/components/app-health-check/styles';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

type CredStatus = 'checking' | 'ok' | 'error';

function AzureStatusPill({
    credStatus,
    credError,
    onRecheck,
}: {
    credStatus: CredStatus;
    credError: string | null;
    onRecheck: () => void;
}) {
    const copyAzLogin = () => {
        navigator.clipboard.writeText('az login');
        toast.info('Copied `az login`', { description: 'Run it in your terminal, then click "Re-check".' });
    };

    if (credStatus === 'checking') {
        return (
            <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Checking…
            </span>
        );
    }

    if (credStatus === 'ok') {
        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-full border border-green-500/60 bg-green-500/10 px-3 py-1 text-xs text-green-500 hover:bg-green-500/20 transition-colors"
                    >
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
                        Authenticated
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onRecheck}>
                        <RefreshCw className="h-3.5 w-3.5 mr-2" /> Re-check
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-card px-3 py-1 text-xs text-destructive hover:bg-accent transition-colors"
                    title={credError || 'Azure CLI not authenticated'}
                >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-destructive" />
                    Not authenticated
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
                <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    Run this in your terminal, then click Re-check:
                </div>
                <DropdownMenuItem onClick={copyAzLogin} className="font-mono text-xs">
                    <Copy className="h-3.5 w-3.5 mr-2" /> az login
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onRecheck}>
                    <RefreshCw className="h-3.5 w-3.5 mr-2" /> Re-check
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export default function AppHealthCheckPage() {
  const { settings, loading: settingsLoading } = useSettings();
  const { credStatus, credError, metrics, loading, detailsLoading, detailsLoaded, fetchMetrics, fetchAppDetails, recheckCredential } = useAzureMetrics();
  const allAppKeys = settings.azure.apps.map(a => a.name);
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [startDt, setStartDt] = useState(() => toDatetimeLocal(todayMidnight()));
  const [endDt,   setEndDt]   = useState(() => maxEndDt());
  const [granularity, setGranularity] = useState('PT5M');
  const [committedStart, setCommittedStart] = useState<string | null>(null);
  const [committedEnd,   setCommittedEnd]   = useState<string | null>(null);

  const effectiveSelected = selectedApps.length > 0
    ? selectedApps.filter(k => allAppKeys.includes(k))
    : allAppKeys;

  const handleFetch = useCallback(() => {
    const isoStart = new Date(startDt).toISOString();
    const isoEnd   = new Date(endDt).toISOString();
    setCommittedStart(isoStart);
    setCommittedEnd(isoEnd);
    fetchMetrics(effectiveSelected, 'custom', settings.azure, isoStart, isoEnd, granularity);
  }, [fetchMetrics, effectiveSelected, startDt, endDt, settings.azure, granularity]);

  const notConfigured = !settingsLoading && (!settings.azure.subscriptionId || allAppKeys.length === 0);
  const fetchDisabled = loading || credStatus !== 'ok' || effectiveSelected.length === 0 || notConfigured || !startDt || !endDt;

  return (
    <div className="flex flex-col gap-4">

      <PageHeader
        icon={TbActivity}
        title="App Health Check"
        subtitle="Pull Azure App Service metrics for selected apps and time range — CPU, memory, requests, and downtime detection."
        actions={<AzureStatusPill credStatus={credStatus} credError={credError} onRecheck={() => void recheckCredential()} />}
      />

      {notConfigured && <NotConfiguredBanner />}

      <ControlBar
        notConfigured={notConfigured}
        effectiveSelected={effectiveSelected}
        allAppKeys={allAppKeys}
        onSelectedChange={setSelectedApps}
        startDt={startDt}
        setStartDt={setStartDt}
        endDt={endDt}
        setEndDt={setEndDt}
        granularity={granularity}
        setGranularity={setGranularity}
        loading={loading}
        fetchDisabled={fetchDisabled}
        onFetch={handleFetch}
        credStatus={credStatus}
        credError={credError}
      />

      {!metrics && !loading && !notConfigured && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: C.textSub, fontSize: 14 }}>
          Select apps and time range, then click ↻ to fetch metrics.
        </div>
      )}

      {(metrics || loading) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }}>
          {effectiveSelected.map(key => {
            const m = metrics?.[key];
            const appDef = settings.azure.apps.find(a => a.name === key);
            if (!m && !loading) return null;
            return (
              <AzureAppCard
                key={key}
                appKey={key}
                azureSettings={settings.azure}
                metrics={m ?? {
                  label: appDef?.name ?? key,
                  type: appDef?.type ?? 'appservice',
                  cpu: { avg: 0, max: 0, p99: 0, series: [] },
                  memory: { avg: 0, max: 0, p99: 0, series: [] },
                  cpuUnit: '%',
                  memUnit: '%',
                }}
                loading={loading}
                detailsLoading={detailsLoading[key] ?? false}
                detailsLoaded={detailsLoaded[key] ?? false}
                onRequestDetails={() => fetchAppDetails(key, 'custom', settings.azure, committedStart ?? undefined, committedEnd ?? undefined, granularity)}
                uptimeRobotApiKey={settings.apiKeys.uptimeRobotApiKey}
                uptimeRobotMonitorIds={appDef?.uptimeRobotMonitorIds}
                ipapiIsApiKey={settings.apiKeys.ipapiIsApiKey}
                rangeStart={committedStart ?? undefined}
                rangeEnd={committedEnd ?? undefined}
              />
            );
          })}
        </div>
      )}

      <StatusLegend />

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes sparkle-glow {
          0%, 100% { filter: drop-shadow(0 0 3px #d29922); opacity: 0.7; }
          50%       { filter: drop-shadow(0 0 8px #d29922) drop-shadow(0 0 14px #d2992288); opacity: 1; }
        }
        input[type="datetime-local"]::-webkit-calendar-picker-indicator {
          filter: invert(0.6);
          cursor: pointer;
        }
      `}</style>
    </div>
  );
}
