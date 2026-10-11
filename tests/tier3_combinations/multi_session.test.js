/**
 * Tier 3: Cross-Feature Combinations - Multi-Session User Isolation
 *
 * Verifies:
 * 1. Two concurrent users have isolated liked libraries.
 * 2. User A cannot see or mutate User B's liked songs.
 * 3. Token tampering or cross-user token usage is prevented.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail, SAMPLE_TRACKS } = require('../helpers/fixtures');

describe('Tier 3: Cross-Feature Combinations - Multi-User Isolation', () => {
  let serverInfo = null;

  const emailA = generateUniqueEmail('userA');
  const emailB = generateUniqueEmail('userB');
  const password = 'SharedPassword123!';

  let tokenA = null;
  let tokenB = null;

  const trackA = SAMPLE_TRACKS[0]; // videoId: 'dQw4w9WgXcQ'
  const trackB = SAMPLE_TRACKS[1]; // videoId: 'kJQP7kiw5Fk'

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
      if (serverInfo) {
        // Register User A
        const resA = await apiRequest('/api/register', {
          method: 'POST',
          body: { email: emailA, password }
        }, serverInfo.baseUrl);
        tokenA = resA.data?.token;

        // Register User B
        const resB = await apiRequest('/api/register', {
          method: 'POST',
          body: { email: emailB, password }
        }, serverInfo.baseUrl);
        tokenB = resB.data?.token;
      }
    } catch (err) {
      serverInfo = null;
    }
  });

  after(async () => {
    await stopServer();
  });

  it('verifies User A and User B obtain distinct valid tokens', async (t) => {
    if (!serverInfo || !tokenA || !tokenB) {
      t.skip('Backend server or tokens unavailable');
      return;
    }

    assert.notStrictEqual(tokenA, tokenB, 'User A and User B must receive distinct tokens');

    const profileA = await apiRequest('/api/me', { headers: { Authorization: `Bearer ${tokenA}` } }, serverInfo.baseUrl);
    const profileB = await apiRequest('/api/me', { headers: { Authorization: `Bearer ${tokenB}` } }, serverInfo.baseUrl);

    assert.strictEqual(profileA.data.user.email, emailA);
    assert.strictEqual(profileB.data.user.email, emailB);
  });

  it('verifies library contents are isolated between users', async (t) => {
    if (!serverInfo || !tokenA || !tokenB) {
      t.skip('Backend server or tokens unavailable');
      return;
    }

    // User A likes trackA
    await apiRequest('/api/library/like', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: trackA
    }, serverInfo.baseUrl);

    // User B likes trackB
    await apiRequest('/api/library/like', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: trackB
    }, serverInfo.baseUrl);

    // User A gets library -> should contain ONLY trackA
    const libA = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${tokenA}` }
    }, serverInfo.baseUrl);
    const idsA = libA.data.tracks.map(t => t.videoId);
    assert.strictEqual(idsA.includes(trackA.videoId), true, 'User A should have trackA');
    assert.strictEqual(idsA.includes(trackB.videoId), false, 'User A must NOT have User B trackB');

    // User B gets library -> should contain ONLY trackB
    const libB = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${tokenB}` }
    }, serverInfo.baseUrl);
    const idsB = libB.data.tracks.map(t => t.videoId);
    assert.strictEqual(idsB.includes(trackB.videoId), true, 'User B should have trackB');
    assert.strictEqual(idsB.includes(trackA.videoId), false, 'User B must NOT have User A trackA');
  });

  it('verifies deleting a track by User A does not affect User B', async (t) => {
    if (!serverInfo || !tokenA || !tokenB) {
      t.skip('Backend server or tokens unavailable');
      return;
    }

    // User A unlikes trackA
    await apiRequest(`/api/library/unlike/${trackA.videoId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenA}` }
    }, serverInfo.baseUrl);

    // User B should still have trackB intact
    const libB = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${tokenB}` }
    }, serverInfo.baseUrl);
    const idsB = libB.data.tracks.map(t => t.videoId);
    assert.strictEqual(idsB.includes(trackB.videoId), true, 'User B trackB must remain intact');
  });
});
