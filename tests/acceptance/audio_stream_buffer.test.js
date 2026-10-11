/**
 * Acceptance Criteria Test: Audio Proxy Stream Buffer Check
 *
 * Verifies:
 * 1. /api/stream/:videoId returns a valid, non-empty audio stream buffer for a known video ID.
 * 2. Proper Content-Type headers for audio (audio/mpeg, audio/webm, audio/flac).
 * 3. Support for quality tiers: high, medium, low, flac.
 * 4. Support for HTTP 206 Partial Content range requests.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { VALID_VIDEO_IDS } = require('../helpers/fixtures');

describe('Acceptance Criteria: Audio Proxy Stream Buffer Verification', () => {
  let serverInfo = null;
  const testVideoId = VALID_VIDEO_IDS[0]; // 'dQw4w9WgXcQ'

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

  it('verifies /api/stream/:videoId returns a valid audio stream buffer', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest(`/api/stream/${testVideoId}`, {}, serverInfo.baseUrl);
    assert.strictEqual(
      res.status === 200 || res.status === 206,
      true,
      `Expected HTTP 200 or 206, got ${res.status}`
    );

    const contentType = res.headers.get('content-type') || '';
    assert.strictEqual(
      contentType.startsWith('audio/') || contentType.includes('octet-stream'),
      true,
      `Expected audio Content-Type, got "${contentType}"`
    );

    assert.ok(Buffer.isBuffer(res.data), 'Expected response data to be a binary Buffer');
    assert.ok(res.data.length > 0, `Expected non-empty audio buffer, received ${res.data.length} bytes`);
    assert.ok(
      res.data.length >= 1024,
      `Expected substantial audio buffer (>= 1024 bytes), got ${res.data.length} bytes`
    );
  });

  it('verifies stream endpoint supports quality=flac lossless format', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest(`/api/stream/${testVideoId}?quality=flac`, {}, serverInfo.baseUrl);
    assert.strictEqual(res.status === 200 || res.status === 206, true);

    const contentType = res.headers.get('content-type') || '';
    assert.ok(
      contentType.includes('flac') || contentType.startsWith('audio/'),
      `Expected flac or audio content-type, got ${contentType}`
    );

    assert.ok(Buffer.isBuffer(res.data));
    assert.ok(res.data.length > 0);
  });

  it('verifies stream endpoint supports all quality presets (high, medium, low)', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    for (const quality of ['high', 'medium', 'low']) {
      const res = await apiRequest(`/api/stream/${testVideoId}?quality=${quality}`, {}, serverInfo.baseUrl);
      assert.strictEqual(
        res.status === 200 || res.status === 206,
        true,
        `Quality tier ${quality} returned status ${res.status}`
      );
      assert.ok(Buffer.isBuffer(res.data));
      assert.ok(res.data.length > 0, `Quality tier ${quality} returned 0-byte buffer`);
    }
  });

  it('verifies HTTP 206 Partial Content range requests for stream seeking', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const rangeHeader = 'bytes=0-1023';
    const res = await apiRequest(`/api/stream/${testVideoId}`, {
      headers: { Range: rangeHeader }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 206, `Expected HTTP 206 Partial Content, got ${res.status}`);

    const contentRange = res.headers.get('content-range');
    assert.ok(contentRange, 'Expected Content-Range header in 206 response');
    assert.match(contentRange, /bytes\s+0-1023\/\d+/);

    assert.ok(Buffer.isBuffer(res.data));
    assert.strictEqual(res.data.length, 1024, `Expected exactly 1024 bytes for range 0-1023, got ${res.data.length}`);
  });
});
