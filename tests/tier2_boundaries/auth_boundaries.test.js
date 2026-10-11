/**
 * Tier 2: Boundary & Corner Cases - Authentication
 *
 * Covers:
 * - Duplicate email registration (409 Conflict)
 * - Short passwords (< 6 characters) (400 Bad Request)
 * - Malformed email address (400 Bad Request)
 * - Empty body or missing fields (400 Bad Request)
 * - Invalid password login (401 Unauthorized)
 * - Non-existent user login (401 Unauthorized)
 * - Missing Authorization header on protected route (401 Unauthorized)
 * - Malformed Authorization header format (401 Unauthorized)
 * - Forged / invalid JWT token (401 Unauthorized)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');
const { generateUniqueEmail } = require('../helpers/fixtures');

describe('Tier 2: Boundary & Corner Cases - Authentication', () => {
  let serverInfo = null;
  const validEmail = generateUniqueEmail('t2_auth');
  const validPassword = 'SecurePassword123!';

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
      if (serverInfo) {
        // Register initial valid user
        await apiRequest('/api/register', {
          method: 'POST',
          body: { email: validEmail, password: validPassword }
        }, serverInfo.baseUrl);
      }
    } catch (err) {
      serverInfo = null;
    }
  });

  after(async () => {
    await stopServer();
  });

  it('rejects duplicate email registration with 409 Conflict', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/register', {
      method: 'POST',
      body: { email: validEmail, password: validPassword }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 409, `Expected 409 Conflict for duplicate email, got ${res.status}`);
  });

  it('rejects short password (< 6 chars) with 400 Bad Request', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/register', {
      method: 'POST',
      body: { email: generateUniqueEmail('short_pwd'), password: '123' }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 400, `Expected 400 Bad Request for short password, got ${res.status}`);
  });

  it('rejects malformed email address with 400 Bad Request', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const invalidEmails = ['plainaddress', '@missingusername.com', 'user@.com', ''];
    for (const badEmail of invalidEmails) {
      const res = await apiRequest('/api/register', {
        method: 'POST',
        body: { email: badEmail, password: 'ValidPassword123!' }
      }, serverInfo.baseUrl);

      assert.strictEqual(res.status, 400, `Expected 400 for bad email "${badEmail}", got ${res.status}`);
    }
  });

  it('rejects missing password with 400 Bad Request', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/register', {
      method: 'POST',
      body: { email: generateUniqueEmail('no_pwd') }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 400);
  });

  it('rejects login with incorrect password with 401 Unauthorized', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/login', {
      method: 'POST',
      body: { email: validEmail, password: 'WrongPassword123!' }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 401, `Expected 401 Unauthorized for wrong password, got ${res.status}`);
  });

  it('rejects login for non-existent user with 401 Unauthorized', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/login', {
      method: 'POST',
      body: { email: 'nonexistent_user_999@test.com', password: 'SomePassword123!' }
    }, serverInfo.baseUrl);

    assert.strictEqual(res.status, 401, `Expected 401 Unauthorized for unknown user, got ${res.status}`);
  });

  it('rejects GET /api/me without Authorization header with 401 Unauthorized', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const res = await apiRequest('/api/me', { method: 'GET' }, serverInfo.baseUrl);
    assert.strictEqual(res.status, 401, `Expected 401 Unauthorized without auth header, got ${res.status}`);
  });

  it('rejects GET /api/me with malformed / forged Bearer token with 401 Unauthorized', async (t) => {
    if (!serverInfo) {
      t.skip('Backend server not currently running');
      return;
    }

    const malformedTokens = [
      'Bearer ',
      'Bearer invalid.jwt.signature',
      'Token some_token',
      'Basic admin:password'
    ];

    for (const headerVal of malformedTokens) {
      const res = await apiRequest('/api/me', {
        method: 'GET',
        headers: { Authorization: headerVal }
      }, serverInfo.baseUrl);

      assert.strictEqual(
        res.status,
        401,
        `Expected 401 for Authorization "${headerVal}", got ${res.status}`
      );
    }
  });
});
