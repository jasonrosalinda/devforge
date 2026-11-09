// Entry for the hidden worker window behind the tray monitor
// (electron/ipc/background-monitor.cjs). No React, no UI: once a minute it fetches
// the last 6h at 1m buckets for the watched apps (azure-metrics:fetch-monitor — only
// what the alerts read), diffs each against the previous check and raises a desktop
// notification for anything new, or for an app it has failed to fetch 3 times running.
//
// It runs in its own window, so its fetches never touch the App Health Check page.

import type { AppMetrics } from '@shared/types/azureMetrics.types';
import { loadSettings } from '@/lib/settings-store';
import { fetchUptimeRobotMonitors, type UptimeRobotMonitor } from '@/hooks/useUptimeRobotMonitor';
import { snapshotApp, diffApp, trackFetch, type AppSnapshot, type FetchHealth } from './healthAlerts';
import { loadLibrary } from '@/lib/telemetry-library';
import type { AzureSettings } from '@/types/settings.types';
import { evaluateQueryRule, isDue, queryAlertBody, shouldAlert } from './queryAlerts';
import { computeReleaseVerdict } from '@/components/azure/releaseVerdict';
import {
  RELEASE_POLL_MS, RELEASE_VERDICT_HOURS, afterVerdict, dueReleases, emptyReleaseWatch, noteRelease, parseWatchKey,
  releaseAlertBody, watchKey,
} from './releaseAlerts';
import { CERT_CHECK_MS, certAlertLines } from './certAlerts';
import type { CertStatus } from '@shared/types/certs.types';

const WINDOW_MS = 6 * 3_600_000;
const TICK_MS = 60_000;

const previous: Record<string, AppSnapshot> = {};
const fetchHealth: Record<string, FetchHealth> = {};
let running = false;
// Saved-query alerts (Ask Telemetry), keyed by query id.
const queryLastRun: Record<string, number> = {};
const queryFiring: Record<string, boolean> = {};
const queryHealth: Record<string, FetchHealth> = {};
// Release-regression alerts, keyed by app.
// shortcut: in memory only, so a restart within an hour of a release skips its verdict; persist the watch if that matters.
const releaseLastPoll: Record<string, number> = {};
let releaseWatch = emptyReleaseWatch();
// Certificate expiry, by host; checked once a day.
let certLastRun: number | undefined;
let certState: Record<string, CertStatus | undefined> = {};

/** An IPC rejection arrives as "Error invoking remote method '…': Error: <message>". */
function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

async function tick() {
  if (running) return; // a slow Azure call must not stack checks behind itself
  running = true;
  try {
    // Read every time, so a changed app list or key applies without a restart.
    const settings = await loadSettings();
    const { azure, apiKeys, backgroundMonitor } = settings;
    if (!azure.subscriptionId || !azure.apps.length) return;
    await checkSavedQueries(azure);

    const keys = (backgroundMonitor.apps.length ? backgroundMonitor.apps : azure.apps.map(a => a.name))
      .filter(k => azure.apps.some(a => a.name === k));
    if (!keys.length) return;

    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_MS);
    const customStart = start.toISOString();
    const customEnd = end.toISOString();

    // A rejected call (sign-in expired, network down) fails every app's check alike.
    let metrics: Record<string, AppMetrics & { error?: string }> | null = null;
    let callError: string | null = null;
    try {
      metrics = await window.electronAPI.azureMetrics.fetchMonitor({ appKeys: keys, config: azure, customStart, customEnd });
    } catch (e) {
      callError = ipcErrorMessage(e);
    }

    await Promise.all(keys.map(async key => {
      const m = metrics?.[key];
      const appDef = azure.apps.find(a => a.name === key);
      const label = appDef?.platformName || appDef?.resourceGroup || key;

      const error = callError ?? m?.error ?? (m?.cpu?.series?.length ? null : 'Azure returned no CPU data');
      const health = trackFetch(fetchHealth[key], error);
      fetchHealth[key] = health.next;
      if (health.line) {
        await window.electronAPI.backgroundMonitor.alert({ title: `${label} — monitor`, body: health.line });
      }
      // A failed fetch keeps the last snapshot, so the next good one is diffed
      // against real data instead of alerting on everything as if new.
      if (error || !m) {
        console.warn(`[monitor] ${key}: ${error}`);
        return;
      }

      let urMonitors: UptimeRobotMonitor[] = [];
      if (apiKeys.uptimeRobotApiKey && appDef?.uptimeRobotMonitorIds?.length) {
        try {
          urMonitors = await fetchUptimeRobotMonitors(apiKeys.uptimeRobotApiKey, appDef.uptimeRobotMonitorIds, customStart, customEnd);
        } catch (e) {
          console.warn(`[monitor] ${key}: UptimeRobot failed`, e);
        }
      }

      const next = snapshotApp(m, urMonitors, customEnd);
      const lines = diffApp(previous[key], next);
      previous[key] = next;
      if (lines.length) {
        await window.electronAPI.backgroundMonitor.alert({ title: `${label} — health alert`, body: lines.join('\n') });
      }
    }));
    await checkReleases(azure, keys);
    await checkCerts(azure, keys);
    console.log(`[monitor] checked ${keys.length} app(s) at ${customEnd}`);
  } catch (e) {
    console.warn('[monitor] check failed', e);
  } finally {
    running = false;
  }
}

// Now, then on each minute boundary, so checks land just after a 1m bucket closes.
void tick();
setTimeout(() => {
  void tick();
  setInterval(() => void tick(), TICK_MS);
}, TICK_MS - (Date.now() % TICK_MS));

window.electronAPI.backgroundMonitor.onCheckNow(() => void tick());

/** New production releases, then the Release Verdict on each once its first hour is in.
 *  Alerts only on Regressed; each release is judged at most once. Errors stay quiet. */
async function checkReleases(azure: AzureSettings, keys: string[]): Promise<void> {
  const nowMs = Date.now();
  const api = window.electronAPI.azureMetrics;
  for (const key of keys) {
    const last = releaseLastPoll[key];
    if (last != null && nowMs - last < RELEASE_POLL_MS - 1_000) continue;
    releaseLastPoll[key] = nowMs;
    try {
      const res = await api.fetchReleases({ appKey: key, range: '1h', config: azure });
      // A null site result is a failed read, not "no releases": skip it, or the next good
      // read would take an old release for a new one.
      if (res.fe) releaseWatch = noteRelease(releaseWatch, watchKey(key, 'fe'), res.fe.last, nowMs);
      if (res.api && azure.apps.find(a => a.name === key)?.apiName) {
        releaseWatch = noteRelease(releaseWatch, watchKey(key, 'api'), res.api.last, nowMs);
      }
    } catch (e) {
      console.warn(`[monitor] ${key}: releases failed`, ipcErrorMessage(e));
    }
  }

  for (const [wkey, event] of dueReleases(releaseWatch, nowMs)) {
    const { appKey, site } = parseWatchKey(wkey);
    if (!keys.includes(appKey)) continue;
    let judged = false;
    try {
      const outcome = await computeReleaseVerdict(api, { appKey, site, event, hours: RELEASE_VERDICT_HOURS, config: azure, nowMs });
      judged = outcome.kind === 'done';
      if (outcome.kind === 'done' && outcome.result.verdict === 'regressed') {
        const appDef = azure.apps.find(a => a.name === appKey);
        const label = `${appDef?.platformName || appDef?.resourceGroup || appKey}${appDef?.apiName ? (site === 'api' ? ' API' : ' FE') : ''}`;
        const when = new Date(event.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Singapore' });
        await window.electronAPI.backgroundMonitor.alert({
          title: `${label} — ${when} release regressed`,
          body: releaseAlertBody(outcome.result.rows, outcome.result.newTypes),
        });
      } else if (outcome.kind === 'error') {
        console.warn(`[monitor] ${wkey}: release verdict failed`, outcome.message);
      }
    } catch (e) {
      console.warn(`[monitor] ${wkey}: release verdict failed`, ipcErrorMessage(e));
    }
    releaseWatch = afterVerdict(releaseWatch, wkey, judged, nowMs);
  }
}

/** Once a day: one alert per host whose certificate has under 14 days left or has expired. */
async function checkCerts(azure: AzureSettings, keys: string[]): Promise<void> {
  const nowMs = Date.now();
  if (certLastRun != null && nowMs - certLastRun < CERT_CHECK_MS) return;
  certLastRun = nowMs;
  try {
    const { results } = await window.electronAPI.certs.check({ appKeys: keys, config: azure });
    const label = (key: string) => {
      const a = azure.apps.find(x => x.name === key);
      return a?.platformName || a?.resourceGroup || key;
    };
    const { next, lines } = certAlertLines(certState, results, label);
    certState = next;
    if (lines.length) await window.electronAPI.backgroundMonitor.alert({ title: 'TLS certificate expiry', body: lines.join('\n') });
  } catch (e) {
    console.warn('[monitor] certificate check failed', ipcErrorMessage(e));
  }
}

/** Saved Ask Telemetry queries with an alert rule. Read from the same localStorage the
 *  page writes (same origin), every tick, so a rule switched on applies within a minute. */
async function checkSavedQueries(azure: AzureSettings): Promise<void> {
  const nowMs = Date.now();
  const rules = loadLibrary().filter(q => q.alert?.enabled && azure.apps.some(a => a.name === q.appKey));
  for (const q of rules) {
    const rule = q.alert!;
    if (!isDue(rule, queryLastRun[q.id], nowMs)) continue;
    queryLastRun[q.id] = nowMs;

    const appDef = azure.apps.find(a => a.name === q.appKey);
    const label = `${appDef?.platformName || appDef?.resourceGroup || q.appKey}${q.target === 'api' ? ' API' : ''}`;
    let error: string | null = null;
    let result;
    try {
      const res = await window.electronAPI.telemetry.runMonitor({
        config: azure, appKey: q.appKey, target: q.target, kql: q.kql,
        startIso: new Date(nowMs - rule.windowMin * 60_000).toISOString(), endIso: new Date(nowMs).toISOString(),
      });
      result = res.result;
      error = res.success ? (res.result?.error ?? null) : (res.error ?? 'Query failed');
    } catch (e) {
      error = ipcErrorMessage(e);
    }
    const outcome = error ? null : evaluateQueryRule(rule, result);
    error ??= outcome?.error ?? null;

    // Same rule as an app fetch: one alert after 3 failures in a row, one when it recovers.
    const health = trackFetch(queryHealth[q.id], error);
    queryHealth[q.id] = health.next;
    if (health.line) {
      // trackFetch's own wording blames Azure; a query can also fail on its own (a renamed column).
      const body = error ? `"${q.name}" keeps failing: ${error}` : `"${q.name}" is running again`;
      await window.electronAPI.backgroundMonitor.alert({ title: `${label} — saved query`, body, open: 'telemetry' });
    }
    if (!outcome || outcome.error) {
      console.warn(`[monitor] saved query ${q.name}: ${error}`);
      continue;
    }
    if (shouldAlert(queryFiring[q.id], outcome)) {
      await window.electronAPI.backgroundMonitor.alert({ title: `${label} — query alert`, body: queryAlertBody(q.name, rule, outcome, result?.truncated), open: 'telemetry' });
    }
    queryFiring[q.id] = outcome.firing;
  }
}

