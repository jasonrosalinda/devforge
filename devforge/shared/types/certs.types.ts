/** Cert & Domain Expiry (electron/ipc/cert-expiry.cjs). */

export type CertStatus = 'ok' | 'warning' | 'critical' | 'expired';

export type CertTrust = 'ok' | 'host' | 'chain';

export interface CertResult {
    appKey: string;
    host: string;
    /** Where the host came from: Settings platform URL, or the web app's / API's Azure bindings. */
    site: 'url' | 'web' | 'api';
    validTo?: string;
    daysLeft?: number;
    status?: CertStatus;
    issuer?: string;
    sans?: string[];
    /** Node's verdict; false for any problem, including plain expiry. Read `trust` instead. */
    authorized?: boolean;
    authorizationError?: string;
    /**
     * 'ok': trusted, or only expired / not yet valid, so the dates are real.
     * 'host': the certificate doesn't name this host.
     * 'chain': this machine can't trust it (self-signed, or a TLS-inspecting proxy), so the dates may not be the site's.
     */
    trust?: CertTrust;
    error?: string;
}

export interface ICertsAPI {
    check: (opts: { appKeys: string[]; config: unknown }) => Promise<{ results: CertResult[]; checkedAt?: string; error?: string }>;
}
