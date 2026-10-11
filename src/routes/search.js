// src/routes/search.js - YouTube Proxy Search Route
const express = require('express');
const router = express.Router();
const youtubeService = require('../services/youtube');

router.get('/', async (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: "Query parameter 'q' is required" });
  }

  if (query.trim().length > 200) {
    return res.status(400).json({ error: "Query parameter 'q' cannot exceed 200 characters" });
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 25);

  try {
    const result = await youtubeService.searchYouTube(query, { limit });
    return res.status(200).json({ items: result.items });
  } catch (err) {
    console.error(`[Search Route Error] ${youtubeService.sanitizeErrorMessage(err.message)}`);
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
    const providerCode = typeof err.code === 'string' ? err.code.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) : '';
    const isQuotaExceeded = /quotaexceeded|dailylimit|ratelimit|quota.*exceed|dailyquota/i.test(`${providerCode} ${err.message || ''}`);
    const quotaService = require('../services/quota');
    return res.status(status).json({
      error: youtubeService.sanitizeErrorMessage(err.message || 'YouTube search is temporarily unavailable.'),
      code: providerCode || null,
      isQuotaExceeded,
      resetAt: isQuotaExceeded ? quotaService.getNextPacificMidnightISO() : null
    });
  }
});

// Zero-quota search suggestions proxy from Google Suggest API
router.get('/suggest', async (req, res) => {
  const query = req.query.q;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.json({ suggestions: [] });
  }

  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query.trim())}`;
    const response = await fetch(url);
    const data = await response.json();
    const suggestions = Array.isArray(data) && Array.isArray(data[1]) ? data[1] : [];
    return res.json({ suggestions });
  } catch (err) {
    return res.json({ suggestions: [] });
  }
});

module.exports = router;
