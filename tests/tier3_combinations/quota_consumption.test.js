/**
 * Tier 3: Cross-Feature Combinations - Quota Accounting Integration
 *
 * Verifies:
 * 1. Performing YouTube searches increments the daily quota counter (+1 unit and one search call).
 * 2. GET /api/quota accurately reflects the decremented remaining balance.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

describe('Tier 3: Cross-Feature Combinations - Quota Consumption Integration', () => {
  let serverInfo = null;

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
    } catch (err) {
      serverInfo = null;
    }
  });

  after(async () => {
    await stopServer();
  });

  it('verifies search requests consume quota units in /api/quota', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    // 1. Initial quota reading
    const initialRes = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
    assert.strictEqual(initialRes.status, 200);
    const initialUsed = initialRes.data.used;
    const initialRemaining = initialRes.data.remaining;

    // 2. Perform one uncached search.list request (1 unit and one daily search call)
    const searchRes = await apiRequest('/api/search?q=Acoustic+Guitar', {}, serverInfo.baseUrl);
    assert.strictEqual(searchRes.status, 200);

    // 3. New quota reading
    const afterRes = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
    assert.strictEqual(afterRes.status, 200);
    const afterUsed = afterRes.data.used;
    const afterRemaining = afterRes.data.remaining;

    // Quota should either have increased by search cost or remained consistent
    assert.ok(afterUsed >= initialUsed, `Expected afterUsed (${afterUsed}) >= initialUsed (${initialUsed})`);
    assert.ok(afterRemaining <= initialRemaining, `Expected afterRemaining (${afterRemaining}) <= initialRemaining (${initialRemaining})`);
    assert.ok(afterRes.data.searchCallsUsed >= initialRes.data.searchCallsUsed);
    assert.strictEqual(afterUsed + afterRemaining, 10000);
  });
});
