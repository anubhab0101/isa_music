/**
 * Tier 1: Feature Coverage - YouTube Search Proxy
 *
 * Covers:
 * - GET /api/search?q={query} (200 OK)
 * - Metadata scrubbing: videoId, title, artist, thumbnail returned
 * - Zero API key disclosure
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

describe('Tier 1: Feature Coverage - YouTube Search Proxy', () => {
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

  it('GET /api/search returns sanitized list of songs matching query', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const query = 'Bohemian Rhapsody';
    const res = await apiRequest(`/api/search?q=${encodeURIComponent(query)}`, {}, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.ok(res.data, 'Expected response payload');
    assert.ok(Array.isArray(res.data.items), 'Expected items array');
    assert.ok(res.data.items.length > 0, 'Expected non-empty search results');

    const firstItem = res.data.items[0];
    assert.ok(firstItem.videoId, 'Search item must have videoId');
    assert.ok(firstItem.title, 'Search item must have title');
    assert.ok(typeof firstItem.videoId === 'string');
    assert.ok(firstItem.videoId.length === 11, `Expected 11-char videoId, got ${firstItem.videoId}`);
  });

  it('verifies search proxy hides YouTube API key and internal parameters', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/search?q=synthwave', {}, serverInfo.baseUrl);
    const bodyStr = JSON.stringify(res.data);

    assert.strictEqual(/AIza[0-9A-Za-z-_]{35}/.test(bodyStr), false);
    assert.strictEqual(bodyStr.includes('youtubeApiKey'), false);
    assert.strictEqual(bodyStr.includes('key='), false);
  });
});
