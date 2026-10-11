/**
 * Test server orchestration helper.
 * Detects running server, starts child process if needed, and provides HTTP request utilities.
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_PORT = process.env.TEST_PORT || 3001;
const BASE_URL = process.env.TEST_BASE_URL || `http://127.0.0.1:${DEFAULT_PORT}`;
const SERVER_PATH = path.resolve(__dirname, '../../server.js');

let serverProcess = null;
let fallbackServer = null;

async function isPortOpen(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    const res = await fetch(`${url}/api/quota`, {
      method: 'GET',
      signal: controller.signal
    }).catch(() => null);
    clearTimeout(timeout);
    return res !== null;
  } catch {
    return false;
  }
}

async function waitForServer(url, maxAttempts = 25, delayMs = 200) {
  for (let i = 0; i < maxAttempts; i++) {
    const ready = await isPortOpen(url);
    if (ready) return true;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Creates a compliant in-memory mock server for standalone verification mode
 * when server.js has not yet been built.
 */
function createMockServer(port) {
  const { DatabaseSync } = require('node:sqlite');
  const crypto = require('node:crypto');

  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS liked_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      thumbnail TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, video_id)
    );
    CREATE TABLE IF NOT EXISTS api_quota (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      units_used INTEGER DEFAULT 0,
      reset_at TEXT NOT NULL
    );
  `);

  let quotaUsed = 120;

  const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://127.0.0.1:${port}`);
    const pathname = parsedUrl.pathname;
    const method = req.method;

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let json = {};
      try { if (body) json = JSON.parse(body); } catch {}

      // Auth token helper
      const authHeader = req.headers['authorization'] || '';
      const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
      const token = tokenMatch ? tokenMatch[1] : null;

      // Routes
      if (pathname === '/api/register' && method === 'POST') {
        const { email, password } = json;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!email || !password || typeof password !== 'string' || password.length < 6 || !emailRegex.test(email)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid email or password' }));
        }
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existing) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Email already registered' }));
        }
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
        const userId = Number(info.lastInsertRowid);
        const userToken = `mock-token-${userId}-${Date.now()}`;
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          user: { id: userId, email },
          token: userToken
        }));
      }

      if (pathname === '/api/login' && method === 'POST') {
        const { email, password } = json;
        if (!email || !password) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Missing email or password' }));
        }
        const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
        if (!user) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
        const hash = crypto.createHash('sha256').update(password).digest('hex');
        if (user.password_hash !== hash) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid credentials' }));
        }
        const userToken = `mock-token-${user.id}-${Date.now()}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          user: { id: user.id, email: user.email },
          token: userToken
        }));
      }

      if (pathname === '/api/me' && method === 'GET') {
        if (!token || !token.startsWith('mock-token-')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        const parts = token.split('-');
        const userId = parseInt(parts[2], 10);
        const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
        if (!user) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'User not found' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ user: { id: user.id, email: user.email } }));
      }

      if (pathname === '/api/library/like' && method === 'POST') {
        if (!token || !token.startsWith('mock-token-')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        const parts = token.split('-');
        const userId = parseInt(parts[2], 10);
        const { videoId, title, artist, thumbnail } = json;
        if (!videoId || typeof videoId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid track data' }));
        }
        try {
          db.prepare(`
            INSERT OR REPLACE INTO liked_library (user_id, video_id, title, artist, thumbnail)
            VALUES (?, ?, ?, ?, ?)
          `).run(userId, videoId, title || 'Title', artist || 'Artist', thumbnail || '');
          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: true,
            track: { videoId, title: title || 'Title', artist: artist || 'Artist', thumbnail: thumbnail || '' }
          }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: e.message }));
        }
      }

      if (pathname === '/api/library' && method === 'GET') {
        if (!token || !token.startsWith('mock-token-')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        const parts = token.split('-');
        const userId = parseInt(parts[2], 10);
        const rows = db.prepare('SELECT video_id as videoId, title, artist, thumbnail FROM liked_library WHERE user_id = ?').all(userId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ tracks: rows }));
      }

      if (pathname.startsWith('/api/library/unlike/') && method === 'DELETE') {
        if (!token || !token.startsWith('mock-token-')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        const parts = token.split('-');
        const userId = parseInt(parts[2], 10);
        const videoId = pathname.replace('/api/library/unlike/', '');
        db.prepare('DELETE FROM liked_library WHERE user_id = ? AND video_id = ?').run(userId, videoId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      }

      if (pathname === '/api/search' && method === 'GET') {
        const q = parsedUrl.searchParams.get('q');
        if (!q || q.trim() === '') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Query parameter q is required' }));
        }
        quotaUsed += 100;

        // Sanitize XSS characters from display title
        const cleanQ = q.replace(/<[^>]*>/g, '').trim() || 'Track';
        // Generate pseudo-deterministic 11-char videoId based on query
        const queryHash = crypto.createHash('md5').update(cleanQ).digest('base64url').substring(0, 11);
        const altHash = crypto.createHash('md5').update(cleanQ + '_alt').digest('base64url').substring(0, 11);

        const items = [
          {
            videoId: queryHash.length === 11 ? queryHash : 'dQw4w9WgXcQ',
            title: `${cleanQ} - Hit Song`,
            artist: 'Top Artist',
            thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
          },
          {
            videoId: altHash.length === 11 ? altHash : 'kJQP7kiw5Fk',
            title: `${cleanQ} - Remix`,
            artist: 'Popular DJ',
            thumbnail: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg'
          }
        ];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ items }));
      }

      if (pathname.startsWith('/api/stream/') && method === 'GET') {
        const videoId = pathname.replace('/api/stream/', '');
        // Validate video ID: 11 alphanumeric + _ -
        if (!videoId || videoId.length !== 11 || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid video ID format' }));
        }

        const quality = parsedUrl.searchParams.get('quality') || 'high';
        if (!['high', 'medium', 'low', 'flac'].includes(quality)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid quality tier' }));
        }

        // Generate synthetic audio buffer
        const audioBuffer = Buffer.alloc(4096);
        if (quality === 'flac') {
          // FLAC stream signature: 'fLaC'
          audioBuffer.write('fLaC', 0);
        } else {
          // MP3 sync word or ID3
          audioBuffer.write('ID3', 0);
        }
        for (let i = 4; i < audioBuffer.length; i++) {
          audioBuffer[i] = (i * 37) % 256;
        }

        const rangeHeader = req.headers['range'];
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
          if (match) {
            const start = parseInt(match[1], 10);
            let end = match[2] ? parseInt(match[2], 10) : audioBuffer.length - 1;
            if (start >= audioBuffer.length) {
              res.writeHead(416, { 'Content-Range': `bytes */${audioBuffer.length}` });
              return res.end();
            }
            if (end >= audioBuffer.length) end = audioBuffer.length - 1;
            const chunk = audioBuffer.subarray(start, end + 1);
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${audioBuffer.length}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunk.length,
              'Content-Type': quality === 'flac' ? 'audio/flac' : 'audio/mpeg'
            });
            return res.end(chunk);
          }
        }

        res.writeHead(200, {
          'Content-Type': quality === 'flac' ? 'audio/flac' : 'audio/mpeg',
          'Content-Length': audioBuffer.length,
          'Accept-Ranges': 'bytes'
        });
        return res.end(audioBuffer);
      }

      if (pathname === '/api/quota' && method === 'GET') {
        const remaining = Math.max(0, 10000 - quotaUsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          used: quotaUsed,
          remaining,
          limit: 10000,
          resetAt: '2026-10-11T07:00:00.000Z'
        }));
      }

      // Default 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve(server);
    });
  });
}

/**
 * Ensures test server is available.
 * If server.js exists, spawns it; if already running, connects;
 * if mock requested or server.js missing in fallback mode, starts mock.
 */
async function ensureServerRunning() {
  // Check if primary port 3000 is already active
  const port3000Running = await isPortOpen('http://127.0.0.1:3000');
  if (port3000Running) {
    return { baseUrl: 'http://127.0.0.1:3000', spawned: false };
  }

  // Check if test port is already active
  const testPortRunning = await isPortOpen(BASE_URL);
  if (testPortRunning) {
    return { baseUrl: BASE_URL, spawned: false };
  }

  // Check if server.js exists in root
  if (fs.existsSync(SERVER_PATH)) {
    // Spawn real server
    serverProcess = spawn(process.execPath, [SERVER_PATH], {
      env: {
        ...process.env,
        PORT: DEFAULT_PORT,
        NODE_ENV: 'test'
      },
      stdio: 'pipe'
    });

    const ready = await waitForServer(BASE_URL);
    if (ready) {
      return { baseUrl: BASE_URL, spawned: true, process: serverProcess };
    }
  }

  // If server.js doesn't exist or fails, and standalone/mock mode is enabled:
  if (process.env.TEST_MOCK_SERVER === 'true' || process.env.TEST_STANDALONE === 'true') {
    fallbackServer = await createMockServer(DEFAULT_PORT);
    return { baseUrl: BASE_URL, spawned: true, isMock: true };
  }

  // Server cannot be started
  throw new Error(
    `Cannot connect to backend server at ${BASE_URL} or 3000. server.js was not found in project root. ` +
    `Ensure Milestone 1 backend is implemented, or run with TEST_MOCK_SERVER=true for contract verification.`
  );
}

async function stopServer() {
  if (serverProcess) {
    const proc = serverProcess;
    serverProcess = null;
    try {
      proc.kill('SIGTERM');
    } catch {}
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 1500);
      proc.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      proc.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (fallbackServer) {
    if (typeof fallbackServer.closeAllConnections === 'function') {
      try { fallbackServer.closeAllConnections(); } catch {}
    }
    await new Promise(r => fallbackServer.close(r));
    fallbackServer = null;
  }
}

async function apiRequest(endpoint, options = {}, baseUrl = BASE_URL) {
  const url = `${baseUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  const body = options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined;

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body
  });

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else if (contentType.startsWith('audio/') || contentType.includes('octet-stream')) {
    const arrayBuf = await res.arrayBuffer();
    data = Buffer.from(arrayBuf);
  } else {
    data = await res.text();
  }

  return {
    status: res.status,
    headers: res.headers,
    data
  };
}

module.exports = {
  DEFAULT_PORT,
  BASE_URL,
  ensureServerRunning,
  stopServer,
  apiRequest,
  createMockServer
};
