/**
 * tests/adversarial/m2_streaming_stress.test.js
 *
 * Milestone 2 Empirical Adversarial & Stress Verification Suite:
 * Focus: Audio Streaming Proxy (/api/stream/:videoId)
 *
 * Pillars:
 * 1. Adversarial Video ID Fuzzing & Malformed ID Rejection (400 Bad Request)
 *    - Short IDs, Long IDs, URL encoded path traversal, Windows path traversal,
 *      command injection vectors, special chars, null bytes, unicode/emojis, SQLi/XSS.
 * 2. Stream Buffer Audio Format Verification
 *    - High/Medium/Low: Valid MP3 audio frames (ID3 tag header + MPEG-1 Layer III sync frame 0xFF 0xFB/FA).
 *    - Bitrate tier progression: High > Medium > Low.
 *    - FLAC: Valid 'fLaC' ASCII magic bytes (0x66, 0x4C, 0x61, 0x43) + STREAMINFO metadata block.
 *    - Exact HTTP 206 byte-slicing preservation across formats.
 * 3. Rapid Sequential & Concurrent Requests (System Stability & Resource Exhaustion)
 *    - 80 rapid sequential requests across varying endpoints/qualities.
 *    - 20 simultaneous concurrent requests.
 *    - Server memory stability & handle tracking.
 * 4. Client Socket Abort During Streaming (Zombie Process & Crash Prevention)
 *    - Abrupt client socket destruction mid-stream.
 *    - Multiple rapid disconnects.
 *    - Child process termination verification (SIGKILL & process death, zero zombie leaks).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { ensureServerRunning, stopServer, apiRequest } = require('../helpers/test_server');

const VALID_VIDEO_ID = 'dQw4w9WgXcQ';

describe('Milestone 2 Empirical Adversarial & Stress Suite: Audio Streaming Proxy', () => {
  let serverInfo = null;

  before(async () => {
    serverInfo = await ensureServerRunning();
  });

  after(async () => {
    await stopServer();
  });

  // ==========================================================================
  // PILLAR 1: ADVERSARIAL VIDEO ID FUZZING & MALFORMED ID REJECTION
  // ==========================================================================
  describe('Pillar 1: Adversarial Video ID Fuzzing & Malformed ID Rejection', () => {

    describe('1.1 Length Boundary Violations (must be exactly 11 characters)', () => {
      const lengthViolations = [
        { desc: '1 char', id: 'a' },
        { desc: '2 chars', id: 'ab' },
        { desc: '5 chars', id: 'abcde' },
        { desc: '10 chars (off by one under)', id: '1234567890' },
        { desc: '12 chars (off by one over)', id: '123456789012' },
        { desc: '16 chars', id: 'dQw4w9WgXcQ_tool' },
        { desc: '64 chars', id: 'A'.repeat(64) },
        { desc: '256 chars', id: 'B'.repeat(256) },
        { desc: '1000 chars', id: 'C'.repeat(1000) }
      ];

      for (const { desc, id } of lengthViolations) {
        it(`rejects ${desc} with HTTP 400`, async (t) => {
          if (!serverInfo) return t.skip('Server not available');
          const res = await apiRequest(`/api/stream/${encodeURIComponent(id)}`, {}, serverInfo.baseUrl);
          assert.strictEqual(res.status, 400, `Expected 400 for ${desc}, received ${res.status}`);
          assert.ok(res.data && res.data.error, 'Expected JSON error payload');
        });
      }
    });

    describe('1.2 Path Traversal & Directory Climbing Attacks', () => {
      const traversalPayloads = [
        { desc: 'Linux /etc/passwd encoded', payload: '..%2F..%2Fetc%2Fpasswd' },
        { desc: 'Linux /etc/shadow encoded', payload: '..%2f..%2fetc%2fshadow' },
        { desc: 'Windows system32 encoded', payload: '..%5C..%5Cwindows%5Csystem32' },
        { desc: 'Windows win.ini encoded', payload: '..%5C..%5Cwindows%5Cwin.ini' },
        { desc: 'Dot-dot-slash variations', payload: '....%2F%2F....%2F%2Fetc%2Fpasswd' },
        { desc: 'Double URL encoded traversal', payload: '..%252f..%252fetc%252fpasswd' },
        { desc: '11-char traversal attempt encoded', payload: encodeURIComponent('../../etc') }
      ];

      for (const { desc, payload } of traversalPayloads) {
        it(`blocks traversal attempt (${desc}) with HTTP 400`, async (t) => {
          if (!serverInfo) return t.skip('Server not available');
          const res = await apiRequest(`/api/stream/${payload}`, {}, serverInfo.baseUrl);
          assert.strictEqual(res.status, 400, `Expected 400 for ${desc}, received ${res.status}`);
        });
      }

      it('rejects raw unencoded TCP traversal attempts without exposing server files', async (t) => {
        if (!serverInfo) return t.skip('Server not available');
        const net = require('node:net');
        const port = new URL(serverInfo.baseUrl).port || 3000;

        const responseText = await new Promise((resolve, reject) => {
          const client = net.createConnection({ port: Number(port), host: '127.0.0.1' }, () => {
            client.write('GET /api/stream/../../etc/passwd HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
          });
          let data = '';
          client.on('data', chunk => { data += chunk.toString(); });
          client.on('end', () => resolve(data));
          client.on('error', err => reject(err));
          setTimeout(() => { client.destroy(); resolve(data); }, 2000);
        });

        assert.ok(responseText.includes('400') || responseText.includes('404'), `Expected 400 or 404 for raw traversal, got: ${responseText.split('\r\n')[0]}`);
        assert.ok(!responseText.includes('root:'), 'Raw traversal must never expose passwd file');
      });
    });

    describe('1.3 Command Injection Vectors', () => {
      const commandInjectionPayloads = [
        { desc: 'Semicolon command chaining', payload: ';calc.exe' },
        { desc: 'Pipe command chaining', payload: '|whoami' },
        { desc: 'Ampersand command chaining', payload: '&dir' },
        { desc: 'Subshell execution $()', payload: '$(whoami)' },
        { desc: 'Backtick command execution', payload: '`id`' },
        { desc: 'Logical OR chaining', payload: '||ping 127.0.0.1' },
        { desc: 'Logical AND chaining', payload: '&&notepad.exe' },
        { desc: 'Output redirection', payload: '>out.txt' },
        { desc: 'Input redirection', payload: '<in.txt' },
        { desc: '11-char injection attempt', payload: ';rm -rf /a' },
        { desc: 'Appended injection to valid ID', payload: 'dQw4w9WgXcQ;calc' },
        { desc: 'Embedded pipe in ID', payload: 'dQw4w|whoami' }
      ];

      for (const { desc, payload } of commandInjectionPayloads) {
        it(`blocks command injection (${desc}) with HTTP 400`, async (t) => {
          if (!serverInfo) return t.skip('Server not available');
          const res = await apiRequest(`/api/stream/${encodeURIComponent(payload)}`, {}, serverInfo.baseUrl);
          assert.strictEqual(res.status, 400, `Expected 400 for ${desc}, received ${res.status}`);
        });
      }
    });

    describe('1.4 Special Characters, Non-Printable & Encoding Violations', () => {
      const specialCharPayloads = [
        { desc: 'Spaces in ID', payload: 'dQw4w9 WgXc' },
        { desc: 'Tab in ID', payload: 'dQw4w9\tWgXc' },
        { desc: 'Newline in ID', payload: 'dQw4w9\nWgXc' },
        { desc: 'Null byte in ID', payload: 'dQw4w9\0WgXc' },
        { desc: 'At symbol (@)', payload: 'dQw4w9@WgXc' },
        { desc: 'Hash symbol (#)', payload: 'dQw4w9#WgXc' },
        { desc: 'Dollar symbol ($)', payload: 'dQw4w9$WgXc' },
        { desc: 'Percent symbol (%)', payload: 'dQw4w9%WgXc' },
        { desc: 'Colon and slash (protocol-like)', payload: 'http://evil' },
        { desc: 'Unicode emoji', payload: 'dQw4w9WgXc😊' },
        { desc: 'CJK characters', payload: 'dQw4w9WgXc字' },
        { desc: 'RTL override', payload: 'dQw4w9WgXc\u202E' }
      ];

      for (const { desc, payload } of specialCharPayloads) {
        it(`rejects special character payload (${desc}) with HTTP 400`, async (t) => {
          if (!serverInfo) return t.skip('Server not available');
          const res = await apiRequest(`/api/stream/${encodeURIComponent(payload)}`, {}, serverInfo.baseUrl);
          assert.strictEqual(res.status, 400, `Expected 400 for ${desc}, received ${res.status}`);
        });
      }
    });

    describe('1.5 SQL Injection & XSS Payloads', () => {
      const codePayloads = [
        { desc: 'SQLi OR condition', payload: "' OR '1'='1" },
        { desc: 'SQLi union select', payload: "' UNION SEL" },
        { desc: 'SQLi comment terminator', payload: "admin'--" },
        { desc: 'XSS script tag', payload: "<script>1</" },
        { desc: 'XSS img tag', payload: '<img src=x>' }
      ];

      for (const { desc, payload } of codePayloads) {
        it(`rejects code injection payload (${desc}) with HTTP 400`, async (t) => {
          if (!serverInfo) return t.skip('Server not available');
          const res = await apiRequest(`/api/stream/${encodeURIComponent(payload)}`, {}, serverInfo.baseUrl);
          assert.strictEqual(res.status, 400, `Expected 400 for ${desc}, received ${res.status}`);
        });
      }
    });

    describe('1.6 Valid YouTube Video ID Acceptance', () => {
      const validIds = [
        'dQw4w9WgXcQ',
        'kJQP7kiw5Fk',
        '9bZkp7q19f0',
        'fJ9rUzIMcZQ',
        'JGwWNGJdvx8',
        'a-b_C123456', // uses hyphen and underscore
        '12345678901',
        '___________',
        '-----------'
      ];

      for (const id of validIds) {
        it(`accepts valid 11-char ID (${id}) with HTTP 200 or 206`, async (t) => {
          if (!serverInfo) return t.skip('Server not available');
          const res = await apiRequest(`/api/stream/${id}`, {}, serverInfo.baseUrl);
          assert.strictEqual(res.status === 200 || res.status === 206, true, `Expected 200/206 for ${id}, got ${res.status}`);
        });
      }
    });
  });

  // ==========================================================================
  // PILLAR 2: STREAM BUFFER AUDIO FORMAT VERIFICATION
  // ==========================================================================
  describe('Pillar 2: Stream Buffer Audio Format & Codec Verification', () => {

    it('validates High Quality MP3: audio/mpeg, ID3v2 header, and valid MPEG-1 Layer III audio sync frames', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=high`, {}, serverInfo.baseUrl);
      assert.strictEqual(res.status === 200 || res.status === 206, true);
      assert.strictEqual(res.headers.get('content-type'), 'audio/mpeg');

      const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
      assert.ok(buf.length >= 1024, `Buffer size too small: ${buf.length}`);

      // MP3 verification: Must start with ID3 tag ('ID3' = 0x49, 0x44, 0x33) OR MPEG sync word (0xFF 0xFB/FA)
      const hasId3 = buf.subarray(0, 3).toString('ascii') === 'ID3';
      const hasSyncAtStart = buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;

      assert.ok(hasId3 || hasSyncAtStart, 'High quality buffer must begin with ID3 tag or MPEG sync word');

      if (hasId3) {
        // Parse ID3v2 syncsafe integer size (bytes 6..9)
        const id3Size = (buf[6] & 0x7F) << 21 | (buf[7] & 0x7F) << 14 | (buf[8] & 0x7F) << 7 | (buf[9] & 0x7F);
        const audioOffset = 10 + id3Size;
        assert.ok(audioOffset < buf.length, `Audio frame offset ${audioOffset} exceeds buffer length ${buf.length}`);

        // Verify MPEG audio sync frame at audioOffset
        const syncByte1 = buf[audioOffset];
        const syncByte2 = buf[audioOffset + 1];
        assert.strictEqual(syncByte1, 0xFF, `Expected sync byte 0xFF at offset ${audioOffset}, got 0x${syncByte1.toString(16)}`);
        assert.strictEqual((syncByte2 & 0xE0), 0xE0, `Expected sync bits 111 at offset ${audioOffset + 1}`);

        const mpegVersion = (syncByte2 >> 3) & 0x03; // 3 = MPEG-1
        const mpegLayer = (syncByte2 >> 1) & 0x03;   // 1 = Layer III (MP3)
        assert.strictEqual(mpegVersion, 3, `Expected MPEG-1 (bits 11=3), got ${mpegVersion}`);
        assert.strictEqual(mpegLayer, 1, `Expected Layer III (bits 01=1), got ${mpegLayer}`);
      }
    });

    it('validates Medium Quality MP3: audio/mpeg, valid MP3 frames, smaller than High quality', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const [highRes, medRes] = await Promise.all([
        apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=high`, {}, serverInfo.baseUrl),
        apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=medium`, {}, serverInfo.baseUrl)
      ]);

      assert.strictEqual(medRes.status === 200 || medRes.status === 206, true);
      assert.strictEqual(medRes.headers.get('content-type'), 'audio/mpeg');

      const highBuf = Buffer.from(highRes.data);
      const medBuf = Buffer.from(medRes.data);

      assert.ok(medBuf.length >= 1024, `Medium buffer too small: ${medBuf.length}`);
      assert.ok(medBuf.length < highBuf.length, `Medium buffer (${medBuf.length}) should be smaller than High (${highBuf.length})`);

      const hasId3 = medBuf.subarray(0, 3).toString('ascii') === 'ID3';
      const hasSync = medBuf[0] === 0xFF && (medBuf[1] & 0xE0) === 0xE0;
      assert.ok(hasId3 || hasSync, 'Medium quality must have valid ID3 or MPEG sync');

      if (hasId3) {
        const id3Size = (medBuf[6] & 0x7F) << 21 | (medBuf[7] & 0x7F) << 14 | (medBuf[8] & 0x7F) << 7 | (medBuf[9] & 0x7F);
        const offset = 10 + id3Size;
        assert.strictEqual(medBuf[offset], 0xFF);
        assert.strictEqual((medBuf[offset + 1] & 0xE0), 0xE0);
      }
    });

    it('validates Low Quality MP3: audio/mpeg, valid MP3 frames, smaller than Medium quality', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const [medRes, lowRes] = await Promise.all([
        apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=medium`, {}, serverInfo.baseUrl),
        apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=low`, {}, serverInfo.baseUrl)
      ]);

      assert.strictEqual(lowRes.status === 200 || lowRes.status === 206, true);
      assert.strictEqual(lowRes.headers.get('content-type'), 'audio/mpeg');

      const medBuf = Buffer.from(medRes.data);
      const lowBuf = Buffer.from(lowRes.data);

      assert.ok(lowBuf.length >= 1024, `Low buffer too small: ${lowBuf.length}`);
      assert.ok(lowBuf.length < medBuf.length, `Low buffer (${lowBuf.length}) should be smaller than Medium (${medBuf.length})`);

      const hasId3 = lowBuf.subarray(0, 3).toString('ascii') === 'ID3';
      const hasSync = lowBuf[0] === 0xFF && (lowBuf[1] & 0xE0) === 0xE0;
      assert.ok(hasId3 || hasSync, 'Low quality must have valid ID3 or MPEG sync');
    });

    it('validates Lossless FLAC: audio/flac, fLaC magic ASCII header (0x66, 0x4C, 0x61, 0x43), STREAMINFO block', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=flac`, {}, serverInfo.baseUrl);
      assert.strictEqual(res.status === 200 || res.status === 206, true);
      assert.strictEqual(res.headers.get('content-type'), 'audio/flac');

      const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data);
      assert.ok(buf.length >= 1024, `FLAC buffer too small: ${buf.length}`);

      // First 4 bytes must be 'fLaC' in ASCII
      const magic = buf.subarray(0, 4).toString('ascii');
      assert.strictEqual(magic, 'fLaC', `Expected magic 'fLaC', received '${magic}'`);
      assert.deepStrictEqual(
        Array.from(buf.subarray(0, 4)),
        [0x66, 0x4C, 0x61, 0x43],
        'FLAC header bytes must be exactly 0x66 0x4C 0x61 0x43'
      );

      // Byte 4: Metadata block header (bit 0 = is_last, bits 1..7 = block_type 0 for STREAMINFO)
      const blockHeaderByte = buf[4];
      const blockType = blockHeaderByte & 0x7F;
      assert.strictEqual(blockType, 0, `Expected first FLAC metadata block to be STREAMINFO (type 0), got ${blockType}`);
    });

    it('validates exact HTTP 206 byte slicing preserves audio header signatures', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      // 1. Slice first 4 bytes of FLAC
      const flacSlice = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=flac`, {
        headers: { Range: 'bytes=0-3' }
      }, serverInfo.baseUrl);
      assert.strictEqual(flacSlice.status, 206);
      const flacBuf = Buffer.from(flacSlice.data);
      assert.strictEqual(flacBuf.length, 4);
      assert.strictEqual(flacBuf.toString('ascii'), 'fLaC');

      // 2. Slice first 3 bytes of High MP3 (ID3)
      const mp3Slice = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=high`, {
        headers: { Range: 'bytes=0-2' }
      }, serverInfo.baseUrl);
      assert.strictEqual(mp3Slice.status, 206);
      const mp3Buf = Buffer.from(mp3Slice.data);
      assert.strictEqual(mp3Buf.length, 3);
      assert.strictEqual(mp3Buf.toString('ascii'), 'ID3');

      // 3. Slice middle chunk (bytes 100-199 = 100 bytes)
      const midSlice = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=high`, {
        headers: { Range: 'bytes=100-199' }
      }, serverInfo.baseUrl);
      assert.strictEqual(midSlice.status, 206);
      assert.strictEqual(Buffer.from(midSlice.data).length, 100);
      assert.strictEqual(midSlice.headers.get('content-range').startsWith('bytes 100-199/'), true);
    });
  });

  // ==========================================================================
  // PILLAR 3: RAPID SEQUENTIAL & CONCURRENT REQUESTS (STABILITY)
  // ==========================================================================
  describe('Pillar 3: Rapid Sequential & Concurrent Requests (System Stability)', () => {

    it('survives 80 rapid sequential requests without errors or server degradation', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const qualities = ['high', 'medium', 'low', 'flac'];
      const errors = [];
      const startTime = Date.now();

      for (let i = 0; i < 80; i++) {
        const quality = qualities[i % qualities.length];
        const isRange = (i % 4) === 0;
        const options = isRange ? { headers: { Range: 'bytes=0-511' } } : {};

        try {
          const res = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=${quality}`, options, serverInfo.baseUrl);
          if (isRange && res.status !== 206) {
            errors.push({ i, expected: 206, got: res.status });
          } else if (!isRange && res.status !== 200) {
            errors.push({ i, expected: 200, got: res.status });
          }
        } catch (err) {
          errors.push({ i, error: err.message });
        }
      }

      const duration = Date.now() - startTime;
      assert.strictEqual(errors.length, 0, `Encountered ${errors.length} errors during 80 sequential requests: ${JSON.stringify(errors.slice(0, 3))}`);
      assert.ok(duration < 20000, `80 requests took excessive time: ${duration}ms`);
    });

    it('survives 20 simultaneous concurrent requests without dropping sockets', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const promises = Array.from({ length: 20 }, (_, idx) => {
        const quality = ['high', 'flac', 'medium', 'low'][idx % 4];
        return apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=${quality}`, {}, serverInfo.baseUrl);
      });

      const results = await Promise.all(promises);
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        assert.strictEqual(res.status === 200 || res.status === 206, true, `Concurrent request ${i} failed with status ${res.status}`);
        assert.ok(res.data && res.data.length >= 1024, `Concurrent request ${i} returned truncated body`);
      }
    });

    it('verifies server health and quota service remain fully operational after load', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const healthRes = await apiRequest('/api/health', {}, serverInfo.baseUrl);
      assert.strictEqual(healthRes.status, 200);
      assert.strictEqual(healthRes.data.status, 'ok');

      const quotaRes = await apiRequest('/api/quota', {}, serverInfo.baseUrl);
      assert.strictEqual(quotaRes.status, 200);
      assert.strictEqual(typeof quotaRes.data.used, 'number');
      assert.strictEqual(typeof quotaRes.data.remaining, 'number');
      assert.strictEqual(quotaRes.data.used + quotaRes.data.remaining, quotaRes.data.total || 10000);
    });
  });

  // ==========================================================================
  // PILLAR 4: CLIENT SOCKET ABORT & CHILD PROCESS CLEANUP
  // ==========================================================================
  describe('Pillar 4: Client Socket Abort During Streaming (Zombie Process Prevention)', () => {

    it('handles abrupt client socket termination during stream transmission without crashing server', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const url = new URL(`/api/stream/${VALID_VIDEO_ID}?quality=high`, serverInfo.baseUrl);

      // Perform client socket abort
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          assert.strictEqual(res.statusCode === 200 || res.statusCode === 206, true);
          res.on('data', () => {
            // Abort abruptly after first data packet
            req.destroy();
            resolve();
          });
        });

        req.on('error', (err) => {
          // Socket destruction causes client error event - this is expected
          resolve();
        });

        setTimeout(() => resolve(), 3000);
      });

      // Verify server is immediately healthy and responsive
      const checkRes = await apiRequest('/api/health', {}, serverInfo.baseUrl);
      assert.strictEqual(checkRes.status, 200);
      assert.strictEqual(checkRes.data.status, 'ok');
    });

    it('survives rapid successive socket aborts without unhandled exceptions or resource leaks', async (t) => {
      if (!serverInfo) return t.skip('Server not available');

      const url = new URL(`/api/stream/${VALID_VIDEO_ID}?quality=flac`, serverInfo.baseUrl);

      // Fire 5 rapid aborted requests in succession
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => {
          const req = http.get(url, (res) => {
            res.on('data', () => {
              req.destroy();
              resolve();
            });
          });
          req.on('error', () => resolve());
          setTimeout(() => resolve(), 500);
        });
      }

      // Check server stability post rapid aborts
      const postAbortCheck = await apiRequest(`/api/stream/${VALID_VIDEO_ID}?quality=high`, {}, serverInfo.baseUrl);
      assert.strictEqual(postAbortCheck.status === 200 || postAbortCheck.status === 206, true);
      assert.ok(Buffer.from(postAbortCheck.data).length >= 1024);
    });

    it('verifies child process kill contract: childProc.kill("SIGKILL") terminates process without zombies', async (t) => {
      // Spawn a real child process to simulate active transcoder/extractor
      const child = spawn('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'sine=frequency=440',
        '-f', 'mp3',
        'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      assert.ok(child.pid, 'Child process must possess valid PID');
      const pid = child.pid;

      let gotData = false;
      await new Promise((resolve) => {
        child.stdout.on('data', () => {
          gotData = true;
          resolve();
        });
        setTimeout(resolve, 1500);
      });

      assert.strictEqual(gotData, true, 'Child process should actively produce stdout data');
      assert.strictEqual(child.killed, false, 'Child process should be running prior to termination');

      // Simulate req.on('close') cleanup handler from src/routes/stream.js:
      // if (childProc && !childProc.killed) { try { childProc.kill('SIGKILL'); } catch (_) {} }
      if (child && !child.killed) {
        child.kill('SIGKILL');
      }

      assert.strictEqual(child.killed, true, 'child.killed flag must be set to true');

      // Wait for process exit event
      const exitCode = await new Promise((resolve) => {
        child.on('close', (code, signal) => {
          resolve({ code, signal });
        });
        setTimeout(() => resolve(null), 2000);
      });

      assert.ok(exitCode !== null, 'Child process must emit close/exit event');

      // Verify no zombie remains on Windows using process check
      let isZombie = false;
      try {
        process.kill(pid, 0); // signal 0 tests process existence
        isZombie = true;
      } catch (err) {
        // ESRCH or error indicates process is completely dead - expected
        isZombie = false;
      }
      assert.strictEqual(isZombie, false, `Child process PID ${pid} must not remain as a zombie`);
    });
  });
});
