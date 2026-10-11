/**
 * Tier 2: Boundary & Corner Cases - Audio Stream Proxy
 *
 * Covers:
 * - Invalid videoId length / characters (400 Bad Request)
 * - Path traversal / command injection attempts (400 Bad Request, SSRF prevention)
 * - Invalid quality parameter values (400 Bad Request or default fallback)
 * - Range header boundary conditions: single byte (bytes=0-0), out of bounds (416)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { VALID_VIDEO_IDS, INVALID_VIDEO_IDS } = require('../helpers/fixtures');

describe('Tier 2: Boundary & Corner Cases - Audio Stream Proxy', () => {
  let serverInfo = null;
  const validVideoId = VALID_VIDEO_IDS[0];

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

  it('rejects invalid video ID formats with 400 Bad Request', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    for (const badId of INVALID_VIDEO_IDS) {
      if (!badId) continue;
      const res = await apiRequest(`/api/stream/${encodeURIComponent(badId)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(
        res.status,
        400,
        `Expected 400 for bad videoId "${badId}", got ${res.status}`
      );
    }
  });

  it('prevents command injection and directory traversal in videoId (SSRF protection)', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const attacks = [
      ';calc.exe',
      '|dir',
      '&whoami',
      '../../etc/passwd',
      '..\\..\\windows\\system32',
      '$(whoami)'
    ];

    for (const attack of attacks) {
      const res = await apiRequest(`/api/stream/${encodeURIComponent(attack)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(
        res.status,
        400,
        `Expected 400 rejecting attack payload "${attack}", got ${res.status}`
      );
    }
  });

  it('rejects or falls back safely for invalid quality parameters', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest(`/api/stream/${validVideoId}?quality=invalid_ultra_super`, {}, serverInfo.baseUrl);
    assert.strictEqual(
      res.status === 400 || res.status === 200 || res.status === 206,
      true,
      `Expected 400 or fallback 200/206 for invalid quality, got ${res.status}`
    );
  });

  it('handles single-byte Range header requests (bytes=0-0)', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest(`/api/stream/${validVideoId}`, {
      headers: { Range: 'bytes=0-0' }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 206, `Expected 206 Partial Content for single byte range, got ${res.status}`);
    assert.ok(Buffer.isBuffer(res.data));
    assert.strictEqual(res.data.length, 1, `Expected exactly 1 byte, got ${res.data.length}`);
  });

  it('returns HTTP 416 Range Not Satisfiable when range is beyond buffer bounds', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest(`/api/stream/${validVideoId}`, {
      headers: { Range: 'bytes=99999999-99999999' }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 416, `Expected 416 Range Not Satisfiable, got ${res.status}`);
  });
});
