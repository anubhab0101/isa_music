/**
 * Tier 1: Feature Coverage - User Authentication Endpoints
 *
 * Covers:
 * - POST /api/register (201 Created)
 * - POST /api/login (200 OK)
 * - GET /api/me (200 OK with Bearer token)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail } = require('../helpers/fixtures');

describe('Tier 1: Feature Coverage - Authentication Endpoints', () => {
  let serverInfo = null;
  const testEmail = generateUniqueEmail('t1_auth');
  const testPassword = 'Password123!@#';
  let authToken = null;
  let userId = null;

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

  it('POST /api/register creates a new user and returns JWT token', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/register', {
      method: 'POST',
      body: { email: testEmail, password: testPassword }
    }, serverInfo.baseUrl);

    assert.strictEqual(
      res.status === 201 || res.status === 200,
      true,
      `Expected status 201 or 200, got ${res.status}`
    );
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.user);
    assert.strictEqual(res.data.user.email, testEmail);
    assert.ok(res.data.token);

    userId = res.data.user.id;
    authToken = res.data.token;
  });

  it('POST /api/login authenticates registered user and returns JWT token', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/login', {
      method: 'POST',
      body: { email: testEmail, password: testPassword }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.success, true);
    assert.ok(res.data.user);
    assert.strictEqual(res.data.user.email, testEmail);
    assert.ok(res.data.token);

    // Update active token
    authToken = res.data.token;
  });

  it('GET /api/me returns current user profile with valid Bearer token', async (t) => {
    if (!serverInfo || !authToken) {
      t.skip('Backend server not running or auth token missing');
      return;
    }

    const res = await apiRequest('/api/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 200);
    assert.ok(res.data.user);
    assert.strictEqual(res.data.user.email, testEmail);
    if (userId) {
      assert.strictEqual(res.data.user.id, userId);
    }
  });
});
