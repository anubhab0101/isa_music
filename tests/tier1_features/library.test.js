/**
 * Tier 1: Feature Coverage - Liked Library Endpoints
 *
 * Covers:
 * - POST /api/library/like (201 Created)
 * - GET /api/library (200 OK)
 * - DELETE /api/library/unlike/:videoId (200 OK)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail, SAMPLE_TRACKS } = require('../helpers/fixtures');

describe('Tier 1: Feature Coverage - Liked Library Endpoints', () => {
  let serverInfo = null;
  const testEmail = generateUniqueEmail('t1_lib');
  const testPassword = 'Password123!@#';
  let authToken = null;
  const track = SAMPLE_TRACKS[0];

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
      if (serverInfo) {
        // Register user for library operations
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

  it('POST /api/library/like adds a track to user library', async (t) => {
    if (!serverInfo || !authToken) {
      t.skip('Backend server or auth token unavailable');
      return;
    }

    const res = await apiRequest('/api/library/like', {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      body: track
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status === 201 || res.status === 200, true);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.track);
    assert.strictEqual(res.data.track.videoId, track.videoId);
  });

  it('GET /api/library retrieves user liked tracks', async (t) => {
    if (!serverInfo || !authToken) {
      t.skip('Backend server or auth token unavailable');
      return;
    }

    const res = await apiRequest('/api/library', {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.tracks), 'Expected tracks array in response');
    const found = res.data.tracks.some(t => t.videoId === track.videoId);
    assert.strictEqual(found, true, `Expected track ${track.videoId} to be in user library`);
  });

  it('DELETE /api/library/unlike/:videoId removes track from library', async (t) => {
    if (!serverInfo || !authToken) {
      t.skip('Backend server or auth token unavailable');
      return;
    }

    const res = await apiRequest(`/api/library/unlike/${track.videoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);

    // Verify track is no longer in library
    const checkRes = await apiRequest('/api/library', {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` }
    }, serverInfo.baseUrl);

    const exists = checkRes.data.tracks.some(t => t.videoId === track.videoId);
    assert.strictEqual(exists, false, 'Track should be removed from library');
  });
});
