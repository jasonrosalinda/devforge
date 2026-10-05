// Recently-loaded URL history (plain localStorage — just URLs, not secrets).

const MAX_URLS = 20;

export function loadUrlHistory(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Saves `url` as the most recent entry and returns the updated list. */
export function pushUrlHistory(key: string, url: string): string[] {
  const next = [url, ...loadUrlHistory(key).filter(u => u !== url)].slice(0, MAX_URLS);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore quota */ }
  return next;
}
