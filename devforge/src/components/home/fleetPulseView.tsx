import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useSettings } from '@/context/settings-context';
import { useSettingsUi } from '@/context/settings-ui-context';
import { Button } from '@/components/ui/button';
import { fetchUptimeRobotMonitors, type UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { requestHealthCheckReload } from '@/lib/health-check-reload';
import { CHART_COLORS } from '@/lib/chart-colors';
import { cn } from '@/lib/utils';
import { HEALTH_CHECK_PAGE } from '@/routes/page-routes';
import { HTTP_5XX_RATE } from '@/components/azure/appRemarks';
import { releaseTitle } from '@/components/azure/releaseMarkers';
import { SkeletonBlock } from '@/components/azure/loadingSkeleton';
import { PULSE_WINDOW_MS, buildPulseRow, formatRate, relativeAgo, rowIssues, type PulseRow, type Tone } from './fleetPulse';
import { Sparkline } from './sparkline';

const REFRESH_MS = 5 * 60 * 1000;

const DOT: Record<Tone | 'error', string> = { ok: 'bg-success', warning: 'bg-warning', critical: 'bg-error', error: 'bg-muted-foreground' };

const settled = <T,>(r: PromiseSettledResult<T>): T | undefined => (r.status === 'fulfilled' ? r.value : undefined);
const pct = (v: number | null, digits = 0) => (v == null ? '—' : `${v.toFixed(digits)}%`);

function rowTone(r: PulseRow): Tone | 'error' {
  if (r.error) return 'error';
  const issues = rowIssues(r);
  return issues.some(i => i.tone === 'critical') ? 'critical' : issues.length ? 'warning' : 'ok';
}

function Vital({ label, values, max, ticks, threshold, color, value, sub }: {
  label: string; values: number[]; max: number; ticks: number[]; threshold?: number; color: string; value: string;
  /** A second, smaller figure under the value, e.g. the window's peak. */
  sub?: string | undefined;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <Sparkline values={values} max={max} ticks={ticks} threshold={threshold} color={color} label={`${label} last 6 hours, now ${value}${sub ? `, ${sub}` : ''}`} />
      <span className="flex w-20 shrink-0 flex-col items-end leading-tight">
        <span className="text-sm font-medium tabular-nums" title="Latest minute">{value}</span>
        {sub && <span className="text-[10px] text-muted-foreground tabular-nums">{sub}</span>}
      </span>
    </div>
  );
}

const GRID = 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]';

/** Same shape as a loaded card, so nothing jumps when the data lands. The name is real —
 *  it comes from Settings, not from Azure. */
function CardSkeleton({ label }: { label: string }) {
  return (
    <li className="flex h-full flex-col gap-3 rounded-xl border bg-card p-4" aria-hidden>
      <div className="flex items-center gap-2">
        <SkeletonBlock className="size-2.5 rounded-full" />
        <span className="truncate text-base font-semibold text-muted-foreground">{label}</span>
        <SkeletonBlock className="ml-auto h-5 w-12 rounded-full" />
      </div>
      <SkeletonBlock className="-mt-1 h-3 w-3/4" />
      <div className="flex flex-col gap-2">
        {['CPU', 'Mem', '5xx'].map(l => (
          <div key={l} className="flex items-center gap-3">
            <span className="w-12 shrink-0 text-[11px] text-muted-foreground">{l}</span>
            <SkeletonBlock className="h-7 flex-1" />
            <SkeletonBlock className="h-4 w-12 shrink-0" />
          </div>
        ))}
      </div>
      <div className="mt-auto flex items-center border-t pt-2">
        <SkeletonBlock className="h-3 w-28" />
      </div>
    </li>
  );
}

/** Home's live summary: every configured app over the last 6h, judged the same way the
 *  tray monitor judges it. Loads on its own; refreshes while Home is the visible tab. */
export function FleetPulse({ active, onNavigate }: { active: boolean; onNavigate: (title: string) => void }) {
  const { settings, loading: settingsLoading } = useSettings();
  const { openSettings } = useSettingsUi();
  const [rows, setRows] = useState<PulseRow[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const { azure, apiKeys } = settings;
  const configured = !!azure.subscriptionId && azure.apps.length > 0;

  const load = useCallback(async () => {
    if (loadingRef.current || !configured) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const nowMs = Date.now();
    const customStart = new Date(nowMs - PULSE_WINDOW_MS).toISOString();
    const customEnd = new Date(nowMs).toISOString();
    const api = window.electronAPI.azureMetrics;
    try {
      // The tray monitor's fetch: batched, 1m buckets, and no partials — an open App
      // Health Check tab never sees it.
      const metrics = await api.fetchMonitor({ appKeys: azure.apps.map(a => a.name), config: azure, customStart, customEnd });
      const next = await Promise.all(azure.apps.map(async app => {
        const [releases, ur] = await Promise.allSettled([
          api.fetchReleases({ appKey: app.name, range: 'custom', config: azure, customStart, customEnd }),
          apiKeys.uptimeRobotApiKey && app.uptimeRobotMonitorIds?.length
            ? fetchUptimeRobotMonitors(apiKeys.uptimeRobotApiKey, app.uptimeRobotMonitorIds, customStart, customEnd)
            : Promise.resolve(undefined as UptimeRobotMonitor[] | undefined),
        ]);
        return buildPulseRow({
          key: app.name,
          label: app.platformName || app.resourceGroup || app.name,
          hasApi: !!app.apiName,
          metrics: metrics[app.name],
          releases: settled(releases),
          urMonitors: settled(ur),
          nowMs,
        });
      }));
      setRows(next);
      setUpdatedAt(nowMs);
    } catch (e) {
      setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [configured, azure, apiKeys.uptimeRobotApiKey]);

  // Load when Home is shown and the data is missing or stale, then every 5 min while it
  // stays the visible tab. A hidden window or another tab costs no Azure calls.
  const loadRef = useRef(load);
  loadRef.current = load;
  const updatedRef = useRef(updatedAt);
  updatedRef.current = updatedAt;
  useEffect(() => {
    if (!active || settingsLoading) return;
    const tick = () => {
      if (document.hidden) return;
      if (!updatedRef.current || Date.now() - updatedRef.current >= REFRESH_MS) void loadRef.current();
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [active, settingsLoading, configured]);

  if (settingsLoading) return null;
  if (!configured) {
    return (
      <div className="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
        Add your Azure subscription and apps to see their health here.{' '}
        <button type="button" className="text-foreground underline underline-offset-2" onClick={() => openSettings('azure')}>Open Settings → Azure</button>
      </div>
    );
  }

  const openApp = (key: string) => {
    const now = Date.now();
    requestHealthCheckReload({ range: { startMs: now - PULSE_WINDOW_MS, endMs: now }, appKeys: [key] });
    onNavigate(HEALTH_CHECK_PAGE);
  };

  return (
    <section className="flex flex-col gap-3" aria-label="App health, last 6 hours" aria-busy={loading}>

      {error && (
        <div className="flex items-center gap-3 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm">
          <span className="flex-1">
            Couldn't check the apps: {error}
            {/sign-?in|login|credential|token/i.test(error) && <span className="text-muted-foreground"> — run <code className="font-mono">az login</code>, then retry.</span>}
          </span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void load()} disabled={loading}>Retry</Button>
        </div>
      )}

      {!rows && !error && (
        <ul className={GRID} aria-label="Loading app health">
          {azure.apps.map(a => <CardSkeleton key={a.name} label={a.platformName || a.resourceGroup || a.name} />)}
        </ul>
      )}

      {rows && (
        <ul className={GRID}>
          {rows.map(r => {
            const tone = rowTone(r);
            const memIsPct = r.memUnit === '%';
            const issues = r.error ? [] : rowIssues(r);
            return (
              <li key={r.key}>
                <button
                  type="button"
                  onClick={() => openApp(r.key)}
                  className={cn(
                    'group flex h-full w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left shadow-sm outline-none',
                    'transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-px hover:border-brand/40 hover:shadow-md',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  )}
                  aria-label={`Open ${r.label} in App Health Check`}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className={cn('size-2.5 shrink-0 rounded-full', DOT[tone])} aria-label={tone} />
                    <span className="truncate text-base font-semibold">{r.label}</span>
                    {r.uptime && (
                      <span className={cn(
                        'ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]',
                        r.uptime === 'up' ? 'border-success/40 text-success' : 'border-error/50 bg-error/10 text-error',
                      )}>
                        <span className={cn('size-1.5 rounded-full', r.uptime === 'up' ? 'bg-success' : 'bg-error animate-pulse')} />
                        {r.uptime === 'up' ? 'Up' : 'Down'}
                      </span>
                    )}
                  </div>

                  <p className={cn('-mt-1 line-clamp-2 text-xs', issues.length ? (tone === 'critical' ? 'text-error' : 'text-warning') : 'text-muted-foreground')}>
                    {r.error ? `Couldn't load: ${r.error}` : issues.length ? issues.map(i => i.text.replace(`${r.label} `, '')).join(' · ') : 'Healthy — nothing in the last 6 hours.'}
                  </p>

                  {!r.error && (
                    <div className="flex w-full flex-col gap-2">
                      <Vital label="CPU" values={r.cpu} max={100} ticks={r.releaseTicks} color={CHART_COLORS.cpuMax} value={pct(r.current.cpu)} />
                      <Vital label="Mem" values={r.mem} max={memIsPct ? 100 : 0} ticks={r.releaseTicks} color={CHART_COLORS.memMax}
                        value={memIsPct ? pct(r.current.mem) : r.current.mem == null ? '—' : `${Math.round(r.current.mem)} MB`} />
                      {r.http5xx.map(x => (
                        <Vital key={x.site} label={x.label} values={x.rates} max={HTTP_5XX_RATE * 2} ticks={r.releaseTicks} threshold={HTTP_5XX_RATE}
                          color="hsl(var(--error))" value={formatRate(x.current)}
                          sub={x.peak ? `peak ${formatRate(x.peak)}` : undefined} />
                      ))}
                    </div>
                  )}

                  <div className="mt-auto flex w-full items-center gap-2 border-t pt-2 text-xs text-muted-foreground">
                    {r.lastRelease
                      ? <span title={releaseTitle(r.lastRelease.event)}>▲ Released <span className="text-foreground">{relativeAgo(Date.parse(r.lastRelease.event.at), Date.now())}</span></span>
                      : <span>No release in 30 days</span>}
                    <span className="ml-auto inline-flex items-center gap-1 transition-colors group-hover:text-foreground">
                      Health Check <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
