import { useCallback, useEffect, useState } from 'react';
import { tokenBlocked, type TokenStatus } from '@/components/release-pilot/tokenStatusPill';

interface AtlassianCreds {
  confluenceBaseUrl: string;
  email: string;
  apiToken: string;
}

/**
 * Confluence access state for the runbook pages: the browser session (needed
 * for screenshots) and the API token (needed for every page fetch).
 */
export function useConfluenceConnection({ confluenceBaseUrl, email, apiToken }: AtlassianCreds) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tokenStatus, setTokenStatus] = useState<TokenStatus>({ state: 'checking' });

  // Check Confluence session status on mount / when base URL changes.
  useEffect(() => {
    if (!confluenceBaseUrl) { setConnected(false); return; }
    window.electronAPI?.confluence?.authStatus({ baseUrl: confluenceBaseUrl })
      .then(s => setConnected(!!s?.connected))
      .catch(() => setConnected(false));
  }, [confluenceBaseUrl]);

  // Validate the API token itself (separate from the browser session — the page
  // fetch uses the token, so an expired one fails every load).
  const checkToken = useCallback(async () => {
    if (!confluenceBaseUrl) { setTokenStatus({ state: 'no-base' }); return; }
    setTokenStatus({ state: 'checking' });
    try {
      const s = await window.electronAPI?.confluence?.tokenStatus({ baseUrl: confluenceBaseUrl, email, apiToken });
      setTokenStatus((s as TokenStatus) ?? { state: 'error', detail: 'Confluence bridge unavailable.' });
    } catch (e) {
      setTokenStatus({ state: 'error', detail: e instanceof Error ? e.message : String(e) });
    }
  }, [confluenceBaseUrl, email, apiToken]);

  useEffect(() => { void checkToken(); }, [checkToken]);

  const connect = useCallback(async () => {
    if (!confluenceBaseUrl || connecting) return;
    setConnecting(true);
    try {
      await window.electronAPI?.confluence?.login({ baseUrl: confluenceBaseUrl });
      const s = await window.electronAPI?.confluence?.authStatus({ baseUrl: confluenceBaseUrl });
      setConnected(!!s?.connected);
    } finally {
      setConnecting(false);
    }
  }, [confluenceBaseUrl, connecting]);

  const disconnect = useCallback(async () => {
    await window.electronAPI?.confluence?.logout();
    setConnected(false);
  }, []);

  return {
    connected,
    connecting,
    tokenStatus,
    // A network-level check failure ('error') still allows a try — the page fetch
    // may work where the probe didn't. A rejected token never will.
    tokenDead: tokenBlocked(tokenStatus.state) && tokenStatus.state !== 'error',
    checkToken,
    connect,
    disconnect,
  };
}

export type ConfluenceConnection = ReturnType<typeof useConfluenceConnection>;
