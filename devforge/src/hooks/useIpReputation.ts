import { useEffect, useState } from 'react';
import { getCachedIpReputation, getIpReputation, type IpReputation } from '@/lib/ipapiIs';

// Resolves bot/crawler reputation for a list of IPs via ipapi.is, cache-first (localStorage) to minimize API calls
export function useIpReputation(ips: string[], apiKey: string | undefined): Record<string, IpReputation> {
  const [result, setResult] = useState<Record<string, IpReputation>>({});
  const uniqueKey = Array.from(new Set(ips.filter(Boolean))).sort().join(',');

  useEffect(() => {
    if (!uniqueKey) return;
    const uniqueIps = uniqueKey.split(',');
    let cancelled = false;

    // Serve cached hits immediately
    const cachedNow: Record<string, IpReputation> = {};
    for (const ip of uniqueIps) {
      const cached = getCachedIpReputation(ip);
      if (cached) cachedNow[ip] = cached;
    }
    if (Object.keys(cachedNow).length) {
      setResult(prev => ({ ...prev, ...cachedNow }));
    }

    const toFetch = uniqueIps.filter(ip => !cachedNow[ip]);
    if (!toFetch.length) return;

    (async () => {
      for (const ip of toFetch) {
        const rep = await getIpReputation(ip, apiKey);
        if (cancelled || !rep) continue;
        setResult(prev => ({ ...prev, [ip]: rep }));
      }
    })();

    return () => { cancelled = true; };
  }, [uniqueKey, apiKey]);

  return result;
}
