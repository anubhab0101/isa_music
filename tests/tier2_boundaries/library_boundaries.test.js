/**
 * Tier 2: Boundary & Corner Cases - Liked Library
 *
 * Covers:
 * - Unauthenticated requests to /api/library (401 Unauthorized)
 * - Missing track videoId in POST /api/library/like (400 Bad Request)
 * - Deleting non-existent track from library (clean 200 or 404 response)
 * - Idempotency of liking the same track twice
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail, SAMPLE_TRACKS } = require('../helpers/fixtures');

describe('Tier 2: Boundary & Corner Cases - Liked Library', () => {
  let serverInfo = null;
  const testEmail = generateUniqueEmail('t2_lib');
  const testPassword = 'Password123!@#';
  let authToken = null;
  const track = SAMPLE_TRACKS[1];

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
      if (serverInfo) {
        const regRes = await apiRequest('/api/register', {
          method: 'POST',
          body: { email: testEmail, password: testPassword }
        }, serverInfo.baseUrl);
        authToken = regRes.data?.token;
      }
    } catch (err) {
      serverInfo = null;
    }
  });

  after(async () => {
    await stopServer();
  });

  it('rejects unauthenticated library requests with 401 Unauthorized', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const resLike = await apiRequest('/api/library/like', {
      method: 'POST',
      body: track
    }, serverInfo.baseUrl);
    assert.strictEqual(resLike.status, 401);

    const resGet = await apiRequest('/api/library', { method: 'GET' }, serverInfo.baseUrl);
    assert.strictEqual(resGet.status, 401);

    const resUnlike = await apiRequest(`/api/library/unlike/${track.videoId}`, {
      method: 'DELETE'
    }, serverInfo.baseUrl);
    assert.strictEqual(resUnlike.status, 401);
  });

  it('rejects liking track with missing videoId with 400 Bad Request', async (t) => {
    if (!serverInfo || !authToken) {
      t.skip('Backend server or auth token unavailable');
      return;
    }

    const res = await apiRequest('/api/library/like', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: { title: 'Track Without VideoId', artist: 'Artist' }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 400, `Expected 400 for missing videoId, got ${res.status}`);
  });

  it('handles liking the same track twice idempotently without crashing', async (t) => {
    if (!serverInfo || !authToken) {
      t.skip('Backend server or auth token unavailable');
      return;
    }

    // First like
    const res1 = await apiRequest('/api/library/like', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: track
    }, serverInfo.baseUrl);
    assert.strictEqual(res1.status === 200 || res1.status === 201, true);

    // Duplicate like
    const res2 = await apiRequest('/api/library/like', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: track
    }, serverInfo.baseUrl);
    assert.strictEqual(
      res2.status === 200 || res2.status === 201 || res2.status === 409,
      true,
      `Expected idempotent 200/201 or 409, got ${res2.status}`
    );
  });

  it('handles unliking a track not currently in the library gracefully', async (t) => {
    if (!serverInfo || !authToken) {
      t.skip('Backend server or auth token unavailable');
      return;
    }

    const nonExistentVideoId = 'nonExist999';
    const res = await apiRequest(`/api/library/unlike/${nonExistentVideoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(
      res.status === 200 || res.status === 404,
      true,
      `Expected 200 or 404 for unliking absent track, got ${res.status}`
    );
  });
});
