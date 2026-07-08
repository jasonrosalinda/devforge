const CACHE_KEY = 'devforge_ipapi_cache_v1';
const SUCCESS_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — reputation is stable, minimize API calls
const ERROR_TTL_MS = 60 * 60 * 1000; // 1 hour — allow retry after transient/API errors

export interface IpReputation {
  ip: string;
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

async function fetchReputation(ip: string, apiKey: string | undefined): Promise<IpReputation> {
  // Routed through the main process to keep the API key off the renderer's network tab.
  try {
    const data = await window.electronAPI.ipapi.lookup({ ip, apiKey: apiKey ?? '' });
    if (!data.success) {
      return { ip, isCrawler: false, isDatacenter: false, isProxy: false, isVpn: false, isTor: false, isAbuser: false, isBot: false, crawlerName: null, companyName: null, checkedAt: Date.now(), error: data.error || 'Lookup failed' };
    }
    const isCrawler = Boolean(data.isCrawler);
    const isDatacenter = Boolean(data.isDatacenter);
    const isProxy = Boolean(data.isProxy);
    const isVpn = Boolean(data.isVpn);
    const isTor = Boolean(data.isTor);
    const isAbuser = Boolean(data.isAbuser);
    const isBot = isCrawler || isDatacenter || isProxy || isVpn || isTor || isAbuser;
    return { ip, isCrawler, isDatacenter, isProxy, isVpn, isTor, isAbuser, isBot, crawlerName: data.crawlerName ?? null, companyName: data.companyName ?? null, checkedAt: Date.now() };
  } catch (err) {
    return { ip, isCrawler: false, isDatacenter: false, isProxy: false, isVpn: false, isTor: false, isAbuser: false, isBot: false, crawlerName: null, companyName: null, checkedAt: Date.now(), error: err instanceof Error ? err.message : 'IPC error' };
  }
}

// Cache-first IP reputation lookup — only calls ipapi.is for IPs not already cached (fresh) in localStorage.
// apiKey is optional: ipapi.is serves a free tier (rate-limited by caller IP) without one.
export async function getIpReputation(ip: string, apiKey: string | undefined): Promise<IpReputation | null> {
  if (!ip || isPrivateIp(ip)) return null;

  const cache = readCache();
  const cached = cache[ip];
  if (isFresh(cached)) return cached;

  const pending = inFlight.get(ip);
  if (pending) return pending;

  const promise = fetchReputation(ip, apiKey).then(result => {
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
