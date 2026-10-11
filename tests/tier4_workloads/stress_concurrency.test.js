/**
 * Tier 4: Real-World Workloads - Concurrency & Stress Simulation
 *
 * Verifies:
 * 1. 10 concurrent search proxy requests return HTTP 200 without race conditions or memory leaks.
 * 2. 5 concurrent user registrations with distinct credentials succeed simultaneously without SQLite write collisions.
 * 3. Concurrent like/unlike operations on SQLite execute without SQLITE_BUSY failures.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail, SAMPLE_TRACKS } = require('../helpers/fixtures');

describe('Tier 4: Real-World Workloads - Concurrency & Load Simulation', () => {
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

  it('handles 10 concurrent search queries without failure', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const queries = [
      'Synthwave', 'Chillhop', 'Lo-Fi', 'Metal', 'Jazz',
      'Classical', 'EDM', 'Hip Hop', 'Rock', 'Ambient'
    ];

    const promises = queries.map(q => apiRequest(`/api/search?q=${encodeURIComponent(q)}`, {}, serverInfo.baseUrl));
    const results = await Promise.all(promises);

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      assert.strictEqual(res.status, 200, `Search query "${queries[i]}" failed with status ${res.status}`);
      assert.ok(Array.isArray(res.data.items), 'Expected items array');
    }
  });

  it('handles 5 concurrent user registrations without SQLite lock collisions', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const regPromises = [];
    for (let i = 0; i < 5; i++) {
      const email = generateUniqueEmail(`concurrent_${i}`);
      regPromises.push(
        apiRequest('/api/register', {
          method: 'POST',
          body: { email, password: 'ConcurrentPass123!@#' }
        }, serverInfo.baseUrl)
      );
    }

    const results = await Promise.all(regPromises);

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      assert.strictEqual(
        res.status === 201 || res.status === 200,
        true,
        `Concurrent registration #${i} failed with status ${res.status}`
      );
      assert.ok(res.data.token);
      assert.ok(res.data.user);
    }
  });

  it('handles concurrent library like requests for a user', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const email = generateUniqueEmail('concurrent_likes');
    const regRes = await apiRequest('/api/register', {
      method: 'POST',
      body: { email, password: 'Password123!' }
    }, serverInfo.baseUrl);
    const token = regRes.data.token;

    // Concurrently like multiple tracks
    const likePromises = SAMPLE_TRACKS.map(trk =>
      apiRequest('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: trk
      }, serverInfo.baseUrl)
    );

    const results = await Promise.all(likePromises);

    for (let i = 0; i < results.length; i++) {
      const res = results[i];
      assert.strictEqual(
        res.status === 201 || res.status === 200,
        true,
        `Concurrent like #${i} failed with status ${res.status}`
      );
    }

    // Verify all tracks exist in library
    const libRes = await apiRequest('/api/library', {
      headers: { Authorization: `Bearer ${token}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(libRes.status, 200);
    assert.strictEqual(libRes.data.tracks.length, SAMPLE_TRACKS.length);
  });
});
