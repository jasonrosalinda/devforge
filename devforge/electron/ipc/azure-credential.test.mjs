import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createCachingCredential, sharedCredential, resetCredential } = require('./azure-credential.cjs');

const MIN = 60_000;

describe('createCachingCredential', () => {
  const token = (value, expiresInMs) => ({ token: value, expiresOnTimestamp: Date.now() + expiresInMs });

  it('reuses a token until 5 minutes before it expires, then fetches a new one', async () => {
    vi.useFakeTimers();
    try {
      const inner = { getToken: vi.fn().mockResolvedValueOnce(token('a', 60 * MIN)).mockResolvedValueOnce(token('b', 60 * MIN)) };
      const cred = createCachingCredential(inner);
      expect((await cred.getToken('scope')).token).toBe('a');
      vi.advanceTimersByTime(54 * MIN);
      expect((await cred.getToken('scope')).token).toBe('a');
      vi.advanceTimersByTime(2 * MIN);
      expect((await cred.getToken('scope')).token).toBe('b');
      expect(inner.getToken).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one in-flight request between concurrent callers', async () => {
    const inner = { getToken: vi.fn().mockResolvedValue(token('a', 60 * MIN)) };
    const cred = createCachingCredential(inner);
    const [x, y] = await Promise.all([cred.getToken('scope'), cred.getToken('scope')]);
    expect(x).toBe(y);
    expect(inner.getToken).toHaveBeenCalledTimes(1);
  });

  it('keeps scopes apart, whether passed as a string or an array', async () => {
    const inner = { getToken: vi.fn(async (s) => token(String(s), 60 * MIN)) };
    const cred = createCachingCredential(inner);
    await cred.getToken('arm');
    await cred.getToken(['arm']);
    await cred.getToken('insights');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  it("treats MetricsQueryClient's double-slash scope as the same resource", async () => {
    const inner = { getToken: vi.fn(async () => token('a', 60 * MIN)) };
    const cred = createCachingCredential(inner);
    await cred.getToken('https://management.azure.com/.default');
    await cred.getToken(['https://management.azure.com//.default']);
    expect(inner.getToken).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failure, so the next call tries again', async () => {
    const inner = { getToken: vi.fn().mockRejectedValueOnce(new Error('az login')).mockResolvedValueOnce(token('a', 60 * MIN)) };
    const cred = createCachingCredential(inner);
    await expect(cred.getToken('scope')).rejects.toThrow('az login');
    expect((await cred.getToken('scope')).token).toBe('a');
  });
});

describe('sharedCredential', () => {
  it('hands every caller the same credential, so one token cache serves all modules', () => {
    expect(sharedCredential()).toBe(sharedCredential());
  });

  it('starts a fresh credential (empty token cache) only after resetCredential', () => {
    const before = sharedCredential();
    resetCredential();
    const after = sharedCredential();
    expect(after).not.toBe(before);
    expect(sharedCredential()).toBe(after);
  });
});
