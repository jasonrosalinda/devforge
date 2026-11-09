import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mapPool, makeStickyOrder } = require('./pool.cjs');

describe('mapPool', () => {
  it('keeps input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([30, 10, 20, 5], 2, async (ms, i) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running -= 1;
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });
});

describe('makeStickyOrder', () => {
  it('tries the given order until something works', () => {
    expect(makeStickyOrder(['token', 'session']).current()).toEqual(['token', 'session']);
  });

  it('puts the path that last worked first', () => {
    const order = makeStickyOrder(['token', 'session']);
    order.succeeded('session');
    expect(order.current()).toEqual(['session', 'token']);
    order.succeeded('token');
    expect(order.current()).toEqual(['token', 'session']);
  });
});
