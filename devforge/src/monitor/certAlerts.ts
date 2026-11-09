// Tray alert for TLS certificates close to expiry. Pure; monitorMain runs the daily check.
import type { CertResult, CertStatus } from '@shared/types/certs.types';

/** Certificates are checked this often: expiry moves in days, not minutes. */
export const CERT_CHECK_MS = 24 * 3_600_000;

const ALERTING: CertStatus[] = ['critical', 'expired'];

/** Soonest expiry first; hosts that failed or can't be verified go last. */
export function sortCerts(rows: CertResult[]): CertResult[] {
  const rank = (r: CertResult) => (r.daysLeft == null || r.trust === 'chain' ? Number.POSITIVE_INFINITY : r.daysLeft);
  return [...rows].sort((a, b) => rank(a) - rank(b) || a.host.localeCompare(b.host));
}

/**
 * One line per host that has just become critical (< 14 days) or expired since the last
 * check. A host whose chain this machine can't trust (a TLS-inspecting proxy answers
 * instead) is skipped: its date may be the proxy's, not the site's. An expired certificate
 * still counts: Node marks it unauthorized, but its dates are real.
 * shortcut: state is in memory, so a restart re-alerts on a host that is still critical; persist it if that gets noisy.
 */
export function certAlertLines(
  prev: Record<string, CertStatus | undefined>,
  results: CertResult[],
  label: (appKey: string) => string,
): { next: Record<string, CertStatus | undefined>; lines: string[] } {
  const next = { ...prev };
  const lines: string[] = [];
  for (const r of results) {
    if (!r.status || r.trust === 'chain') continue;
    const was = prev[r.host];
    next[r.host] = r.status;
    if (!ALERTING.includes(r.status) || was === r.status) continue;
    lines.push(r.status === 'expired'
      ? `${label(r.appKey)}: ${r.host} certificate has EXPIRED`
      : `${label(r.appKey)}: ${r.host} certificate expires in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`);
  }
  return { next, lines };
}
