import { describe, expect, it } from 'vitest';
import type { CertResult } from '@shared/types/certs.types';
import { certAlertLines, sortCerts } from './certAlerts';

const r = (host: string, status: NonNullable<CertResult['status']>, daysLeft: number, trust: NonNullable<CertResult['trust']> = 'ok'): CertResult =>
  ({ appKey: 'web', host, site: 'url', status, daysLeft, trust, authorized: trust === 'ok' && status !== 'expired' });
const label = () => 'MEDU';

describe('certAlertLines', () => {
  it('alerts once when a host turns critical, again when it expires, never for ok / warning', () => {
    const first = certAlertLines({}, [r('a.com', 'critical', 10), r('b.com', 'warning', 20), r('c.com', 'ok', 90)], label);
    expect(first.lines).toEqual(['MEDU: a.com certificate expires in 10 days']);
    const again = certAlertLines(first.next, [r('a.com', 'critical', 9)], label);
    expect(again.lines).toEqual([]);
    const expired = certAlertLines(again.next, [r('a.com', 'expired', -1)], label);
    expect(expired.lines).toEqual(['MEDU: a.com certificate has EXPIRED']);
    expect(certAlertLines(expired.next, [r('a.com', 'expired', -2)], label).lines).toEqual([]);
  });

  it('re-arms after a renewal', () => {
    const renewed = certAlertLines({ 'a.com': 'critical' }, [r('a.com', 'ok', 89)], label);
    expect(renewed.lines).toEqual([]);
    expect(certAlertLines(renewed.next, [r('a.com', 'critical', 1)], label).lines).toEqual(['MEDU: a.com certificate expires in 1 day']);
  });

  it('sorts soonest expiry first; a host mismatch keeps its place, untrusted chains and failures go last', () => {
    const rows = [r('ok.com', 'ok', 90), { appKey: 'web', host: 'err.com', site: 'url' as const, error: 'x' }, r('proxy.com', 'ok', 1, 'chain'), r('soon.com', 'critical', 3), r('wrong.com', 'ok', 40, 'host')];
    expect(sortCerts(rows).map(x => x.host)).toEqual(['soon.com', 'wrong.com', 'ok.com', 'err.com', 'proxy.com']);
  });

  it('alerts on a real expired certificate even though Node marks it unauthorized', () => {
    const expired: CertResult = { appKey: 'web', host: 'a.com', site: 'url', status: 'expired', daysLeft: -3, authorized: false, authorizationError: 'CERT_HAS_EXPIRED', trust: 'ok' };
    expect(certAlertLines({}, [expired], label).lines).toEqual(['MEDU: a.com certificate has EXPIRED']);
  });

  it('skips hosts it cannot verify and failed checks', () => {
    const res = certAlertLines({}, [r('proxy.com', 'expired', -5, 'chain'), { appKey: 'web', host: 'x.com', site: 'url', error: 'Host not found.' }], label);
    expect(res.lines).toEqual([]);
    expect(res.next).toEqual({});
  });
});
