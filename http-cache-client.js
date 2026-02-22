"use strict";

/**
 * quick API client demo:
 * - retries once if the call fails
 * - keeps successful responses in a short cache
 * i kept this intentionally simple so it's easy to walk through on video
 */

class SimpleApiClient {
  constructor(apiFunction, options = {}) {
    if (typeof apiFunction !== "function") {
      throw new Error("apiFunction must be a function");
    }

    // Store settings up front so behavior is predictable in the demo.
    this.apiFunction = apiFunction;
    this.defaultTtlMs = Math.max(100, options.defaultTtlMs ?? 2000);
    this.maxRetries = Math.max(0, options.maxRetries ?? 1);
    this.cache = new Map();
  }

  async get(endpoint, options = {}) {
    const ttlMs = Math.max(50, options.ttlMs ?? this.defaultTtlMs);
    const cacheKey = endpoint.toLowerCase().trim();
    const now = Date.now();
    const cachedEntry = this.cache.get(cacheKey);

    // If cache is still fresh, return it right away.
    if (cachedEntry && cachedEntry.expiresAt > now) {
      return {
        source: "cache",
        endpoint,
        data: cachedEntry.data
      };
    }

    // Cache is missing/expired, so fetch again and refresh the cache.
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

  invalidate(endpoint) {
    // Handy when data changes and we need a fresh fetch next time.
    const key = endpoint.toLowerCase().trim();
    return this.cache.delete(key);
  }

  clearAll() {
    this.cache.clear();
  }

  async requestWithRetry(endpoint) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.apiFunction(endpoint);
      } catch (error) {
        lastError = error;
        if (attempt === this.maxRetries) {
          break;
        }
        // Short wait before retrying to avoid hammering a failing service.
        await sleep(200 * (attempt + 1));
      }
    }
    throw new Error(`Request failed: ${lastError?.message ?? "unknown error"}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockApi() {
  // Track call counts so we can fake "first call fails" behavior.
  const callCountByEndpoint = new Map();

  return async function mockApi(endpoint) {
    const count = (callCountByEndpoint.get(endpoint) ?? 0) + 1;
    callCountByEndpoint.set(endpoint, count);

    // First call fails on purpose, next one works.
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

async function demoClient() {
  const client = new SimpleApiClient(createMockApi(), {
    defaultTtlMs: 1500,
    maxRetries: 1
  });

  // 1) First call goes to network (with one retry).
  const first = await client.get("/profile");
  // 2) Second call comes from cache because TTL is still valid.
  const second = await client.get("/profile");
  // 3) Wait for TTL to expire, then we hit network again.
  await sleep(1600);
  const third = await client.get("/profile");

  console.log("First call (network with retry):", first);
  console.log("Second call (cache hit):", second);
  console.log("Third call (network after TTL):", third);
}

if (require.main === module) {
  demoClient().catch((error) => {
    console.error("Demo error:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { SimpleApiClient };
