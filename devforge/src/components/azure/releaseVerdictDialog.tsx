import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { ReleaseEvent } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { copyTeamsTable } from '@/lib/teams-html';
import { requestHealthCheckReload } from '@/lib/health-check-reload';
import { cn } from '@/lib/utils';
import { releaseTitle } from './releaseMarkers';
import {
  MIN_AFTER_MS, NEW_TYPE_MIN_COUNT, computeReleaseVerdict,
  verdictLabel, verdictTeamsTable, verdictWindows, type OverallVerdict, type VerdictOutcome, type VerdictResult,
} from './releaseVerdict';

const HOURS = [1, 2, 6] as const;

type Result = VerdictResult;

type State = { kind: 'loading' } | VerdictOutcome;

const VERDICT_CLASS: Record<OverallVerdict, string> = {
  regressed: 'border-error/50 bg-error/10 text-error',
  improved: 'border-success/50 bg-success/10 text-success',
  'no-change': 'border-border bg-muted/40 text-muted-foreground',
};

export interface ReleaseVerdictTarget { site: 'fe' | 'api'; event: ReleaseEvent }

export function ReleaseVerdictDialog({ target, onClose, appKey, appName, hasApi, config }: {
  target: ReleaseVerdictTarget | null;
  onClose: () => void;
  appKey: string;
  appName: string;
  hasApi: boolean;
  config: AzureSettings | undefined;
}) {
  const [hours, setHours] = useState<number>(2);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  // Read through a ref: the settings object is rebuilt far more often than it changes, and
  // as an effect dependency it would refetch both windows on every rebuild.
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    const config = configRef.current;
    if (!target) return;
    const id = ++requestId.current;
    const atMs = Date.parse(target.event.at);
    const now = Date.now();
    const w = verdictWindows(atMs, hours, now);
    // Answered without a fetch, so no loading flash.
    if (w.afterEnd - w.afterStart < MIN_AFTER_MS) {
      setState({ kind: 'too-soon', minutesSince: Math.max(0, Math.round((now - atMs) / 60000)) });
      return;
    }
    setState({ kind: 'loading' });
    computeReleaseVerdict(window.electronAPI.azureMetrics, { appKey, site: target.site, event: target.event, hours, config, nowMs: now })
      .then(outcome => { if (id === requestId.current) setState(outcome); })
      .catch((err: unknown) => {
        if (id === requestId.current) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      });
  }, [target, hours, attempt, appKey]);

  if (!target) return null;
  const atMs = Date.parse(target.event.at);
  const w = verdictWindows(atMs, hours, Date.now());
  const siteName = hasApi ? (target.site === 'fe' ? 'Frontend' : 'API') : '';

  const copy = async (result: Result) => {
    try {
      await copyTeamsTable(verdictTeamsTable({ appName, site: target.site, hasApi, event: target.event, hours, ...result }));
      toast.success('Release verdict copied for Teams');
    } catch (e) {
      toast.error('Copy failed', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto scrollable-content">
        <DialogHeader>
          <DialogTitle>Release verdict — {appName}{siteName && ` ${siteName}`}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{releaseTitle(target.event)}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Compare</span>
          {HOURS.map(h => (
            <Button key={h} size="sm" variant={h === hours ? 'secondary' : 'outline'} className="h-7 px-2.5 text-xs" onClick={() => setHours(h)} aria-pressed={h === hours}>
              {h}h
            </Button>
          ))}
          <span className="text-muted-foreground">before vs after the release</span>
        </div>

        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Fetching both windows…
          </div>
        )}

        {state.kind === 'too-soon' && (
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
            <span>Too soon: the release was {state.minutesSince} min ago. The verdict needs at least {MIN_AFTER_MS / 60000} min of data after it.</span>
            <Button size="sm" variant="outline" onClick={() => setAttempt(a => a + 1)}>Re-check</Button>
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-error/40 px-3 py-2 text-sm text-error">
            <span>{state.message}</span>
            <Button size="sm" variant="outline" onClick={() => setAttempt(a => a + 1)}>Retry</Button>
          </div>
        )}

        {state.kind === 'done' && (
          <div className="flex flex-col gap-3">
            <div className={cn('rounded-md border px-3 py-2 text-sm font-semibold', VERDICT_CLASS[state.result.verdict])}>
              {verdictLabel(state.result.verdict)}
              {w.afterEnd - w.afterStart < hours * 3600 * 1000 && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  (after window is only {Math.round((w.afterEnd - w.afterStart) / 60000)} min so far)
                </span>
              )}
            </div>

            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Metric</th>
                  <th className="py-1 font-medium text-right">Before</th>
                  <th className="py-1 font-medium text-right">After</th>
                  <th className="py-1 font-medium text-right">Change</th>
                </tr>
              </thead>
              <tbody>
                {state.result.rows.filter(r => r.before != null || r.after != null).map(r => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="py-1">{r.label}</td>
                    <td className="py-1 text-right tabular-nums">{r.beforeText}</td>
                    <td className="py-1 text-right tabular-nums">{r.afterText}</td>
                    <td className={cn('py-1 text-right tabular-nums', r.judgement === 'worse' && 'text-error font-semibold', r.judgement === 'better' && 'text-success')}>
                      {r.deltaPct == null ? '' : `${r.deltaPct > 0 ? '+' : ''}${Math.round(r.deltaPct * 100)}%`}
                      {r.judgement === 'worse' && ' ▲'}
                      {r.judgement === 'better' && ' ▼'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {state.result.newTypes.length > 0 && (
              <div className="rounded-md border border-error/40 px-3 py-2 text-xs">
                <div className="font-semibold text-error">New exception types after the release</div>
                <ul className="mt-1 list-disc pl-4">
                  {state.result.newTypes.map(t => <li key={t.type}><span className="font-mono">{t.type}</span> ({t.count})</li>)}
                </ul>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              A change counts only when it is at least 20% and above a per-metric floor, so small numbers don't flip the verdict.
              "New" exception types are ones with {NEW_TYPE_MIN_COUNT}+ hits in the after window's top 10 that were not in the before window's top 10.
              CPU and memory are plan-wide.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                requestHealthCheckReload({ range: { startMs: w.beforeStart, endMs: w.afterEnd }, appKeys: [appKey] });
                onClose();
              }}>
                Open range in Health Check
              </Button>
              <Button size="sm" onClick={() => void copy(state.result)}>Copy for Teams</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
