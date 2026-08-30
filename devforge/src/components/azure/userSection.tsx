import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { UserInsights } from '@shared/types/azureMetrics.types';
import type { IpReputation } from '@/lib/ipapiIs';
import { SeriesChart } from './azureMetricChart';
import { IpRepBadges } from './ipRepBadges';
import { CellSkeleton, PanelSkeleton } from './loadingSkeleton';
import { UI, PERF_COLORS } from '@/lib/chart-colors';
import {
  userStats, topClientShare, looksAutomated, hasUserData, entityChartSeries, plottableKeys, USERS_COLOR,
} from './users';

type UserAgentRow = { userAgent: string; count: number; rpm: number };
type UsersTab = 'clients' | 'agents';

/** One client holding this much of the listed traffic is a machine, not an audience. */
const CONCENTRATION_WARN_PCT = 50;

const TAB_COLOR: Record<UsersTab, string> = { clients: USERS_COLOR, agents: UI.success };
const TAB_LABEL: Record<UsersTab, string> = { clients: 'Clients', agents: 'User Agents' };

const fmtSgt = (t: string) =>
  new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Singapore', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The right-hand figures: rate first, then the volume it came from. */
function RateCell({ rpm, count, color = USERS_COLOR }: { rpm: number; count: number; color?: string }) {
  return (
    <span className="flex-shrink-0 tabular-nums" style={{ color }} title={`${rpm} requests per minute, ${count.toLocaleString()} requests in total`}>
      {rpm} rpm
      <span style={{ color: UI.textDim }}> / {count.toLocaleString()}</span>
    </span>
  );
}

/**
 * Who was on this site: distinct clients over time, then the addresses and the agents
 * behind that line.
 *
 * Clients and agents are tabs rather than side-by-side columns because each row needs the
 * full width — an address is only judgeable with its country, its window, its reputation
 * and its agent all visible, and an IPv6 address alone eats half a column.
 */
export function UserPanel({
  users, userAgents, ipReputations = {}, syncId,
}: {
  users: UserInsights;
  /** From the same insights payload, ranked by volume — the Group B query. */
  userAgents?: UserAgentRow[] | undefined;
  /** ipapi.is lookups, keyed by IP. Seeded by the card for these exact addresses. */
  ipReputations?: Record<string, IpReputation> | undefined;
  /** Card-wide hover group, so the crosshair tracks the CPU/memory chart. */
  syncId?: string | undefined;
}) {
  const [tab, setTab] = useState<UsersTab>('clients');
  /** The one client or agent charted, or null for the unique-user line. */
  const [selected, setSelected] = useState<string | null>(null);
  const s = userStats(users.series);
  const share = topClientShare(users.topIps);
  const uas = (userAgents ?? []).slice(0, 10);
  const concentrated = share != null && share >= CONCENTRATION_WARN_PCT;

  // Drop the selection when the fetch returns a different set — a client held over from
  // the previous time range would stay charted with no row left to deselect it from.
  const signature = `${users.topIps.map(c => c.ip).join('|')}#${uas.map(u => u.userAgent).join('|')}`;
  const lastSignature = useRef(signature);
  if (lastSignature.current !== signature) {
    lastSignature.current = signature;
    setSelected(null);
  }

  const entityList = tab === 'clients' ? users.clientSeries : users.agentSeries;
  const plottable = plottableKeys(entityList);
  const entityPoints = entityChartSeries(entityList, selected);
  const charted = selected != null && entityPoints.length > 0;
  const accent = TAB_COLOR[tab];

  /** Clicking the charted row again clears it, back to the unique-user line. */
  const toggle = (key: string) => setSelected(prev => (prev === key ? null : key));

  // Switching tabs clears the selection: the chart should show what the visible list is
  // about, and a client's line sitting above the agent list has nothing to deselect it.
  const switchTab = (t: UsersTab) => { setTab(t); setSelected(null); };

  return (
    <div style={{ fontSize: 10, padding: '2px 8px 4px' }}>
      {(charted || users.series.length > 1) && (
        <>
          <SeriesChart
            series={charted ? entityPoints : users.series.map(p => ({ t: p.t, v: p.users, m: p.users }))}
            color={charted ? accent : USERS_COLOR}
            name={charted ? 'Requests' : 'Users'}
            height={130}
            syncId={syncId}
          />
          <div style={{ color: UI.textDim, paddingLeft: 8, marginBottom: 5 }}>
            {charted
              ? <>
                  Requests per {users.bin ?? 'bucket'} from <span style={{ color: accent }}>{selected}</span> —
                  gaps are buckets it made no requests in. Click the highlighted row again for the unique-user line.
                </>
              : <>
                  Distinct client IPs per {users.bin ?? 'bucket'} — one value per bucket, so the figures on the row above
                  are across buckets, not within them.
                  {s.peak && ` Peak ${s.peak.users.toLocaleString()} at ${fmtSgt(s.peak.t)} SGT.`}
                  {' '}A client is an IP address, which over-counts anyone on a changing address and under-counts a shared
                  office or mobile network — read it as traffic sources, not as a head-count.
                </>
            }
          </div>
        </>
      )}

      <div className="flex gap-0.5 flex-wrap" style={{ marginBottom: 4 }}>
        {(['clients', 'agents'] as const).map(t => {
          const c = TAB_COLOR[t];
          const on = tab === t;
          return (
            <button
              key={t}
              onClick={() => switchTab(t)}
              style={{
                background: on ? `${c}22` : 'none',
                border: `1px solid ${on ? `${c}66` : 'transparent'}`,
                color: on ? c : 'var(--muted-foreground)',
                borderRadius: 4, padding: '1px 6px', fontSize: 9,
                cursor: 'pointer', fontWeight: on ? 600 : 400,
              }}
            >{TAB_LABEL[t]}</button>
          );
        })}
        {concentrated && tab === 'clients' && (
          <span
            style={{ color: UI.warning, alignSelf: 'center', marginLeft: 4 }}
            title={`The busiest address made ${share}% of the requests these ten clients account for. Real traffic spread across ten clients sits nearer 10-20%; this concentration is one machine.`}
          >
            {share}% from one address
          </span>
        )}
      </div>

      {tab === 'clients' && (
        users.topIps.length === 0
          ? <span className="text-[10px] text-muted-foreground italic">No client data</span>
          : <div className="flex flex-col gap-0.5">
              {users.topIps.map(c => {
                const canPlot = plottable.has(c.ip);
                const on = selected === c.ip;
                return (
                <div
                  key={c.ip}
                  onClick={() => canPlot && toggle(c.ip)}
                  className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0"
                  style={{
                    cursor: canPlot ? 'pointer' : 'default',
                    opacity: canPlot ? 1 : 0.45,
                    background: on ? `${accent}18` : 'transparent',
                    // Inset rather than a left border, so selecting a row does not shift
                    // every column across by the border's width.
                    boxShadow: on ? `inset 2px 0 0 ${accent}` : 'none',
                    borderRadius: 2,
                    paddingLeft: on ? 4 : 0,
                  }}
                  title={`${c.ip}${c.country ? ` — ${c.country}` : ''}\n${c.count.toLocaleString()} requests at ${c.rpm} rpm across ${c.urlCount.toLocaleString()} distinct endpoints\n${fmtSgt(c.firstSeen)} → ${fmtSgt(c.lastSeen)} SGT\n${c.fourXx.toLocaleString()} 4xx, ${c.fiveXx.toLocaleString()} 5xx${c.agents > 1 ? `\n\nPresented ${c.agents} different user agents — the one shown is the most used.` : ''}${canPlot ? `\n\nClick to ${on ? 'clear the chart' : 'chart this client'}` : '\n\nNo timeline for this client'}`}
                >
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate" style={{ color: 'var(--muted-foreground)' }}>
                      {c.ip}{c.country ? ` - ${c.country}` : ''} · {fmtSgt(c.firstSeen)} → {fmtSgt(c.lastSeen)} SGT
                      <IpRepBadges rep={ipReputations[c.ip]} />
                    </span>
                    <span className="truncate opacity-70" style={{ color: 'var(--muted-foreground)' }}>
                      {c.userAgent || '(unknown)'}
                      {c.agents > 1 && <span style={{ color: UI.warning }}> +{c.agents - 1} more agents</span>}
                    </span>
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0">
                    <RateCell rpm={c.rpm} count={c.count} />
                    <span className="tabular-nums" style={{ color: UI.textDim }}>
                      {c.urlCount.toLocaleString()} endpoint{c.urlCount === 1 ? '' : 's'}
                      {/* Only when non-zero: a client with no errors should not carry two
                          dashes, and one collecting 404s should be impossible to miss. */}
                      {c.fourXx > 0 && <span style={{ color: PERF_COLORS.fourXx }}> · {c.fourXx.toLocaleString()} 4xx</span>}
                      {c.fiveXx > 0 && <span style={{ color: UI.error }}> · {c.fiveXx.toLocaleString()} 5xx</span>}
                    </span>
                  </div>
                </div>
                );
              })}
              <div style={{ color: UI.textDim, marginTop: 2 }}>
                Ranked by request count — click one to chart its requests. Badges are ipapi.is reputation for the
                address; an address with no badge has not resolved yet.
              </div>
            </div>
      )}

      {tab === 'agents' && (
        uas.length === 0
          ? <span className="text-[10px] text-muted-foreground italic">No user agent data</span>
          : <div className="flex flex-col gap-0.5">
              {uas.map(u => {
                const auto = looksAutomated(u.userAgent);
                const canPlot = plottable.has(u.userAgent);
                const on = selected === u.userAgent;
                return (
                  <div
                    key={u.userAgent}
                    onClick={() => canPlot && toggle(u.userAgent)}
                    className="flex items-center justify-between gap-2 text-[10px] border-b border-border/30 pb-0.5 mb-0.5 last:border-0 last:pb-0 last:mb-0"
                    style={{
                      cursor: canPlot ? 'pointer' : 'default',
                      opacity: canPlot ? 1 : 0.45,
                      background: on ? `${accent}18` : 'transparent',
                      boxShadow: on ? `inset 2px 0 0 ${accent}` : 'none',
                      borderRadius: 2,
                      paddingLeft: on ? 4 : 0,
                    }}
                    title={`${u.userAgent || '(unknown)'}\n${u.count.toLocaleString()} requests at ${u.rpm} rpm${auto ? '\n\nMatches a known crawler or scripted-client pattern.' : ''}${canPlot ? `\n\nClick to ${on ? 'clear the chart' : 'chart this agent'}` : '\n\nNo timeline for this agent'}`}
                  >
                    <span className="truncate flex-1 min-w-0" style={{ color: 'var(--muted-foreground)' }}>
                      {auto && <span style={{ color: UI.warning, marginRight: 4, fontWeight: 600 }}>auto</span>}
                      {u.userAgent || '(unknown)'}
                    </span>
                    <RateCell rpm={u.rpm} count={u.count} color={TAB_COLOR.agents} />
                  </div>
                );
              })}
              <div style={{ color: UI.textDim, marginTop: 2 }}>
                Ranked by request count — click one to chart its requests. 'auto' marks a known crawler or
                scripted-client pattern.
              </div>
            </div>
      )}
    </div>
  );
}

/**
 * The Users row as it sits inside a FE / API section table.
 *
 * Per site rather than per app: this replaced a row above the table fed by a
 * frontend-only query, so an app's API had no user figures on the card at all.
 */
export function UserRows({
  users, userAgents, ipReputations, expanded, onToggle, syncId, loading = false, error, unavailableMessage,
}: {
  users: UserInsights | null | undefined;
  userAgents?: UserAgentRow[] | undefined;
  ipReputations?: Record<string, IpReputation> | undefined;
  expanded: boolean;
  onToggle: () => void;
  syncId?: string | undefined;
  /** The card's details fetch is in flight — this payload arrives with it. */
  loading?: boolean;
  error?: string | null | undefined;
  unavailableMessage?: string | undefined;
}) {
  const has = hasUserData(users);
  const s = userStats(users?.series);

  return (
    <>
      {/* Always clickable, like Requests and Performance: the payload arrives with the
          card's lazy details fetch, so expanding the row is what asks for it. */}
      <tr
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.02)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <td
          className="text-muted-foreground font-bold"
          title="Users: distinct client IPs per time bucket for this site, from App Insights request telemetry. Average / P99 / Max are across buckets, not within them. Expand for the traffic-source timeline and the busiest addresses and user agents."
        >
          Users
          {expanded
            ? <ChevronDown size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />
            : <ChevronRight size={11} style={{ marginLeft: 3, display: 'inline', verticalAlign: 'middle' }} />}
        </td>
        <td
          className="text-right tabular-nums"
          style={{ color: has ? USERS_COLOR : undefined }}
          title={has ? `Typical bucket, across ${s.buckets} buckets` : undefined}
        >
          {has
            ? <><span style={{ color: UI.textDim }}>Avg - </span>{s.avg.toLocaleString()}</>
            : loading ? <CellSkeleton w={38} /> : '—'}
        </td>
        <td
          className="text-right tabular-nums"
          style={{ color: has ? USERS_COLOR : undefined }}
          title="99th percentile bucket — sits just under the max unless one bucket is a genuine outlier"
        >
          {has
            ? <><span style={{ color: UI.textDim }}>P99 - </span>{s.p99.toLocaleString()}</>
            : loading ? <CellSkeleton w={34} /> : '—'}
        </td>
        <td
          className="text-right tabular-nums"
          style={{ color: has ? USERS_COLOR : undefined }}
          title={s.peak ? `Peak at ${fmtSgt(s.peak.t)} SGT` : undefined}
        >
          {has
            ? <><span style={{ color: UI.textDim }}>Peak - </span>{s.max.toLocaleString()}</>
            : loading ? <CellSkeleton w={42} /> : '—'}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={4} style={{ paddingTop: 2, paddingBottom: 6 }}>
            {loading && !has
              ? <PanelSkeleton rows={5} chartHeight={130} />
              : error
                ? <span className="text-[10px] text-destructive">{error}</span>
                : unavailableMessage
                  ? <span className="text-[10px] text-muted-foreground italic">{unavailableMessage}</span>
                  : has && users
                    ? <UserPanel users={users} userAgents={userAgents} ipReputations={ipReputations} syncId={syncId} />
                    : <span className="text-[10px] text-muted-foreground italic">No client telemetry in this window</span>
            }
          </td>
        </tr>
      )}
    </>
  );
}
