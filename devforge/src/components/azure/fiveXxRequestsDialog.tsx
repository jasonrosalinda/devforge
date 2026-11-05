import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import type { FiveXxRequestsResult } from '@shared/types/azureMetrics.types';
import type { AzureSettings } from '@/types/settings.types';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { formatSgtRange } from './rcaHtml';

export const PAGE_SIZE = 25;

/** Rows for one page, with the page clamped into range. Pure; exported for tests. */
export function pageOf<T>(rows: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: rows.slice(p * size, (p + 1) * size), page: p, pages };
}

/** HH:mm:ss in SGT — records within one burst share a date, so the time is what differs. */
export function sgtTime(iso: string): string {
  const d = new Date(Date.parse(iso) + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export interface FiveXxTarget { startMs: number; endMs: number; site?: 'fe' | 'api' }

type State = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; data: FiveXxRequestsResult };

export function FiveXxRequestsDialog({ target, onClose, appKey, appName, hasApi, config }: {
  target: FiveXxTarget | null;
  onClose: () => void;
  appKey: string;
  appName: string;
  hasApi: boolean;
  config: AzureSettings | undefined;
}) {
  // Starts on the clicked burst's site (the card remounts this per burst); the toggle can switch.
  const [site, setSite] = useState<'fe' | 'api'>(target?.site ?? 'fe');
  const [page, setPage] = useState(0);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);
  // The settings object is rebuilt far more often than it changes — not an effect dependency.
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    if (!target) return;
    const id = ++requestId.current;
    setState({ kind: 'loading' });
    setPage(0);
    window.electronAPI.azureMetrics.fetchFiveXxRequests({
      appKey, site, config: configRef.current,
      startIso: new Date(target.startMs).toISOString(), endIso: new Date(target.endMs).toISOString(),
    })
      .then(data => {
        if (id !== requestId.current) return;
        setState(data.error ? { kind: 'error', message: data.error } : { kind: 'done', data });
      })
      .catch((e: unknown) => {
        if (id === requestId.current) setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      });
  }, [target, site, attempt, appKey]);

  if (!target) return null;

  const copyOp = (opId: string) => {
    void navigator.clipboard.writeText(opId);
    toast.success('Operation ID copied', { description: 'Search it in Ask Telemetry or the portal to see the whole request.' });
  };

  const data = state.kind === 'done' ? state.data : null;
  const { items, page: shown, pages } = pageOf(data?.rows ?? [], page);
  const shownRequests = data?.rows.reduce((s, r) => s + r.itemCount, 0) ?? 0;

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-6xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>5xx errors — {appName}</DialogTitle>
          <DialogDescription>{formatSgtRange(target.startMs, target.endMs)}</DialogDescription>
        </DialogHeader>

        {hasApi && (
          <div className="flex items-center gap-1 text-xs" role="radiogroup" aria-label="Site">
            {(['fe', 'api'] as const).map(s => (
              <Button key={s} size="sm" role="radio" aria-checked={site === s} variant={site === s ? 'secondary' : 'outline'}
                className="h-7 px-3 text-xs" onClick={() => setSite(s)}>
                {s === 'fe' ? 'Frontend' : 'API'}
              </Button>
            ))}
          </div>
        )}

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading 5xx requests…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-error/40 px-3 py-2 text-sm text-error">
            <span>{state.message}</span>
            <Button size="sm" variant="outline" onClick={() => setAttempt(a => a + 1)}>Retry</Button>
          </div>
        )}

        {data && data.rows.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No 5xx requests in App Insights for this {site === 'api' ? 'API' : 'frontend'} in this window.
            {!hasApi || site === 'fe' ? ' The burst may come from Azure Monitor\'s Http5xx metric, which counts errors App Insights did not record.' : ''}
          </p>
        )}

        {data && data.rows.length > 0 && (
          <>
            <p className="text-xs text-muted-foreground">
              {data.total.toLocaleString('en-US')} 5xx {data.total === 1 ? 'request' : 'requests'}, newest first.
              {shownRequests < data.total && ` Showing the newest ${data.rows.length.toLocaleString('en-US')} records.`}
              {data.rows.some(r => r.itemCount > 1) && ' Sampled: a ×N record stands for N requests.'}
            </p>
            <div className="min-h-0 flex-1 overflow-auto scrollable-content rounded-md border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1.5 font-medium">Time (SGT)</th>
                    <th className="px-2 py-1.5 font-medium">Code</th>
                    <th className="px-2 py-1.5 font-medium">Request</th>
                    <th className="px-2 py-1.5 font-medium">URL</th>
                    <th className="px-2 py-1.5 font-medium text-right">Duration</th>
                    <th className="px-2 py-1.5 font-medium">Instance</th>
                    <th className="px-2 py-1.5 font-medium">Operation</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={`${r.operationId}-${shown * PAGE_SIZE + i}`} className="border-t border-border align-top">
                      <td className="px-2 py-1 whitespace-nowrap tabular-nums">{sgtTime(r.t)}</td>
                      <td className="px-2 py-1 whitespace-nowrap font-semibold text-error">
                        {r.resultCode}{r.itemCount > 1 && <span className="ml-1 font-normal text-muted-foreground">×{r.itemCount}</span>}
                      </td>
                      <td className="px-2 py-1 max-w-[16rem] truncate" title={r.name}>{r.name}</td>
                      <td className="px-2 py-1 max-w-[22rem] truncate font-mono" title={r.url}>{r.url || '—'}</td>
                      <td className="px-2 py-1 whitespace-nowrap text-right tabular-nums">{r.durationMs.toLocaleString('en-US')} ms</td>
                      <td className="px-2 py-1 whitespace-nowrap">{r.instance || '—'}</td>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {r.operationId ? (
                          <Hint label="Copy operation ID">
                            <button type="button" onClick={() => copyOp(r.operationId)} aria-label={`Copy operation ID ${r.operationId}`}
                              className="inline-flex items-center gap-1 font-mono text-muted-foreground hover:text-foreground">
                              {r.operationId.slice(0, 8)}… <Copy className="h-3 w-3" />
                            </button>
                          </Hint>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-end gap-2 text-xs">
              <span className="text-muted-foreground tabular-nums">
                {shown * PAGE_SIZE + 1}–{shown * PAGE_SIZE + items.length} of {data.rows.length.toLocaleString('en-US')} · Page {shown + 1} of {pages}
              </span>
              <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => setPage(shown - 1)} disabled={shown === 0} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => setPage(shown + 1)} disabled={shown >= pages - 1} aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
