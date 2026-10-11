// src/routes/settings.js - Admin/Settings Routes for API Key Management
const express = require('express');
const { getDb } = require('../db');
const authMiddleware = require('../middleware/auth');
const youtubeService = require('../services/youtube');

const router = express.Router();

// Helper to check if user is admin / authenticated
const requireAuth = authMiddleware;
const { verifyToken } = require('../middleware/auth');

// Optional auth middleware: verifies token if present, but does not block requests
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  if (authHeader) {
    try {
      const parts = authHeader.trim().split(/\s+/);
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        req.user = verifyToken(parts[1]);
      }
    } catch (_) {}
  }
  next();
}

// GET /api/settings/api-keys - List all configured API keys (masked)
router.get('/api-keys', optionalAuth, async (req, res) => {
  try {
    const stats = youtubeService.getKeyStats();
    // Return masked keys with stats
    res.json({ success: true, keys: stats });
  } catch (err) {
    console.error('[Settings] Error fetching API keys:', err);
    res.status(500).json({ error: 'Failed to fetch API keys' });
  }
});

// POST /api/settings/api-keys - Add a new API key
router.post('/api-keys', optionalAuth, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key || typeof key !== 'string' || key.trim().length < 35) {
      return res.status(400).json({ error: 'Invalid API key format' });
    }

    const cleanKey = key.trim();
    if (!cleanKey.startsWith('AIza') || !/^AIza[0-9A-Za-z\-_]{35}$/.test(cleanKey)) {
      return res.status(400).json({ error: 'Invalid YouTube API key format (must start with AIza and be 39 chars)' });
    }

    // Store in database
    const db = getDb();
    const masked = cleanKey.slice(0, 4) + '****' + cleanKey.slice(-4);
    const userId = req.user ? req.user.id : 1;
    
    try {
      db.prepare(`
        INSERT INTO api_keys (key_value, key_masked, created_by, created_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      `).run(cleanKey, masked, userId);
    } catch (dbErr) {
      if (dbErr.message.includes('UNIQUE')) {
        return res.status(409).json({ error: 'This API key is already configured' });
      }
      throw dbErr;
    }

    // Reload keys in service
    youtubeService.keyManager.reloadKeys();

    res.json({ success: true, message: 'API key added successfully', masked });
  } catch (err) {
    console.error('[Settings] Error adding API key:', err);
    res.status(500).json({ error: 'Failed to add API key' });
  }
});

// POST /api/settings/api-keys/bulk - Bulk import API keys
router.post('/api-keys/bulk', requireAuth, async (req, res) => {
  try {
    const { keys } = req.body;
    if (!keys || typeof keys !== 'string') {
      return res.status(400).json({ error: 'Keys text required' });
    }

    // Parse keys (comma-separated or newline-separated)
    const keyList = keys
      .split(/[\n,]+/)
      .map(k => k.trim())
      .filter(k => k.length >= 35 && k.startsWith('AIza') && /^AIza[0-9A-Za-z\-_]{35}$/.test(k));

    if (keyList.length === 0) {
      return res.status(400).json({ error: 'No valid API keys found in input' });
    }

    const db = getDb();
    let added = 0;
    let skipped = 0;

    const userId = req.user ? req.user.id : 1;
    for (const key of keyList) {
      const masked = key.slice(0, 4) + '****' + key.slice(-4);
      try {
        db.prepare(`
          INSERT INTO api_keys (key_value, key_masked, created_by, created_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `).run(key, masked, userId);
        added++;
      } catch (dbErr) {
        if (dbErr.message.includes('UNIQUE')) {
          skipped++;
        } else {
          throw dbErr;
        }
      }
    }

    // Reload keys in service
    youtubeService.keyManager.reloadKeys();

    res.json({ 
      success: true, 
      message: `Imported ${added} key(s), skipped ${skipped} duplicate(s)`,
      added,
      skipped
    });
  } catch (err) {
    console.error('[Settings] Error bulk importing API keys:', err);
    res.status(500).json({ error: 'Failed to import API keys' });
  }
});

// DELETE /api/settings/api-keys/:masked - Remove an API key
router.delete('/api-keys/:masked', requireAuth, async (req, res) => {
  try {
    const { masked } = req.params;
    const db = getDb();
    
    const result = db.prepare('DELETE FROM api_keys WHERE key_masked = ?').run(masked);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    // Reload keys in service
    youtubeService.keyManager.reloadKeys();

    res.json({ success: true, message: 'API key removed' });
  } catch (err) {
    console.error('[Settings] Error removing API key:', err);
    res.status(500).json({ error: 'Failed to remove API key' });
  }
});

// GET /api/settings/quota-stats - Get detailed quota stats per key
router.get('/quota-stats', optionalAuth, async (req, res) => {
  try {
    const stats = youtubeService.getKeyStats();
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[Settings] Error fetching quota stats:', err);
    res.status(500).json({ error: 'Failed to fetch quota stats' });
  }
});

// POST /api/settings/reset-key-health - Reset all key health (admin action)
router.post('/reset-key-health', requireAuth, async (req, res) => {
  try {
    youtubeService.resetKeyHealth();
    res.json({ success: true, message: 'Key health reset' });
  } catch (err) {
    console.error('[Settings] Error resetting key health:', err);
    res.status(500).json({ error: 'Failed to reset key health' });
  }
});

module.exports = router;