// "Reload App Health Check to now", raised when a tray alert is clicked. App opens
// the tab and calls requestHealthCheckReload(); the page may not be mounted yet (the
// tab was closed), so a request with no listener is held and handed to the next page
// that subscribes, instead of being lost.

let pending = false;
const listeners = new Set<() => void>();

export function requestHealthCheckReload(): void {
  if (!listeners.size) {
    pending = true;
    return;
  }
  listeners.forEach(cb => cb());
}

/** Returns an unsubscribe. A held request is delivered to `cb` straight away. */
export function onHealthCheckReload(cb: () => void): () => void {
  listeners.add(cb);
  if (pending) {
    pending = false;
    cb();
  }
  return () => { listeners.delete(cb); };
}
