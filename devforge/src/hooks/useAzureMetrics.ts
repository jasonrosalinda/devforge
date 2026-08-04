import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import type { AppMetrics, EndpointDependency, EndpointPerfPoint, RestartResult } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';

type CredStatus = 'checking' | 'ok' | 'error';

/** One endpoint's dependency fetch. `deps` stays undefined until an answer arrives, so
 *  the panel can tell "in flight" from "answered with nothing". */
/** One endpoint's on-demand detail: its own timeline plus its downstream calls. */
export interface EndpointDepsState {
  loading: boolean;
  /** The endpoint's request timeline — what the Performance chart draws. */
  series?: EndpointPerfPoint[];
  deps?: EndpointDependency[];
  /** Bin width behind every timeline here, for the chart caption. */
  bin?: string | null | undefined;
  error?: string;
}

/** Same key the panel asks with — the site matters because FE and API are separate App
 *  Insights resources that can both serve an endpoint of the same name. */
export const endpointDepsKey = (appKey: string, site: 'fe' | 'api', endpoint: string) =>
  `${appKey}|${site}|${endpoint}`;

interface UseAzureMetrics {
  credStatus: CredStatus;
  credError: string | null;
  metrics: Record<string, AppMetrics> | null;
  loading: boolean;
  detailsLoading: Record<string, boolean>;
  detailsLoaded: Record<string, boolean>;
  fetchMetrics: (appKeys: string[], range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => Promise<void>;
  fetchAppDetails: (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => Promise<void>;
  snatLoading: Record<string, boolean>;
  snatLoaded: Record<string, boolean>;
  fetchAppSnat: (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => Promise<void>;
  restartsLoading: Record<string, boolean>;
  /** Restart detector results per app. Kept out of `metrics` — see fetchAppRestarts. */
  restarts: Record<string, { fe: RestartResult | null; api: RestartResult | null }>;
  /** Per-endpoint dependency lookups, keyed by `${appKey}|${site}|${endpoint}`. */
  endpointDeps: Record<string, EndpointDepsState>;
  fetchEndpointDeps: (appKey: string, site: 'fe' | 'api', endpoint: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string) => Promise<void>;
  fetchAppRestarts: (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => Promise<void>;
  recheckCredential: () => Promise<void>;
}

export function useAzureMetrics(): UseAzureMetrics {
  const [credStatus, setCredStatus] = useState<CredStatus>('checking');
  const [credError, setCredError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Record<string, AppMetrics> | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState<Record<string, boolean>>({});
  const [detailsLoaded, setDetailsLoaded] = useState<Record<string, boolean>>({});
  const [snatLoading, setSnatLoading] = useState<Record<string, boolean>>({});
  const [snatLoaded, setSnatLoaded] = useState<Record<string, boolean>>({});
  const [restartsLoading, setRestartsLoading] = useState<Record<string, boolean>>({});
  const [restarts, setRestarts] = useState<Record<string, { fe: RestartResult | null; api: RestartResult | null }>>({});
  // Guard in a ref, not in `restartsLoaded`: fetchMetrics fires this for every app as
  // soon as the metrics land, and a state-based guard would leave fetchAppRestarts with
  // a changing identity, so fetchMetrics could not depend on it without re-creating
  // itself on every restart result.
  const restartsRequested = useRef<Set<string>>(new Set());
  // Same reason as restartsRequested: guarding on state would give every fetcher a new
  // identity on each result, which re-renders every memoized card on the page.
  const detailsRequested = useRef<Set<string>>(new Set());
  const snatRequested = useRef<Set<string>>(new Set());
  const [endpointDeps, setEndpointDeps] = useState<Record<string, EndpointDepsState>>({});
  const fetchIdRef = useRef(0);

  const credCheckInFlight = useRef(false);
  const recheckCredential = useCallback(async () => {
    if (credCheckInFlight.current) return;
    credCheckInFlight.current = true;
    setCredStatus('checking');
    setCredError(null);
    try {
      const result = await window.electronAPI.azureMetrics.checkCredential();
      if (result.ok) {
        setCredStatus('ok');
      } else {
        setCredStatus('error');
        setCredError(result.error ?? 'Authentication failed');
      }
    } catch (err: unknown) {
      setCredStatus('error');
      setCredError(err instanceof Error ? err.message : String(err));
    } finally {
      credCheckInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void recheckCredential();
  }, [recheckCredential]);

  // Subscribe to per-app partial results for progressive rendering
  useEffect(() => {
    const unsub = window.electronAPI.azureMetrics.onPartial?.(({ key, result }: { key: string; result: AppMetrics }) => {
      setMetrics(prev => prev ? { ...prev, [key]: result } : { [key]: result });
    });
    return unsub;
  }, []);

  // Unlike SNAT, this is NOT deferred to the section opening: the restart summary is a
  // headline figure — the process died N times — and a row that reads '—' until clicked
  // cannot be scanned. fetchMetrics fires it for every app as the metrics land.
  //
  // There is no cheaper summary-only call to make: the detector returns the timeline, the
  // per-cause totals and the written findings in one payload, and restartTotals derives
  // the summary from that same object. So the round trip is eager and the *rendering* of
  // the detail is what stays lazy.
  const fetchAppRestarts = useCallback(async (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => {
    if (restartsRequested.current.has(appKey)) return;
    restartsRequested.current.add(appKey);
    setRestartsLoading(prev => ({ ...prev, [appKey]: true }));
    try {
      const { fe, api } = await window.electronAPI.azureMetrics.fetchRestarts({ appKey, range, config, customStart, customEnd, granularity });
      // Its own map, not grafted onto `metrics`. The graft bailed out when the app key was
      // not in `metrics` yet — and since this fires immediately after setMetrics(data), a
      // cached result could resolve before that commit and be discarded for good, which is
      // why the row read '—' on a warm cache but filled in on a cold one.
      setRestarts(prev => ({ ...prev, [appKey]: { fe: fe ?? null, api: api ?? null } }));
    } catch (err: unknown) {
      // Cleared so a retry is possible — unlike a successful empty result, a thrown
      // fetch says nothing about whether the detector exists.
      restartsRequested.current.delete(appKey);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Restart fetch failed: ${msg}`);
    } finally {
      setRestartsLoading(prev => ({ ...prev, [appKey]: false }));
    }
  }, []);

  const fetchAppDetails = useCallback(async (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => {
    if (detailsRequested.current.has(appKey)) return;
    detailsRequested.current.add(appKey);
    setDetailsLoading(prev => ({ ...prev, [appKey]: true }));
    try {
      const partial = await window.electronAPI.azureMetrics.fetchAppDetails({ appKey, range, config, customStart, customEnd, granularity });
      setMetrics(prev => {
        if (!prev?.[appKey]) return prev;
        return { ...prev, [appKey]: { ...prev[appKey], ...partial } };
      });
      setDetailsLoaded(prev => ({ ...prev, [appKey]: true }));
    } catch (err: unknown) {
      // Cleared so expanding again retries — a thrown fetch says nothing about the data.
      detailsRequested.current.delete(appKey);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Detail fetch failed: ${msg}`);
    } finally {
      setDetailsLoading(prev => ({ ...prev, [appKey]: false }));
    }
  }, []);

  const fetchMetrics = useCallback(async (appKeys: string[], range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => {
    if (credStatus === 'error') return;
    if (!appKeys.length) return;
    const fetchId = ++fetchIdRef.current;
    setLoading(true);
    setMetrics({});
    setDetailsLoading({});
    setDetailsLoaded({});
    setSnatLoading({});
    setSnatLoaded({});
    setRestartsLoading({});
    setRestarts({});
    restartsRequested.current.clear();
    detailsRequested.current.clear();
    snatRequested.current.clear();
    setEndpointDeps({});
    try {
      const data = await window.electronAPI.azureMetrics.fetch({ appKeys, range, config, customStart, customEnd, granularity });
      if (fetchId === fetchIdRef.current) {
        setMetrics(data);
        // Restart summaries load with the card rather than on expand — see
        // fetchAppRestarts. Not awaited: a slow or missing detector must not hold up
        // everything else, and each row renders 'loading…' until its own result lands.
        // Restart summaries AND the App Insights details load with the card rather than on
        // expand. Performance and Users are the two rows a reader scans first, and a row
        // reading '—' until clicked cannot be scanned — the same reasoning as restarts.
        // Neither is awaited: each row renders its skeleton until its own result lands.
        for (const key of appKeys) {
          void fetchAppRestarts(key, range, config, customStart, customEnd, granularity);
          void fetchAppDetails(key, range, config, customStart, customEnd, granularity);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Azure metrics fetch failed: ${msg}`);
    } finally {
      if (fetchId === fetchIdRef.current) {
        setLoading(false);
      }
    }
  }, [credStatus, fetchAppRestarts, fetchAppDetails]);

  // Per endpoint and on demand: only one endpoint is charted at a time, so fetching every
  // endpoint's calls to render one was most of the work wasted. Stable ([] deps) because
  // the guard reads the current state inside the setter rather than closing over it.
  const fetchEndpointDeps = useCallback(async (appKey: string, site: 'fe' | 'api', endpoint: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string) => {
    const key = endpointDepsKey(appKey, site, endpoint);
    let alreadyAsked = false;
    setEndpointDeps(prev => {
      const cur = prev[key];
      // An answered entry is kept, including one that answered with nothing — refetching
      // an endpoint that genuinely calls nothing on every re-select is pure waste.
      if (cur && (cur.loading || cur.deps !== undefined)) { alreadyAsked = true; return prev; }
      return { ...prev, [key]: { loading: true } };
    });
    if (alreadyAsked) return;

    try {
      const { series, deps, bin, error } = await window.electronAPI.azureMetrics.fetchEndpointDetail({ appKey, endpoint, site, range, config, customStart, customEnd });
      setEndpointDeps(prev => ({
        ...prev,
        // A failure leaves `deps` undefined and records the error, so expanding again can
        // retry — unlike an empty array, an error says nothing about what the endpoint calls.
        [key]: error || !deps ? { loading: false, error: error ?? 'No endpoint detail' } : { loading: false, series: series ?? [], deps, bin },
      }));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setEndpointDeps(prev => ({ ...prev, [key]: { loading: false, error: msg } }));
    }
  }, []);


  // SNAT charts come from the App Service detector API, which is slow enough to
  // keep out of the details fetch — the card asks for them when the section opens.
  const fetchAppSnat = useCallback(async (appKey: string, range: string, config: AzureSettings, customStart?: string, customEnd?: string, granularity?: string) => {
    if (snatRequested.current.has(appKey)) return;
    snatRequested.current.add(appKey);
    setSnatLoading(prev => ({ ...prev, [appKey]: true }));
    try {
      const { fe, api } = await window.electronAPI.azureMetrics.fetchSnat({ appKey, range, config, customStart, customEnd, granularity });
      setMetrics(prev => {
        if (!prev?.[appKey]) return prev;
        return { ...prev, [appKey]: { ...prev[appKey], snat: fe, apiSnat: api } };
      });
      setSnatLoaded(prev => ({ ...prev, [appKey]: true }));
    } catch (err: unknown) {
      snatRequested.current.delete(appKey);
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`SNAT fetch failed: ${msg}`);
    } finally {
      setSnatLoading(prev => ({ ...prev, [appKey]: false }));
    }
  }, []);


  return { credStatus, credError, metrics, loading, detailsLoading, detailsLoaded, fetchMetrics, fetchAppDetails, snatLoading, snatLoaded, fetchAppSnat, restartsLoading, restarts, fetchAppRestarts, endpointDeps, fetchEndpointDeps, recheckCredential };
}
