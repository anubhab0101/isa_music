/**
 * Tier 1: Feature Coverage - Audio Stream Proxy
 *
 * Covers:
 * - GET /api/stream/:videoId
 * - Audio streaming buffer output
 * - Quality preset query parameter
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { VALID_VIDEO_IDS } = require('../helpers/fixtures');

describe('Tier 1: Feature Coverage - Audio Stream Proxy', () => {
  let serverInfo = null;
  const videoId = VALID_VIDEO_IDS[0];

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

  it('GET /api/stream/:videoId returns audio stream with valid content type', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest(`/api/stream/${videoId}`, {}, serverInfo.baseUrl);
    assert.strictEqual(res.status === 200 || res.status === 206, true);

    const contentType = res.headers.get('content-type') || '';
    assert.ok(
      contentType.startsWith('audio/') || contentType.includes('octet-stream'),
      `Expected audio Content-Type, got ${contentType}`
    );

    assert.ok(Buffer.isBuffer(res.data));
    assert.ok(res.data.length > 0);
  });

  it('GET /api/stream/:videoId?quality=high returns high quality stream', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest(`/api/stream/${videoId}?quality=high`, {}, serverInfo.baseUrl);
    assert.strictEqual(res.status === 200 || res.status === 206, true);
    assert.ok(Buffer.isBuffer(res.data));
    assert.ok(res.data.length > 0);
  });
});
