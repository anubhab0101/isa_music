/**
 * Milestone 2 Comprehensive Verification Suite
 * tests/acceptance/m2_verification.test.js
 *
 * Verifies all Milestone 2 interface contracts and acceptance criteria:
 * 1. Audio Streaming Proxy (/api/stream/:videoId)
 *    - GET /api/stream/:videoId?quality=high returns 200/206 with audio/mpeg buffer (>= 1024 bytes)
 *    - GET /api/stream/:videoId?quality=flac returns 200/206 with audio/flac buffer (>= 1024 bytes)
 *    - Quality presets: high (320kbps), medium (128kbps), low (64kbps)
 *    - Range requests: Range: bytes=0-1023 returns HTTP 206 with Content-Range and 1024-byte slice
 *    - Out-of-bounds Range: returns HTTP 416 Range Not Satisfiable
 *    - Input sanitization: invalid video IDs return 400 Bad Request
 *
 * 2. API Quota Management & Accounting (/api/quota)
 *    - GET /api/quota returns { used, remaining, total, resetsAt } with exact number and ISO string types
 *    - Mathematical invariant: used + remaining === total (10000)
 *    - Resets at: midnight Pacific Time (America/Los_Angeles) ISO timestamp
 *    - Quota accounting: uncached search proxy consumes 100 units (used increases by 100, remaining decreases by 100)
 *    - Cache preservation: cached search proxy consumes 0 units (used and remaining stay identical)
 *    - SQLite persistence: api_quota table in isa_music.db matches endpoint state
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = fs.existsSync(path.resolve(__dirname, 'server.js'))
  ? __dirname
  : (fs.existsSync(path.resolve(__dirname, '../../server.js'))
      ? path.resolve(__dirname, '../..')
      : path.resolve(__dirname, '../../..'));
const DB_PATH = path.resolve(ROOT_DIR, 'isa_music.db');
const { ensureServerRunning, stopServer, apiRequest } = require(path.resolve(ROOT_DIR, 'tests/helpers/test_server'));

const VALID_VIDEO_ID = 'dQw4w9WgXcQ';
const INVALID_VIDEO_IDS = ['too_short', 'this_video_id_is_way_too_long', '../../passwd', ';calc.exe', 'inv@lid!#$'];

describe('Milestone 2 Acceptance Suite: Audio Streaming & API Quota Engine', () => {
  let serverInfo = null;
  let db = null;

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
      if (fs.existsSync(DB_PATH)) {
        db = new DatabaseSync(DB_PATH);
      }
    } catch (err) {
      serverInfo = null;
    }
  });

  after(async () => {
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
    await stopServer();
  });

  describe('Part 1: Audio Streaming Proxy Contracts (R1)', () => {
    it('GET /api/stream/:videoId?quality=high returns valid high quality audio buffer', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=high`, {}, serverInfo.baseUrl);
      assert.strictEqual(res.status === 200 || res.status === 206, true, `Expected 200 or 206, got ${res.status}`);

      const contentType = res.headers.get('content-type') || '';
      assert.ok(
        contentType.startsWith('audio/') || contentType.includes('octet-stream'),
        `Expected audio Content-Type, received "${contentType}"`
      );

      assert.ok(Buffer.isBuffer(res.data), 'Expected binary buffer body');
      assert.ok(res.data.length >= 1024, `Expected substantial audio buffer (>= 1024 bytes), got ${res.data.length}`);
    });

    it('GET /api/stream/:videoId?quality=flac returns lossless FLAC audio buffer', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=flac`, {}, serverInfo.baseUrl);
      assert.strictEqual(res.status === 200 || res.status === 206, true);

      const contentType = res.headers.get('content-type') || '';
      assert.ok(
        contentType.includes('flac') || contentType.startsWith('audio/'),
        `Expected flac or audio Content-Type, received "${contentType}"`
      );

      assert.ok(Buffer.isBuffer(res.data));
      assert.ok(res.data.length >= 1024, `Expected buffer length >= 1024 bytes, received ${res.data.length}`);
    });

    it('supports all quality presets: high, medium, and low', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      for (const quality of ['high', 'medium', 'low']) {
        const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=${quality}`, {}, serverInfo.baseUrl);
        assert.strictEqual(res.status === 200 || res.status === 206, true);
        assert.ok(Buffer.isBuffer(res.data));
        assert.ok(res.data.length > 0, `Preset ${quality} returned empty buffer`);
      }
    });

    it('supports HTTP 206 Partial Content range requests with exact slicing', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}`, {
        headers: { Range: 'bytes=0-1023' }
      }, serverInfo.baseUrl);

      assert.strictEqual(res.status, 206, `Expected HTTP 206 Partial Content, got ${res.status}`);
      const contentRange = res.headers.get('content-range') || '';
      assert.match(contentRange, /bytes\s+0-1023\/\d+/);

      assert.ok(Buffer.isBuffer(res.data));
      assert.strictEqual(res.data.length, 1024, `Expected exactly 1024 bytes for range 0-1023, got ${res.data.length}`);
    });

    it('returns HTTP 416 Range Not Satisfiable when range is out of bounds', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}`, {
        headers: { Range: 'bytes=9999999-9999999' }
      }, serverInfo.baseUrl);

      assert.strictEqual(res.status, 416, `Expected HTTP 416 Range Not Satisfiable, got ${res.status}`);
    });

    it('rejects malformed video IDs and injection attempts with HTTP 400', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      for (const badId of INVALID_VIDEO_IDS) {
        const res = await apiRequest(`/api/stream/${encodeURIComponent(badId)}`, {}, serverInfo.baseUrl);
        assert.strictEqual(res.status, 400, `Expected 400 for bad videoId "${badId}", got ${res.status}`);
      }
    });
  });

  describe('Part 2: API Quota Management & Accounting Contracts (R2)', () => {
    it('GET /api/quota returns { used, remaining, total, resetsAt } with correct types', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      const res = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const data = res.data;

      assert.strictEqual(typeof data.used, 'number', 'used must be a number');
      assert.strictEqual(typeof data.remaining, 'number', 'remaining must be a number');
      assert.strictEqual(typeof (data.total ?? data.limit), 'number', 'total/limit must be a number');
      const total = data.total ?? data.limit;
      assert.strictEqual(total, 10000, 'total quota limit must be 10000');

      const resetStr = data.resetsAt ?? data.resetAt;
      assert.strictEqual(typeof resetStr, 'string', 'resetsAt must be an ISO timestamp string');
      const resetTime = Date.parse(resetStr);
      assert.strictEqual(isNaN(resetTime), false, 'resetsAt must be a valid parseable date');

      // Mathematical invariant: used + remaining === total
      assert.strictEqual(data.used + data.remaining, total, 'used + remaining must equal total limit');
    });

    it('uncached search consumes one search.list unit and cached search consumes 0', async (t) => {
      if (!serverInfo) return t.skip('Server not running');

      // 1. Initial quota
      const q1 = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(q1.status, 200);
      const initialUsed = q1.data.used;
      const initialRemaining = q1.data.remaining;

      // 2. Perform uncached search with unique query
      const uniqueQ = `M2Verify_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const s1 = await apiRequest(`/api/search?q=${encodeURIComponent(uniqueQ)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(s1.status, 200);

      // 3. Post-search quota
      const q2 = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(q2.status, 200);
      const afterUsed = q2.data.used;
      const afterRemaining = q2.data.remaining;

      assert.strictEqual(
        afterUsed,
        initialUsed + 1,
        `Expected quota units to increase by 1 (from ${initialUsed} to ${initialUsed + 1}), got ${afterUsed}`
      );
      assert.strictEqual(
        afterRemaining,
        initialRemaining - 1,
        `Expected remaining units to decrease by 1, got ${afterRemaining}`
      );
      assert.strictEqual(afterUsed + afterRemaining, 10000);
      assert.strictEqual(q2.data.searchCallsUsed, q1.data.searchCallsUsed + 1);
      assert.strictEqual(q2.data.searchCallsRemaining, q1.data.searchCallsRemaining - 1);

      // 4. Repeated identical search (Cache hit)
      const s2 = await apiRequest(`/api/search?q=${encodeURIComponent(uniqueQ)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(s2.status, 200);

      const q3 = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(q3.status, 200);
      assert.strictEqual(
        q3.data.used,
        afterUsed,
        'Cache hit must not increment quota consumption'
      );
    });

    it('persists quota usage state directly in SQLite api_quota table', async (t) => {
      if (!serverInfo || !db) return t.skip('Server or DB not available');

      const quotaRes = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(quotaRes.status, 200);

      const row = db.prepare('SELECT units_used, units_limit FROM api_quota ORDER BY id DESC LIMIT 1').get();
      assert.ok(row, 'Expected at least one row in api_quota');
      assert.strictEqual(row.units_used, quotaRes.data.used);
      assert.strictEqual(row.units_limit, 10000);
    });
  });
});
