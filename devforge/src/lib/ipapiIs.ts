const CACHE_KEY = 'devforge_ipapi_cache_v1';
const SUCCESS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — reputation is stable, minimize API calls
const ERROR_TTL_MS = 60 * 60 * 1000; // 1 hour — allow retry after transient/API errors

export interface IpReputation {
  ip: string;
  isBogon: boolean;
  isMobile: boolean;
  isSatellite: boolean;
  isCrawler: boolean;
  isDatacenter: boolean;
  isProxy: boolean;
  isVpn: boolean;
  isTor: boolean;
  isAbuser: boolean;
  isBot: boolean; // any of the above flags
  crawlerName: string | null;
  companyName: string | null;
  checkedAt: number;
  error?: string;
}

type IpapiCache = Record<string, IpReputation>;

function readCache(): IpapiCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) as IpapiCache : {};
  } catch {
    return {};
  }
}

function writeCache(cache: IpapiCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full/unavailable — skip caching silently
  }
}

function isFresh(entry: IpReputation | undefined): entry is IpReputation {
  if (!entry) return false;
  const ttl = entry.error ? ERROR_TTL_MS : SUCCESS_TTL_MS;
  return Date.now() - entry.checkedAt < ttl;
}

// Skip lookups for private/reserved/loopback ranges — never externally routable, never a crawler
function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^fc00:|^fe80:/i.test(ip)) return true;
  return false;
}

const inFlight = new Map<string, Promise<IpReputation>>();

async function fetchReputation(ip: string): Promise<IpReputation> {
  // Routed through the main process — ipapi.is free tier, no API key required.
  try {
    const data = await window.electronAPI.ipapi.lookup({ ip });
    if (!data.success) {
      return { ip, isBogon: false, isMobile: false, isSatellite: false, isCrawler: false, isDatacenter: false, isProxy: false, isVpn: false, isTor: false, isAbuser: false, isBot: false, crawlerName: null, companyName: null, checkedAt: Date.now(), error: data.error || 'Lookup failed' };
    }
    const isBogon = Boolean(data.isBogon);
    const isMobile = Boolean(data.isMobile);
    const isSatellite = Boolean(data.isSatellite);
    const isCrawler = Boolean(data.isCrawler);
    const isDatacenter = Boolean(data.isDatacenter);
    const isProxy = Boolean(data.isProxy);
    const isVpn = Boolean(data.isVpn);
    const isTor = Boolean(data.isTor);
    const isAbuser = Boolean(data.isAbuser);
    const isBot = isBogon || isMobile || isSatellite || isCrawler || isDatacenter || isProxy || isVpn || isTor || isAbuser;
    return { ip, isBogon, isMobile, isSatellite, isCrawler, isDatacenter, isProxy, isVpn, isTor, isAbuser, isBot, crawlerName: data.crawlerName ?? null, companyName: data.companyName ?? null, checkedAt: Date.now() };
  } catch (err) {
    return { ip, isBogon: false, isMobile: false, isSatellite: false, isCrawler: false, isDatacenter: false, isProxy: false, isVpn: false, isTor: false, isAbuser: false, isBot: false, crawlerName: null, companyName: null, checkedAt: Date.now(), error: err instanceof Error ? err.message : 'IPC error' };
  }
}

// Cache-first IP reputation lookup — only calls ipapi.is for IPs not already cached (fresh) in localStorage.
export async function getIpReputation(ip: string): Promise<IpReputation | null> {
  if (!ip || isPrivateIp(ip)) return null;

  const cache = readCache();
  const cached = cache[ip];
  if (isFresh(cached)) return cached;

  const pending = inFlight.get(ip);
  if (pending) return pending;

  const promise = fetchReputation(ip).then(result => {
    const latest = readCache();
    latest[ip] = result;
    writeCache(latest);
    inFlight.delete(ip);
    return result;
  });
  inFlight.set(ip, promise);
  return promise;
}

export function getCachedIpReputation(ip: string): IpReputation | null {
  const cached = readCache()[ip];
  return isFresh(cached) ? cached : null;
}
