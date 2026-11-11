import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppMetrics, CrashFetchResult, ReleaseFetchResult, RestartFetchResult } from '@shared/types/azureMetrics.types';
import type { InvestigationEpisode } from '@shared/types/app-investigation.types';
import type { AzureSettings } from '@/types/settings.types';
import { GRANULARITIES } from '@/components/app-health-check/styles';
import { buildExtras, detectCorrelatedAnomalies, groupAnomalyEpisodes, inferSeriesStepMs } from '@/components/azure/anomalyDetection';

/** The App Health Check data for one app and window: what the investigation charts draw. */
export interface InvestigationTelemetry {
  metrics: AppMetrics;
  releases: ReleaseFetchResult | null;
  restarts: RestartFetchResult | null;
  crashes: CrashFetchResult | null;
  granularity: string;
}

/** 1-minute buckets to drill into an incident, as far as App Health Check allows them (24h); coarser beyond. Pure. */
export function investigationGranularity(spanMs: number): string {
  const hours = spanMs / 3_600_000;
  return (GRANULARITIES.find(g => hours <= g.maxSpanHours) ?? GRANULARITIES[GRANULARITIES.length - 1]!).value;
}

/** Warning/Critical episodes from App Health Check's detector on these metrics — what the anomalies lane shows. Pure. */
export function investigationEpisodes(m: AppMetrics): InvestigationEpisode[] {
  if (!m.cpu?.series?.length) return [];
  return groupAnomalyEpisodes(detectCorrelatedAnomalies(m.cpu, buildExtras(m)), inferSeriesStepMs(m.cpu.series))
    .filter((e): e is typeof e & { peakSeverity: 'Critical' | 'Warning' } => e.peakSeverity !== 'Info')
    .map(e => ({
      startT: e.startT, endT: e.endT, peakSeverity: e.peakSeverity, bucketCount: e.bucketCount,
      metricsInvolved: e.metricsInvolved, peakValues: e.peakValues, incidentType: e.incidentType,
    }));
}

/**
 * Loads the App Health Check charts' data for an investigation window, through the same
 * calls the Health Check page makes (silent, so its cards are not repainted). `ready()`
 * resolves when the current window's data is in, or null if it failed.
 */
export default function useInvestigationTelemetry(appKey: string | undefined, config: AzureSettings, span: { startMs: number; endMs: number } | null) {
  const [data, setData] = useState<InvestigationTelemetry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<InvestigationTelemetry | null>>(Promise.resolve(null));
  const startMs = span?.startMs;
  const endMs = span?.endMs;

  useEffect(() => {
    if (!appKey || startMs == null || endMs == null || !(endMs > startMs) || !config.subscriptionId) {
      setData(null); setError(null); setLoading(false);
      pending.current = Promise.resolve(null);
      return;
    }
    let cancelled = false;
    const api = window.electronAPI.azureMetrics;
    const opts = { appKey, range: 'custom', config, customStart: new Date(startMs).toISOString(), customEnd: new Date(endMs).toISOString() };
    const granularity = investigationGranularity(endMs - startMs);
    setLoading(true); setError(null); setData(null);
    const job = (async (): Promise<InvestigationTelemetry> => {
      const [all, details, releases, restarts, crashes] = await Promise.all([
        api.fetch({ ...opts, appKeys: [appKey], granularity, silent: true }),
        api.fetchAppDetails({ ...opts, granularity }).catch(() => null),
        api.fetchReleases(opts).catch(() => null),
        api.fetchRestarts({ ...opts, granularity }).catch(() => null),
        api.fetchCrashes({ ...opts, granularity }).catch(() => null),
      ]);
      const base = (all as Record<string, AppMetrics & { error?: string }>)?.[appKey];
      const failed = (all as { _error?: string })?._error ?? base?.error;
      if (!base?.cpu?.series?.length) throw new Error(failed ?? 'Azure returned no metrics for this window.');
      return { metrics: { ...base, ...(details ?? {}) }, releases, restarts, crashes, granularity };
    })();
    pending.current = job.catch(() => null);
    job.then(
      d => { if (!cancelled) { setData(d); setLoading(false); } },
      e => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } },
    );
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- config is re-read per window, not watched
  }, [appKey, startMs, endMs, config.subscriptionId]);

  const ready = useCallback(() => pending.current, []);
  return { data, loading, error, ready };
}
