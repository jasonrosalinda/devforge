import { useState, useCallback, useMemo } from 'react';
import { TbActivity } from 'react-icons/tb';
import { Loader2, Copy, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAzureMetrics, type EndpointDepsState } from '@/hooks/useAzureMetrics';
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import { useSettings } from '@/context/settings-context';
import { PageHeader } from '@/components/layout/page-header';
import { AzureAppCard } from '@/components/azure/azureAppCard';
import { LazyMount } from '@/components/azure/lazyMount';
import { ControlBar } from '@/components/app-health-check/controlBar';
import { NotConfiguredBanner, StatusLegend } from '@/components/app-health-check/banners';
import { C, nowDt, toDatetimeLocal, todayMidnight } from '@/components/app-health-check/styles';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** One shared empty map, so a card with no dependency lookups yet keeps prop identity. */
const EMPTY_DEPS: Record<string, EndpointDepsState> = {};

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
  const { credStatus, credError, metrics, loading, detailsLoading, detailsLoaded, fetchMetrics, fetchAppDetails, snatLoading, fetchAppSnat, restartsLoading, restarts, fetchAppRestarts, crashesLoading, crashes, fetchAppCrashes, endpointDeps, fetchEndpointDeps, recheckCredential } = useAzureMetrics();
  const allAppKeys = settings.azure.apps.map(a => a.name);
  // The picker reads by platform name; the app key stays the identity used to fetch.
  const appLabels = Object.fromEntries(
    settings.azure.apps.map(a => [a.name, a.platformName || a.resourceGroup || a.name]),
  );
  const [selectedApps, setSelectedApps] = useState<string[]>([]);
  const [startDt, setStartDt] = useState(() => toDatetimeLocal(todayMidnight()));
  const [endDt,   setEndDt]   = useState(() => nowDt());
  const [granularity, setGranularity] = useState('PT5M');
  const [committedStart, setCommittedStart] = useState<string | null>(null);
  const [committedEnd,   setCommittedEnd]   = useState<string | null>(null);

  const effectiveSelected = selectedApps.length > 0
    ? selectedApps.filter(k => allAppKeys.includes(k))
    : allAppKeys;

  // Per-card props, memoized together.
  //
  // Every card is memoized, which only helps if its props hold their identity — an inline
  // arrow or an inline `{}` fallback would make each card re-render whenever ANY app's
  // async state landed. Rebuilt only when something a callback closes over actually
  // changes; a new time range SHOULD produce new callbacks.
  const cardProps = useMemo(() => {
    const out: Record<string, {
      metrics: AppMetrics;
      onRequestDetails: () => void;
      onRequestSnat: () => void;
      onRequestRestarts: () => void;
      onRequestCrashes: () => void;
      onRequestEndpointDeps: (site: 'fe' | 'api', endpoint: string) => void;
    }> = {};
    for (const key of effectiveSelected) {
      const appDef = settings.azure.apps.find(a => a.name === key);
      out[key] = {
        // Placeholder for a card whose metrics have not arrived. Held here so it keeps one
        // identity — built inline it was a fresh object on every render.
        metrics: {
          label: appDef?.name ?? key,
          type: appDef?.type ?? 'appservice',
          cpu: { avg: 0, max: 0, p99: 0, series: [] },
          memory: { avg: 0, max: 0, p99: 0, series: [] },
          cpuUnit: '%',
          memUnit: '%',
        },
        onRequestDetails: () => fetchAppDetails(key, 'custom', settings.azure, committedStart ?? undefined, committedEnd ?? undefined, granularity),
        onRequestSnat: () => fetchAppSnat(key, 'custom', settings.azure, committedStart ?? undefined, committedEnd ?? undefined, granularity),
        onRequestRestarts: () => fetchAppRestarts(key, 'custom', settings.azure, committedStart ?? undefined, committedEnd ?? undefined, granularity),
        onRequestCrashes: () => fetchAppCrashes(key, 'custom', settings.azure, committedStart ?? undefined, committedEnd ?? undefined, granularity),
        onRequestEndpointDeps: (site: 'fe' | 'api', endpoint: string) => fetchEndpointDeps(key, site, endpoint, 'custom', settings.azure, committedStart ?? undefined, committedEnd ?? undefined),
      };
    }
    return out;
  }, [effectiveSelected, settings.azure, committedStart, committedEnd, granularity,
      fetchAppDetails, fetchAppSnat, fetchAppRestarts, fetchAppCrashes, fetchEndpointDeps]);

  // The hook keys dependency lookups by `appKey|site|endpoint` so one flat map covers every
  // card. Each card only addresses its own, so the appKey prefix is stripped here rather
  // than every card being handed the whole map and told to filter it.
  const cardEndpointDeps = useMemo(() => {
    const out: Record<string, Record<string, EndpointDepsState>> = {};
    for (const [key, state] of Object.entries(endpointDeps)) {
      const cut = key.indexOf('|');
      if (cut < 0) continue;
      const appKey = key.slice(0, cut);
      (out[appKey] ??= {})[key.slice(cut + 1)] = state;
    }
    return out;
  }, [endpointDeps]);

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
        appLabels={appLabels}
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
            const props = cardProps[key];
            if ((!m && !loading) || !props) return null;
            return (
              // Two layers, because they solve different halves of the same problem.
              // LazyMount keeps an off-screen card out of the React tree entirely, so its
              // recharts SVG and per-chart ResizeObservers are never built. content-
              // visibility then lets the browser skip layout and paint for a card that HAS
              // been mounted but has scrolled back off; `auto` on contain-intrinsic-size
              // makes it remember the real height, so the scrollbar does not jump.
              <LazyMount key={key} minHeight={700}>
              <div style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 700px' }}>
                <AzureAppCard
                  appKey={key}
                  azureSettings={settings.azure}
                  metrics={m ?? props.metrics}
                  loading={loading}
                  detailsLoading={detailsLoading[key] ?? false}
                  detailsLoaded={detailsLoaded[key] ?? false}
                  onRequestDetails={props.onRequestDetails}
                  snatLoading={snatLoading[key] ?? false}
                  onRequestSnat={props.onRequestSnat}
                  restartsLoading={restartsLoading[key] ?? false}
                  restarts={restarts[key]?.fe ?? null}
                  apiRestarts={restarts[key]?.api ?? null}
                  crashesLoading={crashesLoading[key] ?? false}
                  crashes={crashes[key]?.fe ?? null}
                  apiCrashes={crashes[key]?.api ?? null}
                  endpointDeps={cardEndpointDeps[key] ?? EMPTY_DEPS}
                  onRequestEndpointDeps={props.onRequestEndpointDeps}
                  onRequestRestarts={props.onRequestRestarts}
                  onRequestCrashes={props.onRequestCrashes}
                  uptimeRobotApiKey={settings.apiKeys.uptimeRobotApiKey}
                  uptimeRobotMonitorIds={appDef?.uptimeRobotMonitorIds}
                  rangeStart={committedStart ?? undefined}
                  rangeEnd={committedEnd ?? undefined}
                />
              </div>
              </LazyMount>
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
