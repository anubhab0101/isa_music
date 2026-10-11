/**
 * Acceptance Criteria Test: Client API Key Concealment Check
 *
 * Verifies:
 * 1. 0 YouTube Data API keys exist in client-side files (index.html, isa_music.js, styles.css, public/*).
 * 2. 0 YouTube Data API keys leaked in server proxy responses (/api/search, /api/stream, /api/quota).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

const GOOGLE_API_KEY_REGEX = /AIza[0-9A-Za-z-_]{35}/g;
const ROOT_DIR = path.resolve(__dirname, '../../');

describe('Acceptance Criteria: API Key Concealment', () => {
  let serverInfo = null;

  before(async () => {
    try {
      serverInfo = await ensureServerRunning();
    } catch (err) {
      // Backend not running; client static inspection will still run
      serverInfo = null;
    }
  });

  after(async () => {
    await stopServer();
  });

  describe('Static Client File Inspection', () => {
    const clientFiles = [
      'index.html',
      'isa_music.js',
      'styles.css'
    ];

    clientFiles.forEach(file => {
      it(`verifies no YouTube API key is exposed in ${file}`, () => {
        const filePath = path.join(ROOT_DIR, file);
        if (!fs.existsSync(filePath)) {
          assert.fail(`Expected client file ${file} to exist in project root.`);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        const matches = content.match(GOOGLE_API_KEY_REGEX);

        if (matches && matches.length > 0) {
          assert.fail(
            `CRITICAL SECURITY DEFECT: Exposed YouTube API key found in ${file}: ` +
            `"${matches[0]}" (${matches.length} occurrence(s)). ` +
            `API keys must be strictly kept in backend environment variables.`
          );
        }
        assert.strictEqual(matches, null, `Found exposed API keys in ${file}`);
      });
    });

    it('verifies public directory (if present) contains zero exposed API keys', () => {
      const publicDir = path.join(ROOT_DIR, 'public');
      if (fs.existsSync(publicDir)) {
        const files = fs.readdirSync(publicDir);
        for (const f of files) {
          if (f.endsWith('.js') || f.endsWith('.html') || f.endsWith('.json')) {
            const content = fs.readFileSync(path.join(publicDir, f), 'utf8');
            const matches = content.match(GOOGLE_API_KEY_REGEX);
            assert.strictEqual(matches, null, `Found exposed API keys in public/${f}`);
          }
        }
      }
    });
  });

  describe('Dynamic Backend Response Key Concealment', () => {
    it('verifies /api/search response body and headers contain no API keys', async (t) => {
      if (!serverInfo) {
        t.skip('Backend server not currently running');
        return;
      }

      const res = await apiRequest('/api/search?q=test', {}, serverInfo.baseUrl);
      assert.strictEqual(res.status, 200);

      const responseString = JSON.stringify(res.data);
      const bodyMatches = responseString.match(GOOGLE_API_KEY_REGEX);
      assert.strictEqual(bodyMatches, null, 'API key leaked in /api/search response body');

      // Check headers
      for (const [headerName, headerValue] of res.headers.entries()) {
        const headerMatches = String(headerValue).match(GOOGLE_API_KEY_REGEX);
        assert.strictEqual(headerMatches, null, `API key leaked in /api/search header: ${headerName}`);
      }
    });

    it('verifies /api/stream response headers contain no API keys', async (t) => {
      if (!serverInfo) {
        t.skip('Backend server not currently running');
        return;
      }

      const res = await apiRequest('/api/stream/dQw4w9WgXcQ', {}, serverInfo.baseUrl);
      for (const [headerName, headerValue] of res.headers.entries()) {
        const headerMatches = String(headerValue).match(GOOGLE_API_KEY_REGEX);
        assert.strictEqual(headerMatches, null, `API key leaked in /api/stream header: ${headerName}`);
      }
    });

    it('verifies /api/quota response contains no API keys', async (t) => {
      if (!serverInfo) {
        t.skip('Backend server not currently running');
        return;
      }

      const res = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(res.status, 200);
      const str = JSON.stringify(res.data);
      const matches = str.match(GOOGLE_API_KEY_REGEX);
      assert.strictEqual(matches, null, 'API key leaked in /api/quota response');
    });
  });
});
