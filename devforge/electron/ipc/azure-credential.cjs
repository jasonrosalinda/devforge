// One Azure credential for the whole main process. Every module used to keep its own
// (or build a fresh one per call), and each one spawns `az` (~1–3 s on Windows) per
// scope the first time it is asked. Sharing one caching credential means a token is
// fetched once and reused everywhere until close to expiry.

const trace = require('./trace.cjs');

// Refetch this long before expiry, so a token never lapses mid-fetch.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const ARM_SCOPE = 'https://management.azure.com/.default';
const AI_SCOPE = 'https://api.applicationinsights.io/.default';

/**
 * A TokenCredential that keeps each scope's token until close to expiry. Concurrent
 * callers share one request; a failure is not kept, so the next call tries again
 * (a fresh `az login` takes effect without a reset).
 */
function createCachingCredential(inner) {
  const tokens = new Map();
  return {
    getToken(scopes, options) {
      // MetricsQueryClient asks for "https://management.azure.com//.default" — the same
      // resource as the single-slash form the handlers use.
      const key = [].concat(scopes).map(s => s.replace(/\/+\.default$/, '/.default')).join(' ');
      const hit = tokens.get(key);
      if (hit && (hit.pending || hit.expiresOn - Date.now() > TOKEN_REFRESH_MARGIN_MS)) {
        trace.log(`token ${key} hit`);
        return hit.promise;
      }
      const started = Date.now();
      const promise = Promise.resolve(inner.getToken(scopes, options));
      const entry = { promise, pending: true, expiresOn: 0 };
      tokens.set(key, entry);
      promise.then(
        (t) => {
          entry.pending = false;
          entry.expiresOn = t?.expiresOnTimestamp ?? 0;
          trace.log(`token ${key} miss ${Date.now() - started}ms`);
        },
        () => {
          if (tokens.get(key) === entry) tokens.delete(key);
          trace.log(`token ${key} failed ${Date.now() - started}ms`);
        },
      );
      return promise;
    },
  };
}

/** Azure CLI first: skips DefaultAzureCredential's env / workload / managed-identity probes on a dev machine. */
function defaultInner() {
  const { AzureCliCredential, ChainedTokenCredential, DefaultAzureCredential } = require('@azure/identity');
  return new ChainedTokenCredential(new AzureCliCredential(), new DefaultAzureCredential());
}

let shared = null;

function sharedCredential() {
  return shared ?? (shared = createCachingCredential(defaultInner()));
}

/** Drop every cached token, e.g. after the user signs in to another account and clicks Re-check. */
function resetCredential() {
  shared = null;
}

/** Fetch the ARM and App Insights tokens in the background so the first page load doesn't wait on `az`. */
function warmTokens() {
  const cred = sharedCredential();
  for (const scope of [ARM_SCOPE, AI_SCOPE]) {
    Promise.resolve(cred.getToken(scope)).catch(() => { /* not signed in yet: the page will say so */ });
  }
}

module.exports = {
  createCachingCredential,
  sharedCredential,
  resetCredential,
  warmTokens,
  ARM_SCOPE,
  AI_SCOPE,
};
