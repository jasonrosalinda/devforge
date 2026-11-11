import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { DownstreamFailure } from '@shared/types/azureMetrics.types';
import { PERF_COLORS, UI } from '@/lib/chart-colors';

/** "429 ×4,827 · 500 ×3" — a target's failures by result code, busiest first. Pure. */
export function codesText(codes: DownstreamFailure['codes'], max = 4): string {
  const shown = codes.slice(0, max).map(c => `${c.code} ×${c.count.toLocaleString()}`).join(' · ');
  return codes.length > max ? `${shown} · +${codes.length - max} more` : shown;
}

/**
 * The downstream calls that failed in a window, by target and result code: a dependency
 * throttling or rejecting the site (an SSO API answering 429) shows here by name, where the
 * site's own 5xx count only says that something failed.
 */
export function DownstreamFailures({ appKey, site, config, startIso, endIso, collapsible = false }: {
  appKey: string;
  site: 'fe' | 'api';
  config: unknown;
  startIso: string;
  endIso: string;
  /** On the App Health Check card: closed until clicked, and only then fetched. */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const [state, setState] = useState<{ loading: boolean; rows: DownstreamFailure[]; hidden: number; error: string | null } | null>(null);

  // Keyed to the minute: a window ending "now" is re-derived on every render.
  const from = startIso.slice(0, 16);
  const to = endIso.slice(0, 16);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setState({ loading: true, rows: [], hidden: 0, error: null });
    window.electronAPI.azureMetrics.fetchDownstream({ appKey, site, config, startIso, endIso })
      .then(r => { if (live) setState({ loading: false, rows: r.rows ?? [], hidden: r.hiddenBrowserBlocked ?? 0, error: r.error ?? null }); })
      .catch(e => { if (live) setState({ loading: false, rows: [], hidden: 0, error: e instanceof Error ? e.message : String(e) }); });
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the window by the minute, and config is read at fetch time
  }, [open, appKey, site, from, to]);

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: UI.textMuted }}>
      {collapsible && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
      Failing downstream calls
      {state?.rows.length ? <span style={{ fontWeight: 400 }}>· {state.rows.length} target{state.rows.length === 1 ? '' : 's'}</span> : null}
    </div>
  );

  return (
    <div style={{ padding: '4px 8px' }}>
      {collapsible
        ? <button type="button" onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }} aria-expanded={open}>{header}</button>
        : header}
      {open && (
        state?.loading || !state
          ? <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: UI.textDim, padding: '4px 0' }}><Loader2 size={12} className="animate-spin" />Loading…</div>
          : state.error
            ? <div style={{ fontSize: 11, color: UI.textDim, padding: '4px 0' }}>Unavailable: {state.error}</div>
            : !state.rows.length
              ? <div style={{ fontSize: 11, color: UI.textDim, padding: '4px 0' }}>No downstream call failed in this window.</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, marginTop: 4 }}>
                  <thead>
                    <tr style={{ color: UI.textDim, textAlign: 'left' }}>
                      <th style={{ fontWeight: 500, padding: '2px 6px 2px 0' }}>Target</th>
                      <th style={{ fontWeight: 500, padding: '2px 6px' }}>Type</th>
                      <th style={{ fontWeight: 500, padding: '2px 6px', textAlign: 'right' }}>Failed / calls</th>
                      <th style={{ fontWeight: 500, padding: '2px 0 2px 6px' }}>Result codes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.rows.map(r => (
                      <tr key={`${r.target}|${r.type}`} style={{ borderTop: `1px solid ${UI.border}` }}>
                        <td style={{ padding: '3px 6px 3px 0', color: UI.text, wordBreak: 'break-all' }}>{r.target.split(' | ')[0]}</td>
                        <td style={{ padding: '3px 6px', color: UI.textMuted, whiteSpace: 'nowrap' }}>{r.type}</td>
                        <td className="tabular-nums" style={{ padding: '3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <span style={{ color: PERF_COLORS.fiveXx }}>{r.failed.toLocaleString()}</span>
                          <span style={{ color: UI.textDim }}> / {r.calls.toLocaleString()} ({r.calls ? Math.round(r.failed / r.calls * 1000) / 10 : 0}%)</span>
                        </td>
                        <td className="tabular-nums" style={{ padding: '3px 0 3px 6px', color: UI.textMuted }}>{codesText(r.codes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
      )}
      {open && state && !state.loading && state.hidden > 0 && (
        <div style={{ fontSize: 10, color: UI.textDim, paddingTop: 2 }}>
          {state.hidden} browser call target{state.hidden === 1 ? '' : 's'} hidden: cancelled in the browser (status 0), such as analytics and ad hosts, not the site's own backends.
        </div>
      )}
    </div>
  );
}
