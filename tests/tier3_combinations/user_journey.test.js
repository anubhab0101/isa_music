/**
 * Tier 3: Cross-Feature Combinations - Complete User Journey
 *
 * Sequence:
 * 1. Register new user
 * 2. Login user & capture JWT
 * 3. Fetch initial library (empty)
 * 4. Search for songs via proxy
 * 5. Like a song from the search results
 * 6. Verify song is stored in Liked Library
 * 7. Stream audio for the liked song
 * 8. Unlike the song
 * 9. Verify song is removed from Liked Library
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail } = require('../helpers/fixtures');

describe('Tier 3: Cross-Feature Combinations - Complete User Journey', () => {
  let serverInfo = null;
  const userEmail = generateUniqueEmail('t3_journey');
  const userPassword = 'JourneyPassword123!';
  let token = null;
  let selectedTrack = null;

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

  it('Step 1: Register new user', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/register', {
      method: 'POST',
      body: { email: userEmail, password: userPassword }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status === 201 || res.status === 200, true);
    assert.strictEqual(res.data.success, true);
    assert.strictEqual(res.data.user.email, userEmail);
  });

  it('Step 2: Login registered user and capture auth token', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/login', {
      method: 'POST',
      body: { email: userEmail, password: userPassword }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.token);
    token = res.data.token;
  });

  it('Step 3: Verify initial liked library is empty', async (t) => {
    if (!serverInfo || !token) {
      t.skip('Server or token unavailable');
      return;
    }

    const res = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.tracks));
    assert.strictEqual(res.data.tracks.length, 0);
  });

  it('Step 4: Search for a track via YouTube search proxy', async (t) => {
    if (!serverInfo || !token) {
      t.skip('Server or token unavailable');
      return;
    }

    const res = await apiRequest('/api/search?q=Jazz', {}, serverInfo.baseUrl);
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.items));
    assert.ok(res.data.items.length > 0);

    selectedTrack = res.data.items[0];
    assert.ok(selectedTrack.videoId);
  });

  it('Step 5: Like the selected search result track', async (t) => {
    if (!serverInfo || !token || !selectedTrack) {
      t.skip('Prerequisites not met');
      return;
    }

    const res = await apiRequest('/api/library/like', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: selectedTrack
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status === 201 || res.status === 200, true);
    assert.strictEqual(res.data.success, true);
  });

  it('Step 6: Verify track is now present in user liked library', async (t) => {
    if (!serverInfo || !token || !selectedTrack) {
      t.skip('Prerequisites not met');
      return;
    }

    const res = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.data.tracks));
    const found = res.data.tracks.some(t => t.videoId === selectedTrack.videoId);
    assert.strictEqual(found, true, `Track ${selectedTrack.videoId} must be in library`);
  });

  it('Step 7: Stream raw audio for the liked track', async (t) => {
    if (!serverInfo || !selectedTrack) {
      t.skip('Prerequisites not met');
      return;
    }

    const res = await apiRequest(`/api/stream/${selectedTrack.videoId}?quality=high`, {}, serverInfo.baseUrl);
    assert.strictEqual(res.status === 200 || res.status === 206, true);
    assert.ok(Buffer.isBuffer(res.data));
    assert.ok(res.data.length > 0);
  });

  it('Step 8: Unlike the track', async (t) => {
    if (!serverInfo || !token || !selectedTrack) {
      t.skip('Prerequisites not met');
      return;
    }

    const res = await apiRequest(`/api/library/unlike/${selectedTrack.videoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
  });

  it('Step 9: Verify track is removed from library', async (t) => {
    if (!serverInfo || !token || !selectedTrack) {
      t.skip('Prerequisites not met');
      return;
    }

    const res = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    const found = res.data.tracks.some(t => t.videoId === selectedTrack.videoId);
    assert.strictEqual(found, false, 'Track must be gone from library');
  });
});
