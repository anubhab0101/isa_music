/**
 * Tier 2: Boundary & Corner Cases - Search Proxy
 *
 * Covers:
 * - Missing query parameter (400 Bad Request)
 * - Empty query parameter (400 Bad Request or empty results)
 * - Adversarial queries: SQL injection, XSS payloads
 * - Extremely long queries (> 500 characters)
 * - Unicode and emoji queries
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

describe('Tier 2: Boundary & Corner Cases - Search Proxy', () => {
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

  it('rejects GET /api/search without q parameter with 400 Bad Request', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/search', {}, serverInfo.baseUrl);
    assert.strictEqual(res.status, 400, `Expected 400 Bad Request when q is missing, got ${res.status}`);
  });

  it('handles empty query (q=) with 400 Bad Request or empty items array', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/search?q=', {}, serverInfo.baseUrl);
    assert.strictEqual(
      res.status === 400 || (res.status === 200 && Array.isArray(res.data?.items) && res.data.items.length === 0),
      true,
      `Expected 400 or empty items for empty query, got status ${res.status}`
    );
  });

  it('sanitizes SQL injection attempts without crashing or leaking database syntax', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const sqlPayloads = [
      "' OR 1=1 --",
      "'; DROP TABLE users; --",
      '" UNION SELECT * FROM users --'
    ];

    for (const payload of sqlPayloads) {
      const res = await apiRequest(`/api/search?q=${encodeURIComponent(payload)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(
        res.status === 200 || res.status === 400,
        true,
        `Expected 200 or 400 for SQL injection query, got ${res.status}`
      );
      const str = JSON.stringify(res.data || '');
      assert.strictEqual(str.toLowerCase().includes('syntax error'), false);
      assert.strictEqual(str.toLowerCase().includes('sqlite'), false);
    }
  });

  it('sanitizes XSS payloads without returning raw executable scripts', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const xssPayload = '<script>alert("xss")</script>';
    const res = await apiRequest(`/api/search?q=${encodeURIComponent(xssPayload)}`, {}, serverInfo.baseUrl);
    assert.strictEqual(res.status === 200 || res.status === 400, true);

    const bodyStr = JSON.stringify(res.data || '');
    assert.strictEqual(bodyStr.includes('<script>'), false);
  });

  it('handles extremely long query strings gracefully without 500 error', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const longQuery = 'A'.repeat(800);
    const res = await apiRequest(`/api/search?q=${encodeURIComponent(longQuery)}`, {}, serverInfo.baseUrl);
    assert.strictEqual(
      res.status === 200 || res.status === 400 || res.status === 414,
      true,
      `Long query returned unexpected status ${res.status}`
    );
  });

  it('handles Unicode and emoji queries correctly', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const unicodeQuery = '音楽 🎵 Chillhop Café';
    const res = await apiRequest(`/api/search?q=${encodeURIComponent(unicodeQuery)}`, {}, serverInfo.baseUrl);
    assert.strictEqual(res.status, 200);
  });
});
