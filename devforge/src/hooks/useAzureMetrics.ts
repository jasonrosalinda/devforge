import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';

type CredStatus = 'checking' | 'ok' | 'error';

interface UseAzureMetrics {
  credStatus: CredStatus;
  credError: string | null;
  metrics: Record<string, AppMetrics> | null;
  loading: boolean;
  detailsLoading: Record<string, boolean>;
  detailsLoaded: Record<string, boolean>;
  fetchMetrics: (appKeys: string[], range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => Promise<void>;
  fetchAppDetails: (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => Promise<void>;
}

export function useAzureMetrics(): UseAzureMetrics {
  const [credStatus, setCredStatus] = useState<CredStatus>('checking');
  const [credError, setCredError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, AppMetrics> | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState<Record<string, boolean>>({});
  const [detailsLoaded, setDetailsLoaded] = useState<Record<string, boolean>>({});
  const fetchIdRef = useRef(0);

  useEffect(() => {
    window.electronAPI.azureMetrics.checkCredential().then((result) => {
      if (result.ok) {
        setCredStatus('ok');
      } else {
        setCredStatus('error');
        setCredError(result.error ?? 'Authentication failed');
      }
    });
  }, []);

  // Subscribe to per-app partial results for progressive rendering
  useEffect(() => {
    const unsub = window.electronAPI.azureMetrics.onPartial?.(({ key, result }: { key: string; result: AppMetrics }) => {
      setMetrics(prev => prev ? { ...prev, [key]: result } : { [key]: result });
    });
    return unsub;
  }, []);

  const fetchMetrics = useCallback(async (appKeys: string[], range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => {
    if (credStatus === 'error') return;
    if (!appKeys.length) return;
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setMetrics({});
    setDetailsLoading({});
    setDetailsLoaded({});
    try {
      const data = await window.electronAPI.azureMetrics.fetch({ appKeys, range, config, customStart, customEnd, granularity });
      if (fetchId === fetchIdRef.current) {
        setMetrics(data);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Azure metrics fetch failed: ${msg}`);
    } finally {
      if (fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [credStatus]);

  const fetchAppDetails = useCallback(async (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => {
    if (detailsLoaded[appKey] || detailsLoading[appKey]) return;
    setDetailsLoading(prev => ({ ...prev, [appKey]: true }));
    try {
      const partial = await window.electronAPI.azureMetrics.fetchAppDetails({ appKey, range, config, customStart, customEnd, granularity });
      setMetrics(prev => {
        if (!prev?.[appKey]) return prev;
        return { ...prev, [appKey]: { ...prev[appKey], ...partial } };
      });
      setDetailsLoaded(prev => ({ ...prev, [appKey]: true }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Detail fetch failed: ${msg}`);
    } finally {
      setDetailsLoading(prev => ({ ...prev, [appKey]: false }));
    }
  }, [detailsLoaded, detailsLoading]);

  return { credStatus, credError, metrics, loading, detailsLoading, detailsLoaded, fetchMetrics, fetchAppDetails };
}
