/**
 * Tier 1: Feature Coverage - Daily Quota Tracking Endpoint
 *
 * Covers:
 * - GET /api/quota (200 OK)
 * - Quota response format: used, remaining, limit (10,000), resetAt
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

describe('Tier 1: Feature Coverage - Quota Tracking Endpoint', () => {
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

  it('GET /api/quota returns current YouTube Data API quota metrics', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/quota', {}, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.ok(res.data, 'Expected response body');

    const { used, remaining, limit, resetAt } = res.data;

    assert.strictEqual(typeof used, 'number', 'used quota must be a number');
    assert.strictEqual(typeof remaining, 'number', 'remaining quota must be a number');
    assert.strictEqual(limit, 10000, 'daily quota limit must be 10000 units');
    assert.ok(used >= 0, 'used units must be non-negative');
    assert.ok(remaining <= 10000, 'remaining units must be <= 10000');
    assert.strictEqual(used + remaining, 10000, 'used + remaining must equal 10000');
    assert.ok(resetAt, 'resetAt timestamp must be defined');
  });
});
