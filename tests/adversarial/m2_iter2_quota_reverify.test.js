/**
 * tests/adversarial/m2_iter2_quota_reverify.test.js
 *
 * Empirical Challenger Verification Suite for Milestone 2 Iteration 2:
 * Rigorously verifies:
 * 1. Uncached searches accurately consume 100 quota units across all upstream response conditions:
 *    - Upstream returns HTTP 429 Too Many Requests (Quota Exceeded)
 *    - Upstream returns HTTP 403 Forbidden
 *    - Upstream returns HTTP 500 Internal Server Error
 *    - Upstream fetch rejects with Network Error / Timeout (ETIMEDOUT)
 *    - Upstream returns HTTP 200 OK (live success)
 *    - Pure mock mode / missing API key
 * 2. Cached searches consume 0 quota units:
 *    - Exact query repeat (cache hit)
 *    - Case-insensitive & trimmed query repeat
 *    - Burst repeat cache hits (20 sequential calls)
 * 3. Invalid queries consume 0 quota units (fail early before quota accounting).
 * 4. End-to-end HTTP integration over Express server (/api/search + /api/quota).
 */

process.env.TEST_PORT = '3089';
process.env.TEST_BASE_URL = 'http://127.0.0.1:3089';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const quotaService = require('../../src/services/quota');
const youtubeService = require('../../src/services/youtube');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

describe('Milestone 2 Iteration 2: Empirical Quota & Search Accounting Verification', () => {
  let serverInfo = null;

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
    } catch {
      serverInfo = null;
    }
  });

  after(async () => {
    await stopServer();
  });

  // ==========================================================================
  // 1. UPSTREAM ERROR & RATE-LIMITING CONDITIONS (100 UNITS CONSUMED)
  // ==========================================================================
  describe('1. Uncached Search Quota Accounting Under Upstream Failures', () => {

    it('1.1: Upstream HTTP 429 (Rate Limited / Quota Exceeded) consumes exactly 100 units', async () => {
      const origFetch = global.fetch;
      const origMock = process.env.YOUTUBE_MOCK_MODE;
      const origKey = process.env.YOUTUBE_API_KEY;

      process.env.YOUTUBE_MOCK_MODE = 'false';
      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyFor429TestMockVerification123';

      let fetchInvoked = false;
      global.fetch = async () => {
        fetchInvoked = true;
        return {
          ok: false,
          status: 429,
          json: async () => ({
            error: {
              code: 429,
              message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Search Queries' and limit 'Search Queries per day'",
              status: "RESOURCE_EXHAUSTED"
            }
          })
        };
      };

      try {
        const initialStatus = quotaService.getQuotaStatus();
        const query = `Empirical429_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const result = await youtubeService.searchYouTube(query);

        assert.strictEqual(fetchInvoked, true, 'Upstream fetch must have been invoked');
        assert.strictEqual(result.fromCache, false, 'Uncached search must return fromCache: false');
        assert.strictEqual(result.isMock, true, '429 fallback must return mock tracks');
        assert.ok(Array.isArray(result.items) && result.items.length > 0, 'Items must be non-empty');

        const postStatus = quotaService.getQuotaStatus();
        const diff = postStatus.used - initialStatus.used;

        assert.strictEqual(diff, 100, `Expected exactly 100 quota units consumed on 429, got ${diff}`);
        assert.strictEqual(postStatus.used + postStatus.remaining, 10000);
      } finally {
        global.fetch = origFetch;
        process.env.YOUTUBE_MOCK_MODE = origMock;
        process.env.YOUTUBE_API_KEY = origKey;
      }
    });

    it('1.2: Upstream HTTP 403 (Quota Forbidden) consumes exactly 100 units', async () => {
      const origFetch = global.fetch;
      const origMock = process.env.YOUTUBE_MOCK_MODE;
      const origKey = process.env.YOUTUBE_API_KEY;

      process.env.YOUTUBE_MOCK_MODE = 'false';
      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyFor403TestMockVerification123';

      let fetchInvoked = false;
      global.fetch = async () => {
        fetchInvoked = true;
        return {
          ok: false,
          status: 403,
          json: async () => ({
            error: {
              code: 403,
              message: "The request cannot be completed because you have exceeded your quota.",
              status: "PERMISSION_DENIED"
            }
          })
        };
      };

      try {
        const initialStatus = quotaService.getQuotaStatus();
        const query = `Empirical403_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const result = await youtubeService.searchYouTube(query);

        assert.strictEqual(fetchInvoked, true);
        assert.strictEqual(result.fromCache, false);
        assert.strictEqual(result.isMock, true);
        assert.ok(result.items.length > 0);

        const postStatus = quotaService.getQuotaStatus();
        const diff = postStatus.used - initialStatus.used;

        assert.strictEqual(diff, 100, `Expected exactly 100 quota units consumed on 403, got ${diff}`);
      } finally {
        global.fetch = origFetch;
        process.env.YOUTUBE_MOCK_MODE = origMock;
        process.env.YOUTUBE_API_KEY = origKey;
      }
    });

    it('1.3: Upstream HTTP 500 (Internal Server Error) falls back and consumes exactly 100 units', async () => {
      const origFetch = global.fetch;
      const origMock = process.env.YOUTUBE_MOCK_MODE;
      const origKey = process.env.YOUTUBE_API_KEY;

      process.env.YOUTUBE_MOCK_MODE = 'false';
      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyFor500TestMockVerification123';

      let fetchInvoked = false;
      global.fetch = async () => {
        fetchInvoked = true;
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: { message: "Internal Server Error" } })
        };
      };

      try {
        const initialStatus = quotaService.getQuotaStatus();
        const query = `Empirical500_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const result = await youtubeService.searchYouTube(query);

        assert.strictEqual(fetchInvoked, true);
        assert.strictEqual(result.fromCache, false);
        assert.strictEqual(result.isMock, true);
        assert.ok(result.items.length > 0);

        const postStatus = quotaService.getQuotaStatus();
        const diff = postStatus.used - initialStatus.used;

        assert.strictEqual(diff, 100, `Expected exactly 100 quota units consumed on 500, got ${diff}`);
      } finally {
        global.fetch = origFetch;
        process.env.YOUTUBE_MOCK_MODE = origMock;
        process.env.YOUTUBE_API_KEY = origKey;
      }
    });

    it('1.4: Network failure / timeout (fetch exception) falls back and consumes exactly 100 units', async () => {
      const origFetch = global.fetch;
      const origMock = process.env.YOUTUBE_MOCK_MODE;
      const origKey = process.env.YOUTUBE_API_KEY;

      process.env.YOUTUBE_MOCK_MODE = 'false';
      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyForNetworkErrorTest123';

      let fetchInvoked = false;
      global.fetch = async () => {
        fetchInvoked = true;
        throw new Error('ETIMEDOUT: Connection to Google API timed out');
      };

      try {
        const initialStatus = quotaService.getQuotaStatus();
        const query = `EmpiricalTimeout_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const result = await youtubeService.searchYouTube(query);

        assert.strictEqual(fetchInvoked, true);
        assert.strictEqual(result.fromCache, false);
        assert.strictEqual(result.isMock, true);
        assert.ok(result.items.length > 0);

        const postStatus = quotaService.getQuotaStatus();
        const diff = postStatus.used - initialStatus.used;

        assert.strictEqual(diff, 100, `Expected exactly 100 quota units consumed on timeout, got ${diff}`);
      } finally {
        global.fetch = origFetch;
        process.env.YOUTUBE_MOCK_MODE = origMock;
        process.env.YOUTUBE_API_KEY = origKey;
      }
    });

    it('1.5: Live HTTP 200 OK success consumes exactly 100 units', async () => {
      const origFetch = global.fetch;
      const origMock = process.env.YOUTUBE_MOCK_MODE;
      const origKey = process.env.YOUTUBE_API_KEY;

      process.env.YOUTUBE_MOCK_MODE = 'false';
      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyForLive200Test12345678901';

      let fetchInvoked = false;
      global.fetch = async () => {
        fetchInvoked = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            items: [
              {
                id: { videoId: 'dQw4w9WgXcQ' },
                snippet: {
                  title: 'Live 200 Test Song',
                  channelTitle: 'Live Artist',
                  thumbnails: { high: { url: 'https://example.com/live.jpg' } }
                }
              }
            ]
          })
        };
      };

      try {
        const initialStatus = quotaService.getQuotaStatus();
        const query = `Empirical200_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const result = await youtubeService.searchYouTube(query);

        assert.strictEqual(fetchInvoked, true);
        assert.strictEqual(result.fromCache, false);
        assert.strictEqual(result.isMock, false);
        assert.strictEqual(result.items[0].videoId, 'dQw4w9WgXcQ');

        const postStatus = quotaService.getQuotaStatus();
        const diff = postStatus.used - initialStatus.used;

        assert.strictEqual(diff, 100, `Expected exactly 100 quota units on 200 OK, got ${diff}`);
      } finally {
        global.fetch = origFetch;
        process.env.YOUTUBE_MOCK_MODE = origMock;
        process.env.YOUTUBE_API_KEY = origKey;
      }
    });

    it('1.6: Pure mock mode (YOUTUBE_MOCK_MODE=true) consumes exactly 100 units', async () => {
      const origMock = process.env.YOUTUBE_MOCK_MODE;
      process.env.YOUTUBE_MOCK_MODE = 'true';

      try {
        const initialStatus = quotaService.getQuotaStatus();
        const query = `EmpiricalPureMock_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        const result = await youtubeService.searchYouTube(query);

        assert.strictEqual(result.fromCache, false);
        assert.strictEqual(result.isMock, true);

        const postStatus = quotaService.getQuotaStatus();
        const diff = postStatus.used - initialStatus.used;

        assert.strictEqual(diff, 100, `Expected exactly 100 units in pure mock mode, got ${diff}`);
      } finally {
        process.env.YOUTUBE_MOCK_MODE = origMock;
      }
    });
  });

  // ==========================================================================
  // 2. CACHED SEARCH ZERO-COST VERIFICATION (0 UNITS CONSUMED)
  // ==========================================================================
  describe('2. Cached Search Zero-Cost Verification', () => {

    it('2.1: Repeated identical search returns fromCache: true and consumes exactly 0 units', async () => {
      const query = `CachedTest_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

      // 1. Initial uncached search (+100 units)
      const res1 = await youtubeService.searchYouTube(query);
      assert.strictEqual(res1.fromCache, false);

      const statusAfterUncached = quotaService.getQuotaStatus();

      // Spy on fetch to guarantee zero network traffic
      let fetchCalled = false;
      const origFetch = global.fetch;
      global.fetch = async () => {
        fetchCalled = true;
        throw new Error('Upstream fetch must not be called on cache hit!');
      };

      try {
        // 2. Cached search
        const res2 = await youtubeService.searchYouTube(query);

        assert.strictEqual(fetchCalled, false, 'Fetch was erroneously invoked on cache hit');
        assert.strictEqual(res2.fromCache, true, 'Cached search must have fromCache: true');
        assert.deepStrictEqual(res2.items, res1.items);

        const statusAfterCached = quotaService.getQuotaStatus();
        const diff = statusAfterCached.used - statusAfterUncached.used;

        assert.strictEqual(diff, 0, `Cache hit must consume 0 quota units, got diff=${diff}`);
      } finally {
        global.fetch = origFetch;
      }
    });

    it('2.2: Case-insensitive and trimmed query hits cache and consumes exactly 0 units', async () => {
      const baseTerm = `NormQuery_${Date.now()}`;

      // Cold search with lower case
      await youtubeService.searchYouTube(baseTerm.toLowerCase());
      const statusBase = quotaService.getQuotaStatus();

      // Warm search with uppercase and whitespace padding
      const warmQuery = `   ${baseTerm.toUpperCase()}   `;
      const resWarm = await youtubeService.searchYouTube(warmQuery);

      assert.strictEqual(resWarm.fromCache, true);

      const statusWarm = quotaService.getQuotaStatus();
      const diff = statusWarm.used - statusBase.used;

      assert.strictEqual(diff, 0, `Normalized query cache hit must consume 0 quota units, got diff=${diff}`);
    });

    it('2.3: Burst of 20 sequential cache hits consumes exactly 0 units total', async () => {
      const query = `BurstCache_${Date.now()}`;

      // Prime cache
      await youtubeService.searchYouTube(query);
      const statusStart = quotaService.getQuotaStatus();

      for (let i = 0; i < 20; i++) {
        const res = await youtubeService.searchYouTube(query);
        assert.strictEqual(res.fromCache, true);
      }

      const statusEnd = quotaService.getQuotaStatus();
      const totalDiff = statusEnd.used - statusStart.used;

      assert.strictEqual(totalDiff, 0, `20 cache hits must consume 0 units, got ${totalDiff}`);
    });
  });

  // ==========================================================================
  // 3. INVALID QUERY EARLY-REJECTION (0 UNITS CONSUMED)
  // ==========================================================================
  describe('3. Invalid Queries Consume 0 Quota Units', () => {

    it('3.1: Empty, whitespace, or invalid queries reject early with 0 quota consumed', async () => {
      const statusBefore = quotaService.getQuotaStatus();

      const invalidInputs = ['', '   ', null, undefined, 123, {}, []];

      for (const input of invalidInputs) {
        await assert.rejects(
          async () => await youtubeService.searchYouTube(input),
          /Search query/i
        );
      }

      const statusAfter = quotaService.getQuotaStatus();
      assert.strictEqual(statusAfter.used, statusBefore.used, 'Invalid queries must never consume quota');
    });
  });

  // ==========================================================================
  // 4. HTTP INTEGRATION (/api/search + /api/quota)
  // ==========================================================================
  describe('4. HTTP End-to-End Search & Quota Invariants', () => {

    it('4.1: Live HTTP search endpoint consumes 100 on uncached and 0 on cached', async (t) => {
      if (!serverInfo) {
        t.skip('Backend server not running');
        return;
      }

      // 1. Initial quota check
      const q1 = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(q1.status, 200);
      const initialUsed = q1.data.used;
      const initialRemaining = q1.data.remaining;

      // 2. Uncached HTTP search
      const uniqueQ = `HTTPIntegration_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const s1 = await apiRequest(`/api/search?q=${encodeURIComponent(uniqueQ)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(s1.status, 200);
      assert.ok(Array.isArray(s1.data.items));

      // 3. Post uncached quota
      const q2 = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(q2.status, 200);
      assert.strictEqual(q2.data.used, initialUsed + 100, `Expected +100 used quota, got ${q2.data.used}`);
      assert.strictEqual(q2.data.remaining, initialRemaining - 100, `Expected -100 remaining quota, got ${q2.data.remaining}`);
      assert.strictEqual(q2.data.used + q2.data.remaining, 10000);

      // 4. Cached HTTP search
      const s2 = await apiRequest(`/api/search?q=${encodeURIComponent(uniqueQ)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(s2.status, 200);

      // 5. Post cached quota
      const q3 = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(q3.status, 200);
      assert.strictEqual(q3.data.used, q2.data.used, 'Cached HTTP search must not consume quota');
      assert.strictEqual(q3.data.remaining, q2.data.remaining);
    });
  });
});
