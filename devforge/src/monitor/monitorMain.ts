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

const WINDOW_MS = 6 * 3_600_000;
const TICK_MS = 60_000;

const previous: Record<string, AppSnapshot> = {};
const fetchHealth: Record<string, FetchHealth> = {};
let running = false;

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
