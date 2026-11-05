/**
 * A one-shot request from App (a tray click, another page) to a page that may not be
 * mounted yet — its tab was closed. A request with no listener is held and handed to the
 * next subscriber instead of being lost; a later request replaces a held one.
 */
export function createHandoff<T>() {
  let pending: { value: T } | null = null;
  const listeners = new Set<(value: T) => void>();
  return {
    request(value: T): void {
      if (!listeners.size) {
        pending = { value };
        return;
      }
      listeners.forEach(cb => cb(value));
    },
    /** Returns an unsubscribe. A held request is delivered to `cb` straight away. */
    subscribe(cb: (value: T) => void): () => void {
      listeners.add(cb);
      if (pending) {
        const { value } = pending;
        pending = null;
        cb(value);
      }
      return () => { listeners.delete(cb); };
    },
  };
}
