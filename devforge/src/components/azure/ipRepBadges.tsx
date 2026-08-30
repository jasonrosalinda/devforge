import type { IpReputation } from '@/lib/ipapiIs';
import { UI } from '@/lib/chart-colors';

/**
 * Which ipapi.is flags are worth a badge, and how alarming each is.
 *
 * Red is "this is not a person": a known crawler, a reported abuser, or Tor. Amber is
 * "this is not a home connection" — a proxy, VPN or datacenter address is normal for an
 * integration and suspicious for a login page, so it is surfaced without a verdict.
 * Blue is neutral context.
 */
const IP_REP_FLAGS: Array<{ key: keyof IpReputation; label: string; color: string }> = [
  { key: 'isCrawler',    label: 'crawler',    color: UI.error },
  { key: 'isAbuser',     label: 'abuser',     color: UI.error },
  { key: 'isTor',        label: 'tor',        color: UI.error },
  { key: 'isProxy',      label: 'proxy',      color: UI.warning },
  { key: 'isVpn',        label: 'vpn',        color: UI.warning },
  { key: 'isDatacenter', label: 'datacenter', color: UI.warning },
  { key: 'isBogon',      label: 'bogon',      color: UI.textMuted },
  { key: 'isMobile',     label: 'mobile',     color: UI.info },
  { key: 'isSatellite',  label: 'satellite',  color: UI.info },
];

/**
 * ipapi.is reputation for one address, as inline badges.
 *
 * Renders nothing when the lookup has not resolved — absence means "not looked up yet",
 * which is different from clean, and a placeholder would blur the two. An explicit green
 * "clean" is shown only once a lookup came back with no flags set.
 */
export function IpRepBadges({ rep }: { rep: IpReputation | undefined }) {
  if (!rep) return null;
  if (rep.error) return <span title={`ipapi.is error: ${rep.error}`} style={{ marginLeft: 5, color: UI.warning, fontWeight: 600 }}>⚠ ipapi</span>;
  const active = IP_REP_FLAGS.filter(f => rep[f.key]);
  if (!active.length) return <span style={{ marginLeft: 5, color: UI.success, fontWeight: 600 }}>● clean</span>;
  return (
    <>
      {active.map(f => (
        <span
          key={f.label}
          title={f.key === 'isCrawler' && rep.crawlerName ? `crawler: ${rep.crawlerName}` : rep.companyName ?? undefined}
          style={{
            marginLeft: 4, fontSize: 9, fontWeight: 600, color: f.color,
            border: `1px solid ${f.color}66`, background: `${f.color}22`,
            borderRadius: 3, padding: '0 4px',
          }}
        >
          {f.label}
        </span>
      ))}
    </>
  );
}
