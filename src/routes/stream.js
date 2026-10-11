// src/routes/stream.js - ISA Music Audio Streaming Proxy Route Controller
const express = require('express');
const router = express.Router();
const https = require('https');
const http = require('http');
const audioService = require('../services/audio');

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

router.get('/:videoId/info', async (req, res) => {
  const { videoId } = req.params;
  if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId format' });
  }

  try {
    let duration = audioService.getTrackDuration(videoId);
    if (!duration) {
      await audioService.extractStreamUrl(videoId);
      duration = audioService.getTrackDuration(videoId);
    }
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60);
    return res.json({
      videoId,
      duration: duration || 210,
      durationFormatted: `${mins}:${secs.toString().padStart(2, '0')}`
    });
  } catch (err) {
    return res.json({ videoId, duration: 210, durationFormatted: '3:30' });
  }
});

router.get('/:videoId', async (req, res) => {
  const { videoId } = req.params;

  // 1. Validation of video ID format
  if (!videoId || !VIDEO_ID_REGEX.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId format' });
  }

  // Normalize quality
  const rawQuality = req.query.quality;
  let quality = 'high';
  if (rawQuality && typeof rawQuality === 'string') {
    const normalized = rawQuality.toLowerCase();
    if (['high', 'medium', 'low', 'flac'].includes(normalized)) {
      quality = normalized;
    }
  }

  // 2. Quota / Usage accounting hook
  try {
    const quotaService = require('../services/quota');
    if (quotaService && typeof quotaService.recordQuotaUsage === 'function') {
      quotaService.recordQuotaUsage(0, 'stream');
    }
  } catch (_) {}

  // 3. Mock mode for automated tests
  if (process.env.AUDIO_MOCK_MODE === 'true' || process.env.NODE_ENV === 'test') {
    try {
      const audioResult = await audioService.getAudioStream(videoId, quality);
      const { buffer, totalSize, contentType } = audioResult;
      const range = req.headers.range;
      if (range && buffer) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        const chunk = buffer.subarray(start, end + 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunk.length);
        res.setHeader('Content-Type', contentType);
        return res.end(chunk);
      }
      res.setHeader('Content-Length', totalSize);
      res.setHeader('Content-Type', contentType);
      return res.end(buffer);
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
  }

  // 4. High-performance Direct YouTube Proxy Stream (native Range requests, zero transcoding latency)
  if (quality !== 'flac') {
    try {
      const streamUrl = await audioService.extractStreamUrl(videoId);
      const duration = audioService.getTrackDuration(videoId);
      const client = streamUrl.startsWith('https:') ? https : http;
      const proxyReq = client.get(streamUrl, {
        headers: req.headers.range ? { range: req.headers.range } : {}
      }, (proxyRes) => {
        res.status(proxyRes.statusCode || 200);
        for (const [header, val] of Object.entries(proxyRes.headers)) {
          const hLower = header.toLowerCase();
          if (['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control'].includes(hLower)) {
            res.setHeader(header, val);
          }
        }
        if (duration) res.setHeader('X-Content-Duration', duration.toString());
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, X-Content-Duration, Accept-Ranges');
        res.setHeader('X-Stream-Source', 'youtube-proxy');
        proxyRes.pipe(res);
      });

      proxyReq.on('error', (err) => {
        console.error('[Stream Proxy Error]:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Stream extraction error' });
      });

      res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
      });
      return;
    } catch (err) {
      console.warn(`[Stream Controller] Direct stream extraction failed: ${err.message}. Trying FFmpeg fallback...`);
    }
  }

  // 5. FFmpeg Transcoding Pipeline (for FLAC or fallback)
  try {
    const audioResult = await audioService.getAudioStream(videoId, quality);
    const { stream, contentType, process: childProc } = audioResult;

    res.on('close', () => {
      if (!res.writableFinished && childProc && !childProc.killed) {
        try { childProc.kill('SIGKILL'); } catch (_) {}
      }
    });

    res.status(200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Stream-Source', 'ffmpeg-transcode');

    stream.on('error', (err) => {
      console.error('[Stream Transcode Error]:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Audio streaming error' });
    });

    return stream.pipe(res);
  } catch (err) {
    console.error('[Stream Fatal]:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Unable to stream this track: ' + err.message });
    }
  }
});

module.exports = router;
