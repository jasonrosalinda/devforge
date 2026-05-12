import { useState, useEffect } from 'react';

export interface UptimeRobotLog {
  type: number;   // 1=down, 2=up, 98=started, 99=paused
  datetime: number; // unix seconds
  duration: number; // seconds
  reason?: { code: number; detail: string };
}

export interface UptimeRobotMonitor {
  id: number;
  friendly_name: string;
  url: string;
  status: number; // 0=paused,1=not_checked,2=up,8=seems_down,9=down
  logs: UptimeRobotLog[];
}

export function useUptimeRobotMonitor(
  apiKey: string | undefined,
  monitorIds: string[] | undefined,
  rangeStart?: string,
  rangeEnd?: string,
) {
  const [monitors, setMonitors] = useState<UptimeRobotMonitor[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const idsKey = monitorIds?.join(',');

  useEffect(() => {
    if (!apiKey || !monitorIds?.length) { setMonitors([]); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const startUnix = rangeStart ? Math.floor(new Date(rangeStart).getTime() / 1000) : undefined;
    const endUnix   = rangeEnd   ? Math.floor(new Date(rangeEnd).getTime()   / 1000) : undefined;

    const params: Record<string, string> = {
      api_key: apiKey,
      format: 'json',
      logs: '1',
      logs_limit: '50',
      monitors: monitorIds.join('-'),
    };
    if (startUnix) params['logs_start_time'] = String(startUnix);
    if (endUnix)   params['logs_end_time']   = String(endUnix);

    fetch('https://api.uptimerobot.com/v2/getMonitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    })
      .then(r => r.json())
      .then(data => {
        if (cancelled) return;
        if (data.stat === 'ok') {
          const result = (data.monitors ?? []) as UptimeRobotMonitor[];
          if (startUnix || endUnix) {
            for (const mon of result) {
              mon.logs = (mon.logs ?? []).filter(l =>
                (!startUnix || l.datetime + l.duration >= startUnix) &&
                (!endUnix   || l.datetime <= endUnix)
              );
            }
          }
          setMonitors(result);
        } else {
          setError(data.error?.message ?? 'Request failed');
        }
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, idsKey, rangeStart, rangeEnd]);

  return { monitors, loading, error };
}
