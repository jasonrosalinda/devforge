import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestHealthCheckReload, onHealthCheckReload } from './health-check-reload';

describe('health-check reload handoff', () => {
  const unsubs: Array<() => void> = [];
  afterEach(() => { unsubs.splice(0).forEach(u => u()); });

  it('delivers a request straight to a mounted page', () => {
    const cb = vi.fn();
    unsubs.push(onHealthCheckReload(cb));
    requestHealthCheckReload();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('holds a request made before the page mounts and delivers it once on mount', () => {
    requestHealthCheckReload();
    const first = vi.fn();
    unsubs.push(onHealthCheckReload(first));
    expect(first).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    unsubs.push(onHealthCheckReload(second));
    expect(second).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', () => {
    const cb = vi.fn();
    onHealthCheckReload(cb)();
    requestHealthCheckReload();
    expect(cb).not.toHaveBeenCalled();
    // The request was held instead, so clear it for the next test.
    unsubs.push(onHealthCheckReload(() => {}));
  });
});
