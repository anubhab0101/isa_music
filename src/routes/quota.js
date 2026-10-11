// src/routes/quota.js - YouTube Data API Quota Endpoint
const express = require('express');
const router = express.Router();
const quotaService = require('../services/quota');

/**
 * GET /api/quota
 * Returns an app-local estimate for YouTube search.list calls and the separate 10k unit pool.
 *
 * Response:
 * {
 *   "used": 1,
 *   "remaining": 9999,
 *   "total": 10000,
 *   "limit": 10000,
 *   "searchCallsUsed": 1,
 *   "searchCallsRemaining": 99,
 *   "searchCallsLimit": 100,
 *   "resetsAt": "2026-10-11T07:00:00.000Z",
 *   "resetAt": "2026-10-11T07:00:00.000Z",
 *   "date": "2026-10-10",
 *   "searchCount": 1,
 *   "streamCount": 0
 * }
 */
router.get('/', (req, res) => {
  try {
    const status = quotaService.getQuotaStatus();
    return res.status(200).json(status);
  } catch (err) {
    console.error('[Quota Route Error]:', err.message);
    const fallbackReset = quotaService.getNextPacificMidnightISO
      ? quotaService.getNextPacificMidnightISO()
      : new Date(Date.now() + 86400000).toISOString();

    return res.status(200).json({
      used: 0,
      remaining: 10000,
      total: 10000,
      limit: 10000,
      searchCount: 0,
      searchCallsUsed: 0,
      searchCallsRemaining: quotaService.DEFAULT_SEARCH_LIMIT || 100,
      searchCallsLimit: quotaService.DEFAULT_SEARCH_LIMIT || 100,
      resetsAt: fallbackReset,
      resetAt: fallbackReset
    });
  }
});

/**
 * POST /api/quota/reset
 * Administrative/test reset endpoint.
 */
router.post('/reset', (req, res) => {
  try {
    const status = quotaService.resetDailyQuota();
    return res.status(200).json({ success: true, quota: status });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset quota' });
  }
});

module.exports = router;
