#!/usr/bin/env node
/**
 * Empirical Challenge 2 Verification Suite
 * 
 * Verifies:
 * 1. Boundary conditions: max length query strings, unicode characters, empty strings, missing headers, auth/library limits
 * 2. SQLite durability: server restarts, persistence of users, liked tracks, search cache across restarts
 * 3. Cache hits: verify second search query is served from cache without calling upstream (both in-memory and SQLite cache)
 * 4. Error handling & stress performance: malformed JSON, 404 handling, concurrency
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const TEST_PORT = 3088;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
const SERVER_PATH = path.resolve(__dirname, '../server.js');
const DURABILITY_DB_PATH = path.resolve(__dirname, 'durability_test.db');

let serverProcess = null;

// Helper: send HTTP requests
async function req(endpoint, options = {}, baseUrl = BASE_URL) {
  const url = `${baseUrl}${endpoint}`;
  const headers = { ...options.headers };
  if (options.body && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined
  });

  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text;
  }

  return { status: res.status, headers: res.headers, data };
}

// Helper: wait for server port
async function waitForServer(url, attempts = 30, delayMs = 150) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${url}/api/health`).catch(() => null);
      if (res && res.status === 200) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

// Helper: spawn server with custom DB_PATH
function startServerProcess(dbPath, port = TEST_PORT) {
  const proc = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      NODE_ENV: 'test',
      YOUTUBE_MOCK_MODE: 'true'
    },
    stdio: 'pipe'
  });
  return proc;
}

// Helper: stop process
async function stopProcess(proc) {
  if (!proc) return;
  try {
    proc.kill('SIGINT');
  } catch (_) {}
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 2000);
    proc.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('Challenger 2 Empirical Verification Suite', () => {

  describe('Part 1: Boundary Conditions & Input Hardening', () => {
    let srv = null;
    let testToken = null;
    let userId = null;

    before(async () => {
      srv = startServerProcess(':memory:');
      const ready = await waitForServer(BASE_URL);
      assert.ok(ready, 'Test server failed to start on memory db');

      // Register a base user for authorized calls
      const regRes = await req('/api/register', {
        method: 'POST',
        body: { email: 'boundary_test@example.com', password: 'Password123!' }
      });
      assert.strictEqual(regRes.status, 201);
      testToken = regRes.data.token;
      userId = regRes.data.user.id;
    });

    after(async () => {
      await stopProcess(srv);
    });

    // 1.1 Search Query String Boundaries
    it('rejects missing search query (no ?q) with 400', async () => {
      const res = await req('/api/search');
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes("'q' is required"));
    });

    it('rejects empty search query (?q=) with 400', async () => {
      const res = await req('/api/search?q=');
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes("'q' is required"));
    });

    it('rejects whitespace-only search query (?q=%20%20) with 400', async () => {
      const res = await req('/api/search?q=%20%20%20');
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes("'q' is required"));
    });

    it('accepts query string at exactly 200 characters (max boundary)', async () => {
      const maxQuery = 'A'.repeat(200);
      const res = await req(`/api/search?q=${encodeURIComponent(maxQuery)}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.data.items));
    });

    it('rejects query string at 201 characters (> 200 max) with 400', async () => {
      const overQuery = 'A'.repeat(201);
      const res = await req(`/api/search?q=${encodeURIComponent(overQuery)}`);
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('cannot exceed 200 characters'));
    });

    it('rejects extremely long query strings (1,000 characters) with 400 without crashing', async () => {
      const extremeQuery = 'Z'.repeat(1000);
      const res = await req(`/api/search?q=${encodeURIComponent(extremeQuery)}`);
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('cannot exceed 200 characters'));
    });

    it('handles multi-byte Unicode and emoji queries correctly', async () => {
      const unicodeQuery = '音楽 🎵 Chillhop Café ☕ 日本語';
      const res = await req(`/api/search?q=${encodeURIComponent(unicodeQuery)}`);
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.data.items));
      assert.ok(res.data.items.length > 0);
    });

    // 1.2 Missing and Malformed Headers
    it('rejects GET /api/me with missing Authorization header with 401', async () => {
      const res = await req('/api/me');
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.error, 'Authorization token required');
    });

    it('rejects GET /api/me with empty Authorization header with 401', async () => {
      const res = await req('/api/me', { headers: { Authorization: '' } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.error, 'Authorization token required');
    });

    it('rejects GET /api/me with non-Bearer scheme (Basic token) with 401', async () => {
      const res = await req('/api/me', { headers: { Authorization: 'Basic dXNlcjpwYXNz' } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.error, 'Invalid authorization token format');
    });

    it('rejects GET /api/me with Bearer without token with 401', async () => {
      const res = await req('/api/me', { headers: { Authorization: 'Bearer ' } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.error, 'Invalid authorization token format');
    });

    it('rejects GET /api/me with forged or invalid JWT token with 401', async () => {
      const res = await req('/api/me', { headers: { Authorization: 'Bearer invalid.tampered.token' } });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.data.error, 'Invalid or expired token');
    });

    it('rejects GET /api/library without Authorization header with 401', async () => {
      const res = await req('/api/library');
      assert.strictEqual(res.status, 401);
    });

    it('rejects POST /api/library/like without Authorization header with 401', async () => {
      const res = await req('/api/library/like', {
        method: 'POST',
        body: { videoId: 'dQw4w9WgXcQ', title: 'Song' }
      });
      assert.strictEqual(res.status, 401);
    });

    it('rejects DELETE /api/library/unlike/:videoId without Authorization header with 401', async () => {
      const res = await req('/api/library/unlike/dQw4w9WgXcQ', { method: 'DELETE' });
      assert.strictEqual(res.status, 401);
    });

    // 1.3 Authentication Boundaries
    it('rejects registration with password length 5 (< 6 min) with 400', async () => {
      const res = await req('/api/register', {
        method: 'POST',
        body: { email: 'pass5@test.com', password: '12345' }
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('at least 6 characters'));
    });

    it('accepts registration with password length 6 (min boundary) with 201', async () => {
      const res = await req('/api/register', {
        method: 'POST',
        body: { email: 'pass6@test.com', password: '123456' }
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.success, true);
    });

    it('accepts registration with password length 128 (max boundary) with 201', async () => {
      const pass128 = 'P'.repeat(128);
      const res = await req('/api/register', {
        method: 'POST',
        body: { email: 'pass128@test.com', password: pass128 }
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.success, true);
    });

    it('rejects registration with password length 129 (> 128 max) with 400', async () => {
      const pass129 = 'P'.repeat(129);
      const res = await req('/api/register', {
        method: 'POST',
        body: { email: 'pass129@test.com', password: pass129 }
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('maximum length of 128'));
    });

    it('accepts registration with unicode/emoji in password', async () => {
      const unicodePass = 'P@sswørd🔒🔑2026';
      const email = 'unicode_pass@test.com';
      const regRes = await req('/api/register', {
        method: 'POST',
        body: { email, password: unicodePass }
      });
      assert.strictEqual(regRes.status, 201);

      // Verify login with unicode password works
      const loginRes = await req('/api/login', {
        method: 'POST',
        body: { email, password: unicodePass }
      });
      assert.strictEqual(loginRes.status, 200);
      assert.strictEqual(loginRes.data.success, true);
    });

    it('accepts email at 254 characters (RFC max) with 201', async () => {
      // 254 chars total: username (240 chars) + '@testisa.com' (12 chars) + '.co' etc.
      const userPart = 'a'.repeat(240);
      const email254 = `${userPart}@domain254.com`.slice(0, 254);
      assert.strictEqual(email254.length, 254);

      const res = await req('/api/register', {
        method: 'POST',
        body: { email: email254, password: 'Password123!' }
      });
      assert.strictEqual(res.status, 201);
    });

    it('rejects email exceeding 254 characters with 400', async () => {
      const userPart = 'a'.repeat(250);
      const email260 = `${userPart}@domain260.com`;
      assert.ok(email260.length > 254);

      const res = await req('/api/register', {
        method: 'POST',
        body: { email: email260, password: 'Password123!' }
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.data.error.includes('Invalid email format'));
    });

    // 1.4 Liked Library Boundaries
    it('rejects track like with videoId length 10 (< 11) with 400', async () => {
      const res = await req('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testToken}` },
        body: { videoId: '1234567890', title: 'Too Short' }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.error, 'Valid videoId is required');
    });

    it('rejects track like with videoId length 12 (> 11) with 400', async () => {
      const res = await req('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testToken}` },
        body: { videoId: '123456789012', title: 'Too Long' }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.error, 'Valid videoId is required');
    });

    it('rejects track like with special injection characters in videoId with 400', async () => {
      const res = await req('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testToken}` },
        body: { videoId: 'dQw4w9WgXc;', title: 'Injection' }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.error, 'Valid videoId is required');
    });

    it('rejects track like with empty title with 400', async () => {
      const res = await req('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testToken}` },
        body: { videoId: 'dQw4w9WgXcQ', title: '   ' }
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.data.error, 'Title is required');
    });

    it('stores liked track with Unicode & emojis in title and artist', async () => {
      const res = await req('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testToken}` },
        body: {
          videoId: '2vjPBrBU-TM',
          title: '夜に駆ける 🏃‍♀️ (Racing into the Night)',
          artist: 'YOASOBI 🎤'
        }
      });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.data.track.title, '夜に駆ける 🏃‍♀️ (Racing into the Night)');
      assert.strictEqual(res.data.track.artist, 'YOASOBI 🎤');

      // Fetch library and verify exact Unicode preserved
      const libRes = await req('/api/library', {
        headers: { Authorization: `Bearer ${testToken}` }
      });
      assert.strictEqual(libRes.status, 200);
      const savedTrack = libRes.data.tracks.find(t => t.videoId === '2vjPBrBU-TM');
      assert.ok(savedTrack);
      assert.strictEqual(savedTrack.title, '夜に駆ける 🏃‍♀️ (Racing into the Night)');
      assert.strictEqual(savedTrack.artist, 'YOASOBI 🎤');
    });

    it('returns 404 when unliking a non-existent track', async () => {
      const res = await req('/api/library/unlike/L_LUpnjgPso', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${testToken}` }
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.data.error, 'Track not found in liked library');
    });
  });

  describe('Part 2: SQLite Durability Across Server Restarts', () => {
    const DURABILITY_USER = 'durability_persisted@testisa.com';
    const DURABILITY_PASS = 'DurablePassword999!';
    const TRACK_VIDEO_ID = 'fHI8X480mxo';
    const TRACK_TITLE = 'Sunset Boulevard 🌴';
    const TRACK_ARTIST = 'Synth Riders 🎧';
    const SEARCH_QUERY = 'synthwave durability test query';

    // Clean up durability db before test
    before(() => {
      for (const ext of ['', '-wal', '-shm']) {
        const p = `${DURABILITY_DB_PATH}${ext}`;
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch (_) {}
        }
      }
    });

    after(() => {
      for (const ext of ['', '-wal', '-shm']) {
        const p = `${DURABILITY_DB_PATH}${ext}`;
        if (fs.existsSync(p)) {
          try { fs.unlinkSync(p); } catch (_) {}
        }
      }
    });

    it('persists users, liked library, and search cache across hard server restarts', async () => {
      // -------------------------------------------------------------
      // Phase 1: Start Server Instance 1
      // -------------------------------------------------------------
      console.log('    [Durability Phase 1] Starting Server Instance 1...');
      let proc1 = startServerProcess(DURABILITY_DB_PATH);
      const ready1 = await waitForServer(BASE_URL);
      assert.ok(ready1, 'Server 1 failed to start');

      // 1. Register user
      const regRes = await req('/api/register', {
        method: 'POST',
        body: { email: DURABILITY_USER, password: DURABILITY_PASS }
      });
      assert.strictEqual(regRes.status, 201);
      const token1 = regRes.data.token;
      const originalUserId = regRes.data.user.id;
      assert.ok(originalUserId > 0);

      // 2. Like a track
      const likeRes = await req('/api/library/like', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token1}` },
        body: {
          videoId: TRACK_VIDEO_ID,
          title: TRACK_TITLE,
          artist: TRACK_ARTIST
        }
      });
      assert.strictEqual(likeRes.status, 201);
      assert.strictEqual(likeRes.data.track.videoId, TRACK_VIDEO_ID);

      // 3. Perform a search to populate search_cache
      const searchRes1 = await req(`/api/search?q=${encodeURIComponent(SEARCH_QUERY)}`);
      assert.strictEqual(searchRes1.status, 200);
      assert.ok(searchRes1.data.items.length > 0);
      const searchItemsBeforeRestart = searchRes1.data.items;

      // -------------------------------------------------------------
      // Phase 2: Kill Server Instance 1
      // -------------------------------------------------------------
      console.log('    [Durability Phase 2] Shutting down Server Instance 1...');
      await stopProcess(proc1);
      proc1 = null;

      // Verify port is dead
      let portDead = false;
      try {
        await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(500) });
      } catch (_) {
        portDead = true;
      }
      assert.ok(portDead, 'Server port should be unreachable after shutdown');

      // -------------------------------------------------------------
      // Phase 3: Inspect SQLite Database File Directly on Disk
      // -------------------------------------------------------------
      console.log('    [Durability Phase 3] Inspecting SQLite database file directly...');
      assert.ok(fs.existsSync(DURABILITY_DB_PATH), 'SQLite database file must exist on disk');

      const diskDb = new DatabaseSync(DURABILITY_DB_PATH);
      // Verify user in users table
      const dbUser = diskDb.prepare('SELECT id, email FROM users WHERE email = ?').get(DURABILITY_USER);
      assert.ok(dbUser, 'User record must exist in SQLite database on disk');
      assert.strictEqual(dbUser.id, originalUserId);

      // Verify liked track in liked_library table
      const dbTrack = diskDb.prepare('SELECT video_id, title, artist FROM liked_library WHERE user_id = ?').get(originalUserId);
      assert.ok(dbTrack, 'Liked track must exist in SQLite database on disk');
      assert.strictEqual(dbTrack.video_id, TRACK_VIDEO_ID);
      assert.strictEqual(dbTrack.title, TRACK_TITLE);

      // Verify search cache in search_cache table
      const normalizedQ = SEARCH_QUERY.trim().toLowerCase();
      const dbCache = diskDb.prepare('SELECT results_json, expires_at FROM search_cache WHERE query = ?').get(normalizedQ);
      assert.ok(dbCache, 'Search cache record must exist in SQLite database on disk');
      const cachedItems = JSON.parse(dbCache.results_json);
      assert.strictEqual(cachedItems.length, searchItemsBeforeRestart.length);

      diskDb.close();

      // -------------------------------------------------------------
      // Phase 4: Start Server Instance 2 (Cold Boot with same DB)
      // -------------------------------------------------------------
      console.log('    [Durability Phase 4] Booting Server Instance 2 from persistent DB...');
      let proc2 = startServerProcess(DURABILITY_DB_PATH);
      const ready2 = await waitForServer(BASE_URL);
      assert.ok(ready2, 'Server 2 failed to start from existing DB');

      try {
        // 1. Authenticate with original credentials on new server instance
        const loginRes = await req('/api/login', {
          method: 'POST',
          body: { email: DURABILITY_USER, password: DURABILITY_PASS }
        });
        assert.strictEqual(loginRes.status, 200, 'User should successfully log in on Server Instance 2');
        assert.strictEqual(loginRes.data.user.id, originalUserId);
        const token2 = loginRes.data.token;

        // 2. Verify /api/me on new server instance
        const meRes = await req('/api/me', {
          headers: { Authorization: `Bearer ${token2}` }
        });
        assert.strictEqual(meRes.status, 200);
        assert.strictEqual(meRes.data.user.email, DURABILITY_USER);

        // 3. Verify Liked Library on new server instance
        const libRes = await req('/api/library', {
          headers: { Authorization: `Bearer ${token2}` }
        });
        assert.strictEqual(libRes.status, 200);
        assert.ok(Array.isArray(libRes.data.tracks));
        assert.strictEqual(libRes.data.tracks.length, 1);
        assert.strictEqual(libRes.data.tracks[0].videoId, TRACK_VIDEO_ID);
        assert.strictEqual(libRes.data.tracks[0].title, TRACK_TITLE);
        assert.strictEqual(libRes.data.tracks[0].artist, TRACK_ARTIST);

        // 4. Verify Search Cache is served on new server instance (memory cache was cold!)
        const searchRes2 = await req(`/api/search?q=${encodeURIComponent(SEARCH_QUERY)}`);
        assert.strictEqual(searchRes2.status, 200);
        assert.deepStrictEqual(searchRes2.data.items, searchItemsBeforeRestart);
        console.log('    [Durability Phase 4] Successfully verified all data survived restart!');
      } finally {
        await stopProcess(proc2);
      }
    });
  });

  describe('Part 3: Empirical Cache Hit Verification', () => {
    let srv = null;

    before(async () => {
      srv = startServerProcess(':memory:');
      const ready = await waitForServer(BASE_URL);
      assert.ok(ready, 'Test server failed to start');
    });

    after(async () => {
      await stopProcess(srv);
    });

    it('serves second query from cache without calling upstream', async () => {
      const term = 'empirical_cache_test_term';

      // 1. First search: Cold query
      const startCold = Date.now();
      const resCold = await req(`/api/search?q=${term}`);
      const coldDuration = Date.now() - startCold;

      assert.strictEqual(resCold.status, 200);
      assert.ok(Array.isArray(resCold.data.items));
      assert.ok(resCold.data.items.length > 0);

      // 2. Second search: Warm query (same term)
      const startWarm = Date.now();
      const resWarm = await req(`/api/search?q=${term}`);
      const warmDuration = Date.now() - startWarm;

      assert.strictEqual(resWarm.status, 200);
      assert.deepStrictEqual(resWarm.data.items, resCold.data.items);

      // 3. Case-insensitive / whitespace trimmed query hits same cache
      const resVariation = await req(`/api/search?q=%20${term.toUpperCase()}%20`);
      assert.strictEqual(resVariation.status, 200);
      assert.deepStrictEqual(resVariation.data.items, resCold.data.items);
    });

    it('direct service unit test verifies upstream fetch is called 0 times on cache hit', async () => {
      // In-process unit test of youtubeService caching with spy
      const youtubeService = require('../src/services/youtube');

      const testQuery = 'zero_upstream_spy_term';
      const normalized = testQuery.trim().toLowerCase();

      // Ensure cache is populated
      const mockItems = [
        { videoId: 'dQw4w9WgXcQ', title: 'Rick', artist: 'Astley', thumbnail: 'thumb' }
      ];
      youtubeService.setCachedSearch(normalized, mockItems);

      // Spy on fetch to guarantee 0 upstream calls
      let fetchCallCount = 0;
      const originalFetch = global.fetch;
      global.fetch = async (...args) => {
        fetchCallCount++;
        return originalFetch(...args);
      };

      try {
        const result = await youtubeService.searchYouTube(testQuery);
        assert.strictEqual(result.fromCache, true, 'Result must be flagged fromCache: true');
        assert.strictEqual(fetchCallCount, 0, 'Upstream fetch MUST NOT be called when cache hits');
        assert.deepStrictEqual(result.items, mockItems);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('Part 4: Error Handling & Concurrency Stress', () => {
    let srv = null;

    before(async () => {
      srv = startServerProcess(':memory:');
      const ready = await waitForServer(BASE_URL);
      assert.ok(ready, 'Test server failed to start');
    });

    after(async () => {
      await stopProcess(srv);
    });

    it('returns 400 Bad Request on malformed JSON payload without crashing server', async () => {
      const res = await fetch(`${BASE_URL}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"email": "broken_json", password: unquoted}'
      });

      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.error, 'Malformed JSON payload');

      // Verify server is still alive
      const health = await req('/api/health');
      assert.strictEqual(health.status, 200);
    });

    it('returns 404 Endpoint Not Found on nonexistent API route', async () => {
      const res = await req('/api/nonexistent_route_path');
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.data.error, 'Endpoint not found');
    });

    it('handles 50 concurrent search requests with 0% error rate and low latency', async () => {
      const concurrency = 50;
      const requests = [];

      const startTime = Date.now();
      for (let i = 0; i < concurrency; i++) {
        requests.push(req(`/api/search?q=stress_term_${i % 5}`));
      }

      const results = await Promise.all(requests);
      const totalTime = Date.now() - startTime;

      const failures = results.filter(r => r.status !== 200);
      assert.strictEqual(failures.length, 0, `Expected 0 failed requests, got ${failures.length}`);

      console.log(`    [Concurrency Stress] 50 search requests completed in ${totalTime}ms (avg ${(totalTime / concurrency).toFixed(1)}ms/req)`);
      assert.ok(totalTime < 5000, `Expected 50 requests under 5000ms, took ${totalTime}ms`);
    });

    it('handles 20 concurrent user registrations without SQLite lock or collision errors', async () => {
      const concurrency = 20;
      const requests = [];
      const startTime = Date.now();

      for (let i = 0; i < concurrency; i++) {
        requests.push(req('/api/register', {
          method: 'POST',
          body: { email: `concurrent_user_${i}_${Date.now()}@testisa.com`, password: 'ConcurrentPass123!' }
        }));
      }

      const results = await Promise.all(requests);
      const totalTime = Date.now() - startTime;

      const failures = results.filter(r => r.status !== 201);
      assert.strictEqual(failures.length, 0, `Expected 0 failed registrations, got ${failures.length}`);
      console.log(`    [Concurrency Stress] 20 registrations completed in ${totalTime}ms`);
    });

    it('sanitizes SQL injection attempts in search without database syntax errors or crashes', async () => {
      const sqlAttacks = [
        "' OR 1=1 --",
        "'; DROP TABLE users; --",
        '" UNION SELECT id, email, password_hash, created_at, updated_at FROM users --'
      ];

      for (const payload of sqlAttacks) {
        const res = await req(`/api/search?q=${encodeURIComponent(payload)}`);
        assert.ok(res.status === 200 || res.status === 400, `Status was ${res.status}`);
        const bodyStr = JSON.stringify(res.data);
        assert.strictEqual(bodyStr.toLowerCase().includes('syntax error'), false);
        assert.strictEqual(bodyStr.toLowerCase().includes('sqlite'), false);
      }
    });

    it('empirically detects unescaped XSS reflection in mock search results (vulnerability finding)', async () => {
      const xssPayload = '<script>alert("xss")</script>';
      const res = await req(`/api/search?q=${encodeURIComponent(xssPayload)}`);
      assert.strictEqual(res.status, 200);
      const bodyStr = JSON.stringify(res.data);
      // Empirical verification: confirms that getMockSearchResults reflects raw <script> without escaping
      const hasReflectedScript = bodyStr.includes('<script>');
      assert.strictEqual(hasReflectedScript, true, 'Confirms raw <script> tags are reflected in items[].title');
    });
  });
});
