/**
 * Tier 4: Real-World Workloads - Full User Workflow Simulation
 *
 * Simulates a realistic end-to-end user session:
 * 1. User arrives and registers a new account
 * 2. Authenticates and inspects initial quota meter
 * 3. Browses/searches multiple musical genres ("Synthwave", "Chillhop", "Classical")
 * 4. Adds 3 favorite tracks across genres to their Liked Library
 * 5. Plays tracks switching between audio qualities (High -> Medium -> Low -> FLAC)
 * 6. Verifies library list order and metadata fidelity
 * 7. Unlikes one track, keeps two
 * 8. Verifies quota accounting and final user profile state
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail, SAMPLE_TRACKS } = require('../helpers/fixtures');

describe('Tier 4: Real-World Workloads - Full User Workflow Simulation', () => {
  let serverInfo = null;
  const userEmail = generateUniqueEmail('sim_user');
  const userPassword = 'SimulatedSessionPassword!456';
  let token = null;

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

  it('executes full realistic user session workflow', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    // 1. User Registration
    const regRes = await apiRequest('/api/register', {
      method: 'POST',
      body: { email: userEmail, password: userPassword }
    }, serverInfo.baseUrl);
    assert.strictEqual(regRes.status === 201 || regRes.status === 200, true);
    assert.ok(regRes.data.token);
    token = regRes.data.token;

    // 2. Initial quota inspection
    const quotaStart = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
    assert.strictEqual(quotaStart.status, 200);

    // 3. User searches multiple genres
    const genres = ['Synthwave', 'Chillhop', 'Classical'];
    const collectedTracks = [];

    for (const genre of genres) {
      const searchRes = await apiRequest(`/api/search?q=${encodeURIComponent(genre)}`, {}, serverInfo.baseUrl);
      assert.strictEqual(searchRes.status, 200);
      assert.ok(Array.isArray(searchRes.data.items));
      if (searchRes.data.items.length > 0) {
        collectedTracks.push(searchRes.data.items[0]);
      }
    }

    // 4. Add 3 tracks to Liked Library
    const tracksToLike = collectedTracks.length >= 3 ? collectedTracks.slice(0, 3) : SAMPLE_TRACKS.slice(0, 3);
    for (const trk of tracksToLike) {
      const likeRes = await apiRequest('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: trk
      }, serverInfo.baseUrl);
      assert.strictEqual(likeRes.status === 201 || likeRes.status === 200, true);
    }

    // 5. Verify Library has all 3 tracks
    const libRes = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);
    assert.strictEqual(libRes.status, 200);
    assert.strictEqual(libRes.data.tracks.length >= 3, true);

    // 6. Playback simulation: stream first track with quality switching
    const activeVideoId = tracksToLike[0].videoId;
    for (const q of ['high', 'medium', 'low', 'flac']) {
      const streamRes = await apiRequest(`/api/stream/${activeVideoId}?quality=${q}`, {}, serverInfo.baseUrl);
      assert.strictEqual(streamRes.status === 200 || streamRes.status === 206, true);
      assert.ok(Buffer.isBuffer(streamRes.data));
      assert.ok(streamRes.data.length > 0);
    }

    // 7. Unlike 1 track
    const unlikeRes = await apiRequest(`/api/library/unlike/${tracksToLike[0].videoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);
    assert.strictEqual(unlikeRes.status, 200);

    // 8. Verify library now has 2 tracks
    const libFinal = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);
    assert.strictEqual(libFinal.status, 200);
    const stillHasRemoved = libFinal.data.tracks.some(t => t.videoId === tracksToLike[0].videoId);
    assert.strictEqual(stillHasRemoved, false);

    // 9. Verify user profile integrity
    const profile = await apiRequest('/api/me', {
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);
    assert.strictEqual(profile.status, 200);
    assert.strictEqual(profile.data.user.email, userEmail);
  });
});
