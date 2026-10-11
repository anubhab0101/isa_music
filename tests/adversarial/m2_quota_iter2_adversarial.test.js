'use strict';

/**
 * tests/adversarial/m2_quota_iter2_adversarial.test.js
 *
 * Challenger 2 Iteration 2 Adversarial Verification Suite:
 * 1. Adversarially tests invalid date strings and objects against src/services/quota.js
 *    to ensure ZERO unhandled RangeError exceptions.
 * 2. Exhaustively tests that invariant `used + remaining === 10000` is strictly preserved
 *    under all conditions (overflow, underflow, fuzzing, concurrency, boundary states).
 * 3. Verifies quota accounting hooks across all live YouTube proxy fallback branches.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const quotaService = require('../../src/services/quota');
const youtubeService = require('../../src/services/youtube');
const { getDb } = require('../../src/db');

describe('Milestone 2 Iteration 2 Adversarial Suite: API Quota Engine Robustness', () => {

  after(() => {
    try {
      const db = getDb();
      const todayPacific = quotaService.getPacificDateString();
      db.prepare("DELETE FROM api_quota WHERE date != ?").run(todayPacific);
    } catch (_) {}
  });


  // ==========================================================================
  // SECTION 1: ZERO RANGEERROR ON ADVERSARIAL DATE INPUTS
  // ==========================================================================
  describe('1. Adversarial Date & Object Input Hardening (Zero RangeError)', () => {

    const adversarialDateInputs = [
      // Falsy & Primitive Inputs
      null,
      undefined,
      '',
      '   ',
      '\t\n\r',
      '\0',
      true,
      false,
      0,
      -0,
      1,
      -1,
      1710000000000,
      NaN,
      Infinity,
      -Infinity,
      1e25,
      -1e25,
      1e-15,
      BigInt(1710000000000),
      Symbol('adversarial_date'),
      () => {},
      async () => {},

      // Malformed & Adversarial Strings
      'not-a-valid-date-string',
      'invalid',
      'null',
      'undefined',
      'NaN',
      '2026-99-99',
      '2026-00-00',
      '0000-00-00',
      '9999-99-99',
      '99999-12-31',
      '-2026-01-01',
      '2026/10/10',
      '10-10-2026',
      '2026.10.10',
      '2026-10-10T99:99:99.999Z',
      '2026-02-30',
      '2026-02-31',
      'Tue Feb 31 2026',
      'October 35, 2026',
      '--__--',
      'DROP TABLE api_quota; --',
      '<script>alert("xss")</script>',
      '{"date": "2026-10-10"}',

      // Invalid & Extreme Date Instances
      new Date(NaN),
      new Date('invalid date string'),
      new Date(''),
      new Date(8640000000000000), // Max valid JS timestamp
      new Date(8640000000000001), // Beyond max -> Invalid Date
      new Date(-8640000000000000), // Min valid JS timestamp
      new Date(-8640000000000001), // Beyond min -> Invalid Date

      // Non-Date Objects & Arrays
      {},
      [],
      [1, 2, 3],
      ['2026-10-10'],
      { year: 2026, month: 10, day: 10 },
      { toString: () => 'invalid' },
      { toString: () => '2026-10-10' },
      { valueOf: () => NaN },
      { getTime: () => NaN },
      new RegExp('^\\d{4}-\\d{2}-\\d{2}$'),
      new Error('synthetic error object'),
      new Map(),
      new Set(),
      new Uint8Array(16),
      Buffer.from('2026-10-10'),
      Promise.resolve('2026-10-10')
    ];

    it('parseDateInput returns guaranteed valid Date object with finite getTime for all adversarial inputs', () => {
      for (const input of adversarialDateInputs) {
        let parsed;
        assert.doesNotThrow(() => {
          parsed = quotaService.parseDateInput(input);
        }, `parseDateInput threw on input: ${String(input)}`);

        assert.ok(parsed instanceof Date, `Expected Date instance for input: ${String(input)}`);
        assert.ok(Number.isFinite(parsed.getTime()), `Expected finite getTime() for input: ${String(input)}`);
        assert.ok(!isNaN(parsed.getTime()), `Expected non-NaN getTime() for input: ${String(input)}`);
      }
    });

    it('getPacificDateString never throws RangeError or any exception for all adversarial inputs', () => {
      for (const input of adversarialDateInputs) {
        let result;
        assert.doesNotThrow(() => {
          result = quotaService.getPacificDateString(input);
        }, `getPacificDateString threw on input: ${String(input)}`);

        assert.strictEqual(typeof result, 'string', `Expected string for input: ${String(input)}`);
        assert.match(
          result,
          /^-?\d+-\d{2}-\d{2}$/,
          `Expected YYYY-MM-DD pattern for input: ${String(input)}, got: ${result}`
        );
      }
    });

    it('getNextPacificMidnightISO never throws RangeError and outputs valid ISO 8601 string for all adversarial inputs', () => {
      for (const input of adversarialDateInputs) {
        let result;
        assert.doesNotThrow(() => {
          result = quotaService.getNextPacificMidnightISO(input);
        }, `getNextPacificMidnightISO threw on input: ${String(input)}`);

        assert.strictEqual(typeof result, 'string', `Expected string for input: ${String(input)}`);
        assert.match(
          result,
          /^\+?\d{4,6}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
          `Expected ISO 8601 string for input: ${String(input)}, got: ${result}`
        );

        const parsedTime = new Date(result).getTime();
        assert.ok(Number.isFinite(parsedTime), `getNextPacificMidnightISO must be parseable: ${result}`);
      }
    });

    it('getQuotaStatus never throws RangeError and satisfies invariant used + remaining === 10000 for all adversarial inputs', () => {
      for (const input of adversarialDateInputs) {
        let status;
        assert.doesNotThrow(() => {
          status = quotaService.getQuotaStatus(input);
        }, `getQuotaStatus threw on input: ${String(input)}`);

        assert.strictEqual(typeof status, 'object');
        assert.strictEqual(
          status.used + status.remaining,
          10000,
          `Invariant used + remaining === 10000 violated for input: ${String(input)} (used=${status.used}, remaining=${status.remaining})`
        );
        assert.ok(status.used >= 0 && status.used <= 10000);
        assert.ok(status.remaining >= 0 && status.remaining <= 10000);
      }
    });

    it('hasAvailableQuota and resetDailyQuota never throw RangeError for all adversarial inputs', () => {
      for (const input of adversarialDateInputs) {
        assert.doesNotThrow(() => {
          const avail = quotaService.hasAvailableQuota(100, input);
          assert.strictEqual(typeof avail, 'boolean');
        }, `hasAvailableQuota threw on input: ${String(input)}`);

        assert.doesNotThrow(() => {
          const res = quotaService.resetDailyQuota(input);
          assert.strictEqual(res.used + res.remaining, 10000);
        }, `resetDailyQuota threw on input: ${String(input)}`);
      }
    });
  });

  // ==========================================================================
  // SECTION 2: MATHEMATICAL INVARIANT PRESERVATION (used + remaining === 10000)
  // ==========================================================================
  describe('2. Mathematical Invariant Preservation under All Conditions', () => {

    it('preserves invariant across randomized Monte Carlo stress fuzzing (1000 iterations)', () => {
      const testDate = '2099-11-20';
      quotaService.resetDailyQuota(testDate);

      // Randomized operations
      for (let i = 0; i < 1000; i++) {
        // Generate random unit increment between -5000 and 25000
        const randUnits = Math.floor(Math.random() * 30000) - 5000;
        const status = quotaService.recordQuotaUsage(randUnits, 'search', testDate);

        // Core Invariant
        assert.strictEqual(
          status.used + status.remaining,
          10000,
          `Iteration ${i}: Invariant used + remaining === 10000 violated (used=${status.used}, remaining=${status.remaining}, randUnits=${randUnits})`
        );

        // Clamping Boundaries
        assert.ok(status.used >= 0, `used must be >= 0, got ${status.used}`);
        assert.ok(status.used <= 10000, `used must be <= 10000, got ${status.used}`);
        assert.ok(status.remaining >= 0, `remaining must be >= 0, got ${status.remaining}`);
        assert.ok(status.remaining <= 10000, `remaining must be <= 10000, got ${status.remaining}`);
        assert.strictEqual(status.total, 10000);
        assert.strictEqual(status.limit, 10000);
      }
    });

    it('preserves invariant under direct SQLite database boundary and corrupted values', () => {
      const db = getDb();
      const corruptedDate = '2099-12-31';
      quotaService.resetDailyQuota(corruptedDate);

      const corruptedValues = [
        -999999,
        -10000,
        -500,
        -1,
        0,
        5000,
        10000,
        10001,
        25000,
        999999,
        null,
        1e20,
        -1e20
      ];

      for (const badVal of corruptedValues) {
        db.prepare('UPDATE api_quota SET units_used = ? WHERE date = ?').run(badVal, corruptedDate);
        const status = quotaService.getQuotaStatus(corruptedDate);

        assert.strictEqual(
          status.used + status.remaining,
          10000,
          `Invariant failed for corrupted DB value '${badVal}': used=${status.used}, remaining=${status.remaining}`
        );
        assert.ok(status.used >= 0 && status.used <= 10000);
        assert.ok(status.remaining >= 0 && status.remaining <= 10000);
      }
    });

    it('preserves mathematical bounds when record does not yet exist in SQLite', () => {
      const db = getDb();
      const nonExistentDate = '2088-08-08';
      db.prepare('DELETE FROM api_quota WHERE date = ?').run(nonExistentDate);

      const status = quotaService.getQuotaStatus(nonExistentDate);
      assert.strictEqual(status.used, 0);
      assert.strictEqual(status.remaining, 10000);
      assert.strictEqual(status.total, 10000);
      assert.strictEqual(status.used + status.remaining, 10000);
    });

    it('preserves invariant under high concurrency (100 parallel operations)', async () => {
      const testDate = '2099-06-15';
      quotaService.resetDailyQuota(testDate);

      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          (async () => {
            if (i % 2 === 0) {
              return quotaService.recordQuotaUsage(100, 'search', testDate);
            } else {
              return quotaService.getQuotaStatus(testDate);
            }
          })()
        );
      }

      const results = await Promise.all(promises);
      for (const res of results) {
        assert.strictEqual(
          res.used + res.remaining,
          10000,
          `Concurrent operation violated invariant: used=${res.used}, remaining=${res.remaining}`
        );
      }

      const finalStatus = quotaService.getQuotaStatus(testDate);
      assert.strictEqual(finalStatus.used + finalStatus.remaining, 10000);
    });
  });

  // ==========================================================================
  // SECTION 3: YOUTUBE PROXY LIVE FALLBACK ACCOUNTING VERIFICATION
  // ==========================================================================
  describe('3. YouTube Proxy Live Fallback Accounting Verification', () => {

    it('accurately records +100 quota units when upstream YouTube returns HTTP 429', async () => {
      const originalFetch = global.fetch;
      const originalApiKey = process.env.YOUTUBE_API_KEY;
      const originalMock = process.env.YOUTUBE_MOCK_MODE;

      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyForAdversarialTest123456';
      delete process.env.YOUTUBE_MOCK_MODE;

      // Mock fetch returning HTTP 429 RESOURCE_EXHAUSTED
      global.fetch = async () => ({
        ok: false,
        status: 429,
        json: async () => ({
          error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' }
        })
      });

      try {
        const beforeStatus = quotaService.getQuotaStatus();
        const query = `adv_probe_429_${Date.now()}_${Math.random()}`;

        const searchRes = await youtubeService.searchYouTube(query, { allowMockFallback: true });
        assert.ok(searchRes.items.length > 0, 'Must return fallback items');
        assert.strictEqual(searchRes.isMock, true);
        assert.strictEqual(searchRes.fromCache, false);

        const afterStatus = quotaService.getQuotaStatus();
        assert.strictEqual(
          afterStatus.used - beforeStatus.used,
          100,
          `HTTP 429 fallback must record exactly 100 quota units (expected diff 100, got ${afterStatus.used - beforeStatus.used})`
        );
      } finally {
        global.fetch = originalFetch;
        if (originalApiKey !== undefined) process.env.YOUTUBE_API_KEY = originalApiKey;
        else delete process.env.YOUTUBE_API_KEY;
        if (originalMock !== undefined) process.env.YOUTUBE_MOCK_MODE = originalMock;
        else delete process.env.YOUTUBE_MOCK_MODE;
      }
    });

    it('accurately records +100 quota units when upstream YouTube returns HTTP 403', async () => {
      const originalFetch = global.fetch;
      const originalApiKey = process.env.YOUTUBE_API_KEY;
      const originalMock = process.env.YOUTUBE_MOCK_MODE;

      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyForAdversarialTest123456';
      delete process.env.YOUTUBE_MOCK_MODE;

      // Mock fetch returning HTTP 403
      global.fetch = async () => ({
        ok: false,
        status: 403,
        json: async () => ({
          error: { code: 403, message: 'Forbidden' }
        })
      });

      try {
        const beforeStatus = quotaService.getQuotaStatus();
        const query = `adv_probe_403_${Date.now()}_${Math.random()}`;

        const searchRes = await youtubeService.searchYouTube(query, { allowMockFallback: true });
        assert.ok(searchRes.items.length > 0);
        assert.strictEqual(searchRes.isMock, true);
        assert.strictEqual(searchRes.fromCache, false);

        const afterStatus = quotaService.getQuotaStatus();
        assert.strictEqual(
          afterStatus.used - beforeStatus.used,
          100,
          `HTTP 403 fallback must record exactly 100 quota units`
        );
      } finally {
        global.fetch = originalFetch;
        if (originalApiKey !== undefined) process.env.YOUTUBE_API_KEY = originalApiKey;
        else delete process.env.YOUTUBE_API_KEY;
        if (originalMock !== undefined) process.env.YOUTUBE_MOCK_MODE = originalMock;
        else delete process.env.YOUTUBE_MOCK_MODE;
      }
    });

    it('accurately records +100 quota units when network fetch throws unexpected Error', async () => {
      const originalFetch = global.fetch;
      const originalApiKey = process.env.YOUTUBE_API_KEY;
      const originalMock = process.env.YOUTUBE_MOCK_MODE;

      process.env.YOUTUBE_API_KEY = 'AIzaSyFakeKeyForAdversarialTest123456';
      delete process.env.YOUTUBE_MOCK_MODE;

      // Mock fetch throwing network error (e.g. ECONNREFUSED or Timeout)
      global.fetch = async () => {
        throw new Error('connect ECONNREFUSED 142.250.190.42:443');
      };

      try {
        const beforeStatus = quotaService.getQuotaStatus();
        const query = `adv_probe_net_error_${Date.now()}_${Math.random()}`;

        const searchRes = await youtubeService.searchYouTube(query, { allowMockFallback: true });
        assert.ok(searchRes.items.length > 0);
        assert.strictEqual(searchRes.isMock, true);
        assert.strictEqual(searchRes.fromCache, false);

        const afterStatus = quotaService.getQuotaStatus();
        assert.strictEqual(
          afterStatus.used - beforeStatus.used,
          100,
          `Network error fallback must record exactly 100 quota units`
        );
      } finally {
        global.fetch = originalFetch;
        if (originalApiKey !== undefined) process.env.YOUTUBE_API_KEY = originalApiKey;
        else delete process.env.YOUTUBE_API_KEY;
        if (originalMock !== undefined) process.env.YOUTUBE_MOCK_MODE = originalMock;
        else delete process.env.YOUTUBE_MOCK_MODE;
      }
    });

    it('guarantees cached search consumes 0 quota units across all scenarios', async () => {
      const beforeStatus = quotaService.getQuotaStatus();
      const cachedTerm = `adv_cached_${Date.now()}`;

      // Populate cache
      youtubeService.setCachedSearch(cachedTerm, [{ videoId: 'dQw4w9WgXcQ', title: 'Rick' }]);

      // Perform cached query
      const res = await youtubeService.searchYouTube(cachedTerm);
      assert.strictEqual(res.fromCache, true);

      const afterStatus = quotaService.getQuotaStatus();
      assert.strictEqual(
        afterStatus.used,
        beforeStatus.used,
        'Cached search must consume exactly 0 quota units'
      );
    });
  });

});
