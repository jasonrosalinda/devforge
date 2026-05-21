import { useState, useCallback } from 'react';
import { useAzureMetrics } from '@/hooks/useAzureMetrics';
import { useSettings } from '@/context/settings-context';
import { AzureAppCard } from '@/components/azure/azureAppCard';
import { ControlBar } from '@/components/app-health-check/controlBar';
import { NotConfiguredBanner, CredErrorBanner, StatusLegend } from '@/components/app-health-check/banners';
import { C, maxEndDt, toDatetimeLocal, todayMidnight } from '@/components/app-health-check/styles';

export default function AppHealthCheckPage() {
  const { settings, loading: settingsLoading } = useSettings();
  const { credStatus, credError, metrics, loading, detailsLoading, detailsLoaded, fetchMetrics, fetchAppDetails } = useAzureMetrics();
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
  const fetchDisabled = loading || credStatus === 'error' || effectiveSelected.length === 0 || notConfigured || !startDt || !endDt;

  return (
    <div className="flex flex-col gap-4">

      {notConfigured && <NotConfiguredBanner />}
      {credStatus === 'error' && <CredErrorBanner />}

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
