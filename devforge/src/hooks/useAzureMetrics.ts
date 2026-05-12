import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import type { AppMetrics } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';

type CredStatus = 'checking' | 'ok' | 'error';

interface UseAzureMetrics {
  credStatus: CredStatus;
  credError: string | null;
  metrics: Record<string, AppMetrics> | null;
  loading: boolean;
  fetchMetrics: (appKeys: string[], range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => Promise<void>;
}

export function useAzureMetrics(): UseAzureMetrics {
  const [credStatus, setCredStatus] = useState<CredStatus>('checking');
  const [credError, setCredError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, AppMetrics> | null>(null);
  const [loading, setLoading] = useState(false);

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

  const fetchMetrics = useCallback(async (appKeys: string[], range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => {
    if (credStatus === 'error') return;
    if (!appKeys.length) return;
    setLoading(true);
    try {
      const data = await window.electronAPI.azureMetrics.fetch({ appKeys, range, config, customStart, customEnd, granularity });
      setMetrics(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Azure metrics fetch failed: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [credStatus]);

  return { credStatus, credError, metrics, loading, fetchMetrics };
}
