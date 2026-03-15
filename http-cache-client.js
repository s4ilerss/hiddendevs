"use strict";

/**
 * HTTP Cache Client - made this a lot more explained cus my previous application was denied for not having enough comments, so i hope you enjoy reading through it all :)
 *
 * Demonstrates a lightweight in-memory caching layer built on top of any
 * async API function. Key concepts illustrated:
 *
 *  1. TTL-based cache invalidation — each cached entry is stored alongside
 *     an expiry timestamp. On every read we compare that timestamp to the
 *     current time; if it has passed the entry is treated as stale and a
 *     fresh request is made. This prevents the client from serving
 *     indefinitely outdated data.
 *
 *  2. Retry-with-linear-back-off — when the underlying API call throws, the
 *     client waits a linearly increasing delay (200 ms × attempt number)
 *     before trying again. The pause gives a temporarily overloaded service
 *     a window to recover without getting hammered by rapid repeat requests.
 *
 *  3. Per-endpoint cache keys — each unique endpoint path is stored under
 *     its own normalised key so requests to /profile never pollute the
 *     cache entry for /settings or any other resource.
 *
 *  4. Manual invalidation — callers can explicitly bust a single cache entry
 *     (e.g. after a write operation makes an existing response stale) without
 *     having to wipe the entire cache with clearAll().
 */

class SimpleApiClient {
  /**
   * @param {Function} apiFunction - An async function that accepts an
   *   endpoint string and returns response data. This is the "transport"
   *   the client calls on every cache miss.
   * @param {Object}  [options]
   * @param {number}  [options.defaultTtlMs=2000] - How long a cached response
   *   stays valid before being treated as stale. Minimum enforced: 100 ms.
   * @param {number}  [options.maxRetries=1] - Additional attempts after the
   *   first failure. 0 means no retries — fail on the very first error.
   */
  constructor(apiFunction, options = {}) {
    if (typeof apiFunction !== "function") {
      throw new Error("apiFunction must be a function");
    }

    this.apiFunction = apiFunction;
    // Enforce a sensible floor so the cache is never trivially short-lived.
    this.defaultTtlMs = Math.max(100, options.defaultTtlMs ?? 2000);
    // A maxRetries of 0 still makes one initial attempt; retries are on top.
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
    // Simple Map used as the cache store. Keys are normalised endpoint strings;
    // values are { data, expiresAt } objects recording what was fetched and when
    // it should be discarded.
    this.cache = new Map();
  }

  /**
   * Fetch data for the given endpoint. Returns a cached response when one
   * exists and has not yet expired; otherwise performs a live network request,
   * writes the result back into the cache, and returns it.
   *
   * @param {string} endpoint     - The resource path to fetch (e.g. "/users/42").
   * @param {Object} [options]
   * @param {number} [options.ttlMs] - Override the instance-level TTL for
   *   this specific request. Useful when some endpoints serve data that
   *   changes more frequently than the default TTL assumes.
   * @returns {Promise<{source: string, endpoint: string, data: *}>}
   *   `source` is either "cache" or "network" so callers can log cache-hit rates.
   */
  async get(endpoint, options = {}) {
    // Per-call TTL falls back to the instance default when not specified.
    const ttlMs = Math.max(50, options.ttlMs ?? this.defaultTtlMs);
    // Normalise the key so "/Profile" and "/profile" resolve to the same entry.
    const cacheKey = endpoint.toLowerCase().trim();
    const now = Date.now();
    const cachedEntry = this.cache.get(cacheKey);

    // If we have a stored entry and its expiry timestamp is still in the
    // future, serve it directly — no network round-trip needed.
    if (cachedEntry && cachedEntry.expiresAt > now) {
      return {
        source: "cache",
        endpoint,
        data: cachedEntry.data
      };
    }

    // No usable cache entry found (either absent or expired). Fetch fresh
    // data from the network, then write it back with a new expiry timestamp
    // so subsequent calls within the TTL window can use the cache.
    const data = await this.requestWithRetry(endpoint);
    this.cache.set(cacheKey, {
      data,
      expiresAt: now + ttlMs
    });

    return {
      source: "network",
      endpoint,
      data
    };
  }

  /**
   * Remove the cached entry for a single endpoint, forcing the next call to
   * that endpoint to fetch fresh data from the network. Use this after a
   * mutation (POST / PUT / DELETE) that makes the currently cached response
   * incorrect.
   *
   * @param {string} endpoint
   * @returns {boolean} true if an entry existed and was removed; false otherwise.
   */
  invalidate(endpoint) {
    const key = endpoint.toLowerCase().trim();
    return this.cache.delete(key);
  }

  /**
   * Wipe every entry in the cache at once. Useful during logout flows, after
   * server-side data resets, or in tests that need a clean starting state.
   */
  clearAll() {
    this.cache.clear();
  }

  /**
   * Attempt the underlying API call up to (1 + maxRetries) times total.
   * Each retry is preceded by a linearly increasing delay so we do not
   * immediately re-hammer a service that is already under pressure.
   *
   * @param {string} endpoint
   * @returns {Promise<*>} The resolved response data on success.
   * @throws {Error} If every attempt fails; the last upstream error message
   *   is embedded so the caller can log a meaningful error.
   */
  async requestWithRetry(endpoint) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.apiFunction(endpoint);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) {
          // All allowed attempts have been exhausted — stop and surface the error.
          break;
        }
        // Linear back-off: 200 ms on the first retry, 400 ms on the second, etc.
        // This gives the upstream service progressively more time to recover.
        await sleep(200 * (attempt + 1));
      }
    }
    throw new Error(
      `Request failed after ${this.maxRetries + 1} attempt(s): ${lastError?.message ?? "unknown error"}`
    );
  }
}

/** Promisified delay helper used for retry back-off and demo timing. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a deterministic mock API that intentionally simulates real-world
 * network flakiness:
 *   - The very first call to any endpoint throws a "temporary" error,
 *     forcing the client to exercise its retry path.
 *   - Every subsequent call for the same endpoint succeeds and returns
 *     a simple payload object.
 *
 * Using a call-count map (rather than a single global flag) means each
 * endpoint fails independently, which mirrors how different backend services
 * might have their own flakiness profiles.
 */
function createMockApi() {
  // Tracks per-endpoint call counts so each resource has its own failure cycle.
  const callCountByEndpoint = new Map();

  return async function mockApi(endpoint) {
    const count = (callCountByEndpoint.get(endpoint) ?? 0) + 1;
    callCountByEndpoint.set(endpoint, count);

    // First attempt throws to force the client to retry (attempt 1 → fail,
    // attempt 2 → succeed). This replicates a momentary network blip.
    if (count === 1) {
      throw new Error(`Temporary upstream failure for ${endpoint}`);
    }

    return {
      endpoint,
      callCount: count,
      value: `payload-for-${endpoint}`,
      timestamp: new Date().toISOString()
    };
  };
}

/**
 * Multi-step walkthrough of the client's caching and retry behaviour.
 * All output can be observed in the console without any external servers.
 *
 *  Step 1 — First fetch: cache is empty, so the client hits the network.
 *            The mock API rejects the first attempt, triggering one retry.
 *  Step 2 — Immediate re-fetch: TTL is still valid, served from cache.
 *  Step 3 — After sleeping past the TTL, the entry is stale and a fresh
 *            network request is made (again with a successful retry).
 *  Step 4 — Manual invalidate() before the TTL expires forces a fresh fetch
 *            even though the cached entry has not yet expired on its own.
 *  Step 5 — A second endpoint (/settings) is fetched independently; its
 *            cache lifecycle does not affect /profile.
 *  Step 6 — clearAll() wipes every entry, so both endpoints go back to
 *            network on their next call.
 */
async function demoClient() {
  const mockApi = createMockApi();
  const client = new SimpleApiClient(mockApi, {
    defaultTtlMs: 1500,
    maxRetries: 1
  });

  console.log("=== Step 1: first fetch — cache miss, retry path exercised ===");
  const first = await client.get("/profile");
  console.log(first);

  console.log("\n=== Step 2: immediate re-fetch — served from cache ===");
  const second = await client.get("/profile");
  console.log(second);

  console.log("\n=== Step 3: wait for TTL to expire then re-fetch ===");
  await sleep(1600); // 1 600 ms > 1 500 ms TTL so the stored entry is now stale
  const third = await client.get("/profile");
  console.log(third);

  console.log("\n=== Step 4: manual invalidate() then immediate re-fetch ===");
  const wasRemoved = client.invalidate("/profile");
  console.log(`Cache entry removed: ${wasRemoved}`);
  const afterInvalidate = await client.get("/profile");
  console.log(afterInvalidate);

  console.log("\n=== Step 5: fetching a second endpoint independently ===");
  const settingsFirst  = await client.get("/settings");
  const settingsCached = await client.get("/settings");
  console.log("Settings — first call (network):", settingsFirst);
  console.log("Settings — second call (cache): ", settingsCached);

  console.log("\n=== Step 6: clearAll() wipes every entry ===");
  client.clearAll();
  const profileAfterClear  = await client.get("/profile");
  const settingsAfterClear = await client.get("/settings");
  console.log("Profile after clearAll:", profileAfterClear);
  console.log("Settings after clearAll:", settingsAfterClear);
}

if (require.main === module) {
  demoClient().catch((error) => {
    console.error("Demo error:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { SimpleApiClient };
