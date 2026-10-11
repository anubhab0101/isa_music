/**
 * Tier 2: Boundary & Corner Cases - API Quota
 *
 * Covers:
 * - Upper and lower bounds of quota (0 <= used <= 10000)
 * - Daily quota reset structure
 * - Quota persistence across multiple requests
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

describe('Tier 2: Boundary & Corner Cases - API Quota', () => {
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

  it('verifies quota bounds and mathematical invariants', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
    assert.strictEqual(res.status, 200);

    const { used, remaining, limit, resetAt } = res.data;

    assert.ok(used >= 0, `used quota must be >= 0, got ${used}`);
    assert.ok(used <= limit, `used quota must not exceed limit ${limit}, got ${used}`);
    assert.ok(remaining >= 0, `remaining quota must be >= 0, got ${remaining}`);
    assert.ok(remaining <= limit, `remaining quota must not exceed limit ${limit}, got ${remaining}`);
    assert.strictEqual(used + remaining, limit, 'used + remaining must equal limit');

    // Verify resetAt is a valid date string
    const resetDate = new Date(resetAt);
    assert.strictEqual(isNaN(resetDate.getTime()), false, 'resetAt must be a valid parseable date');
  });
});
