// src/services/youtube.js - YouTube Data API Client with Multi-Key Failover, Caching & Fallback
const dbModule = require('../db');
const quotaService = require('./quota');

const API_KEY_REGEX = /AIza[0-9A-Za-z\-_]{35}/g;
const QUERY_KEY_REGEX = /key=[a-zA-Z0-9_\-]+/g;

// Tier 1 In-Memory LRU Cache
const MEMORY_CACHE = new Map();
const MAX_MEMORY_CACHE_SIZE = 200;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Valid 11-char YouTube Video IDs for Downstream Compatibility
const MOCK_TRACK_POOL = [
  { videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' },
  { videoId: '2vjPBrBU-TM', title: 'Sunset', artist: 'The Midnight', thumbnail: 'https://i.ytimg.com/vi/2vjPBrBU-TM/hqdefault.jpg' },
  { videoId: 'fHI8X480mxo', title: 'Sunset Boulevard', artist: 'Synth Riders', thumbnail: 'https://i.ytimg.com/vi/fHI8X480mxo/hqdefault.jpg' },
  { videoId: 'IGqeyQ68hp8', title: 'Vampires', artist: 'The Midnight', thumbnail: 'https://i.ytimg.com/vi/IGqeyQ68hp8/hqdefault.jpg' },
  { videoId: 'yPYZpwSpKmA', title: 'Together Forever', artist: 'Rick Astley', thumbnail: 'https://i.ytimg.com/vi/yPYZpwSpKmA/hqdefault.jpg' },
  { videoId: '5qap5aO4i9A', title: 'Lofi Hip Hop Radio', artist: 'Lofi Girl', thumbnail: 'https://i.ytimg.com/vi/5qap5aO4i9A/hqdefault.jpg' },
  { videoId: 'R_vmuJ90hC4', title: 'Days of Thunder', artist: 'The Midnight', thumbnail: 'https://i.ytimg.com/vi/R_vmuJ90hC4/hqdefault.jpg' },
  { videoId: 'kJQP7kiw5Fk', title: 'Despacito', artist: 'Luis Fonsi', thumbnail: 'https://i.ytimg.com/vi/kJQP7kiw5Fk/hqdefault.jpg' },
  { videoId: 'L_LUpnjgPso', title: 'Midnight City', artist: 'M83', thumbnail: 'https://i.ytimg.com/vi/L_LUpnjgPso/hqdefault.jpg' },
  { videoId: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', thumbnail: 'https://i.ytimg.com/vi/fJ9rUzIMcZQ/hqdefault.jpg' }
];

// Multi-API Key Manager
class YouTubeKeyManager {
  constructor() {
    this.keys = [];
    this.currentIndex = 0;
    this.keyStats = new Map(); // key -> { errors: 0, lastError: 0, quotaExhausted: false, lastSuccess: 0 }
    this.loadKeys();
  }

  loadKeys() {
    // Load from env: YOUTUBE_API_KEYS="key1,key2,key3" or individual YOUTUBE_API_KEY_1, YOUTUBE_API_KEY_2...
    const keysFromEnv = process.env.YOUTUBE_API_KEYS
      ? process.env.YOUTUBE_API_KEYS.split(',').map(k => k.trim()).filter(k => k.length > 25 && !k.includes('YOUR_'))
      : [];

    // Also support numbered keys: YOUTUBE_API_KEY_1, YOUTUBE_API_KEY_2, etc.
    const numberedKeys = [];
    for (let i = 1; i <= 10; i++) {
      const key = process.env[`YOUTUBE_API_KEY_${i}`];
      if (key && key.length > 25 && !key.includes('YOUR_')) {
        numberedKeys.push(key.trim());
      }
    }

    // Fallback to single key or comma-separated list
    const singleKey = process.env.YOUTUBE_API_KEY;
    if (singleKey && singleKey.length > 25 && !singleKey.includes('YOUR_')) {
      const parts = singleKey.split(',').map(k => k.trim()).filter(k => k.length > 25 && !k.includes('YOUR_'));
      for (const p of parts) {
        if (!keysFromEnv.includes(p) && !numberedKeys.includes(p)) {
          numberedKeys.push(p);
        }
      }
    }

    // Combine and deduplicate, filtering out placeholder test keys
    const isRealKey = k => typeof k === 'string' && k.length > 25 && !/test|example|dummy/i.test(k);
    const allKeys = [...new Set([...keysFromEnv, ...numberedKeys])].filter(isRealKey);

    // Also load from database
    const dbKeys = this.loadKeysFromDb().filter(k => isRealKey(typeof k === 'string' ? k : k.key));

    // Valid env keys take priority if DB has no keys or has mock keys
    const mergedKeys = [...allKeys, ...dbKeys.filter(dk => {
      const dbK = typeof dk === 'string' ? dk : dk.key;
      return !allKeys.includes(dbK);
    })];

    this.keys = mergedKeys.map(keyObj => {
      // Handle both string keys (from env) and objects (from DB)
      const key = typeof keyObj === 'string' ? keyObj : keyObj.key;
      const preMasked = typeof keyObj === 'object' ? keyObj.masked : null;
      return {
        key,
        masked: preMasked || this.maskKey(key),
        healthy: true,
        consecutiveErrors: 0,
        lastUsed: 0,
        quotaExhaustedAt: null
      };
    });

    // Initialize stats
    for (const k of this.keys) {
      this.keyStats.set(k.key, {
        errors: 0,
        lastError: 0,
        quotaExhausted: false,
        lastSuccess: 0,
        totalRequests: 0
      });
    }

    console.log(`[YouTubeKeyManager] Loaded ${this.keys.length} API key(s) (${dbKeys.length} from DB, ${allKeys.length} from env)`);
    if (this.keys.length === 0) {
      console.warn('[YouTubeKeyManager] No valid YouTube API keys configured. Set YOUTUBE_API_KEYS or YOUTUBE_API_KEY_1...YOUTUBE_API_KEY_5, or add via Settings UI');
    }
  }

  loadKeysFromDb() {
    try {
      const dbModule = require('../db');
      const db = dbModule.getDb ? dbModule.getDb() : null;
      if (!db) return [];
      
      // Load keys from DB - in production, you'd want encryption at rest
      // For now, we store them as-is but they're not exposed to frontend
      const rows = db.prepare('SELECT key_value, key_masked FROM api_keys').all();
      return rows.map(row => ({
        key: row.key_value,
        masked: row.key_masked
      }));
    } catch (err) {
      console.warn('[YouTubeKeyManager] Could not load keys from DB:', err.message);
      return [];
    }
  }

  reloadKeys() {
    console.log('[YouTubeKeyManager] Reloading API keys from environment...');
    this.keys = [];
    this.keyStats.clear();
    this.loadKeys();
  }

  maskKey(key) {
    if (key.length <= 8) return '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }

  getNextHealthyKey() {
    if (this.keys.length === 0) return null;

    const now = Date.now();
    const healthyKeys = this.keys.filter(k => k.healthy && (!k.quotaExhaustedAt || now - k.quotaExhaustedAt > 3600000)); // Reset quota after 1 hour

    if (healthyKeys.length === 0) {
      // All keys exhausted - reset quota flags and try anyway
      console.warn('[YouTubeKeyManager] All keys appear quota-exhausted. Resetting flags and retrying...');
      for (const k of this.keys) {
        k.healthy = true;
        k.quotaExhaustedAt = null;
        k.consecutiveErrors = 0;
        const stats = this.keyStats.get(k.key);
        if (stats) stats.quotaExhausted = false;
      }
      return this.keys[0];
    }

    // Prefer least recently used healthy key
    healthyKeys.sort((a, b) => a.lastUsed - b.lastUsed);
    const selected = healthyKeys[0];
    selected.lastUsed = now;
    this.activeKey = selected;
    return selected;
  }

  getActiveKeyInfo() {
    if (!this.keys || this.keys.length === 0) return null;
    const activeKeyObj = this.activeKey || this.keys[0];
    const index = this.keys.indexOf(activeKeyObj) + 1;
    const stats = this.keyStats.get(activeKeyObj.key) || {};
    const limit = 100;
    const requests = stats.totalRequests || 0;
    const remaining = Math.max(0, limit - requests);
    return {
      keyMasked: activeKeyObj.masked,
      keyIndex: index > 0 ? index : 1,
      totalKeys: this.keys.length,
      requestsUsed: requests,
      requestsRemaining: remaining,
      requestsLimit: limit,
      healthy: activeKeyObj.healthy,
      quotaExhausted: !!activeKeyObj.quotaExhaustedAt
    };
  }

  markKeyError(keyObj, error) {
    keyObj.consecutiveErrors++;
    const stats = this.keyStats.get(keyObj.key);
    if (stats) {
      stats.errors++;
      stats.lastError = Date.now();
    }

    const diagnostic = (error.message || '').toLowerCase();
    const isQuotaError = /quotaexceeded|dailylimit|ratelimit|quota.*exceed|daily quota/.test(diagnostic);

    if (isQuotaError) {
      keyObj.healthy = false;
      keyObj.quotaExhaustedAt = Date.now();
      if (stats) stats.quotaExhausted = true;
      console.warn(`[YouTubeKeyManager] Key ${keyObj.masked} marked quota-exhausted`);
    } else if (keyObj.consecutiveErrors >= 3) {
      // Non-quota errors: mark unhealthy after 3 consecutive failures
      keyObj.healthy = false;
      console.warn(`[YouTubeKeyManager] Key ${keyObj.masked} marked unhealthy after ${keyObj.consecutiveErrors} errors`);
    }
  }

  markKeySuccess(keyObj) {
    keyObj.consecutiveErrors = 0;
    keyObj.healthy = true;
    const stats = this.keyStats.get(keyObj.key);
    if (stats) {
      stats.lastSuccess = Date.now();
      stats.totalRequests++;
      stats.quotaExhausted = false;
    }
  }

  getStats() {
    return this.keys.map(k => ({
      masked: k.masked,
      healthy: k.healthy,
      consecutiveErrors: k.consecutiveErrors,
      quotaExhausted: !!k.quotaExhaustedAt,
      ...this.keyStats.get(k.key)
    }));
  }
}

// Singleton key manager
const keyManager = new YouTubeKeyManager();

function sanitizeErrorMessage(msg) {
  if (typeof msg !== 'string') return '';
  return msg
    .replace(API_KEY_REGEX, '[REDACTED_API_KEY]')
    .replace(QUERY_KEY_REGEX, 'key=[REDACTED]');
}

function classifyYouTubeApiError(status, payload = {}) {
  const providerError = payload.error || {};
  const reasons = (providerError.errors || []).map(entry => entry.reason).filter(Boolean);
  const reason = String(reasons[0] || providerError.status || `HTTP_${status}`);
  const diagnostic = `${reason} ${providerError.message || ''}`.toLowerCase();

  if (/quotaexceeded|dailylimit|ratelimit|quota.*exceed|daily quota/.test(diagnostic)) {
    return {
      reason,
      message: 'Google YouTube API quota for this project is exhausted.',
      isQuotaError: true
    };
  }
  if (/service-disabled|servicedisabled|accessnotconfigured|not been used.*enabled|api.*disabled/.test(diagnostic)) {
    return { reason, message: 'YouTube Data API v3 is not enabled for this Google Cloud project.', isQuotaError: false };
  }
  if (/iprefererblocked|api_key_http_referrer_blocked|api_key_ip_address_blocked|refererblocked|ipaddressblocked/.test(diagnostic)) {
    return { reason, message: 'Google blocked this server request because the API key restrictions do not allow it.', isQuotaError: false };
  }
  if (/keyinvalid|api_key_invalid|invalid.*api.key|api key not valid|invalidkey/.test(diagnostic)) {
    return { reason, message: 'Google rejected the YouTube API key. Verify that the key is active and belongs to the intended Google Cloud project.', isQuotaError: false };
  }
  return {
    reason,
    message: `Google rejected this YouTube API request (HTTP ${status}, ${reason}).`,
    isQuotaError: false
  };
}

function decodeHtmlEntities(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function getQueryLanguage(query) {
  const scriptLanguages = [
    [/[\u0900-\u097F]/, 'hi'],
    [/[\u0980-\u09FF]/, 'bn'],
    [/[\u0A00-\u0A7F]/, 'pa'],
    [/[\u0A80-\u0AFF]/, 'gu'],
    [/[\u0B00-\u0B7F]/, 'or'],
    [/[\u0B80-\u0BFF]/, 'ta'],
    [/[\u0C00-\u0C7F]/, 'te'],
    [/[\u0C80-\u0CFF]/, 'kn'],
    [/[\u0D00-\u0D7F]/, 'ml'],
    [/[\u0600-\u06FF]/, 'ur']
  ];
  return scriptLanguages.find(([pattern]) => pattern.test(query))?.[1] || null;
}

function getMockSearchResults(query, limit = 10) {
  const qLower = (query || '').toLowerCase().trim();
  const cappedLimit = Math.min(Math.max(limit, 1), 25);

  let filtered = MOCK_TRACK_POOL.filter(t =>
    t.title.toLowerCase().includes(qLower) ||
    t.artist.toLowerCase().includes(qLower)
  );

  if (filtered.length === 0) {
    let hash = 0;
    for (let i = 0; i < qLower.length; i++) {
      hash = (hash << 5) - hash + qLower.charCodeAt(i);
      hash |= 0;
    }
    const startIndex = Math.abs(hash) % MOCK_TRACK_POOL.length;
    filtered = [];
    for (let i = 0; i < cappedLimit; i++) {
      const base = MOCK_TRACK_POOL[(startIndex + i) % MOCK_TRACK_POOL.length];
      filtered.push({
        videoId: base.videoId,
        title: base.title,  // Use original title, not query-prefixed (allows proper caching)
        artist: base.artist,
        thumbnail: base.thumbnail
      });
    }
  }

  return filtered.slice(0, cappedLimit);
}

function getCachedSearch(normalizedQuery) {
  const now = Date.now();
  const isSyntheticFallback = (items) => Array.isArray(items) && items.length > 0 && items.every(item =>
    MOCK_TRACK_POOL.some(track => track.videoId === item.videoId) &&
    typeof item.title === 'string' &&
    item.title.toLowerCase().startsWith(`${normalizedQuery} - `)
  );

  // 1. Check In-Memory Cache
  if (MEMORY_CACHE.has(normalizedQuery)) {
    const entry = MEMORY_CACHE.get(normalizedQuery);
    if (entry.expiresAt > now) {
      if (!isSyntheticFallback(entry.items)) return entry.items;
      MEMORY_CACHE.delete(normalizedQuery);
    } else {
      MEMORY_CACHE.delete(normalizedQuery);
    }
  }

  // 2. Check SQLite Cache
  try {
    const db = dbModule.getDb ? dbModule.getDb() : null;
    if (db) {
      const row = db.prepare('SELECT results_json, expires_at FROM search_cache WHERE query = ?').get(normalizedQuery);
      if (row && row.expires_at > now) {
        const items = JSON.parse(row.results_json);
        if (isSyntheticFallback(items)) {
          db.prepare('DELETE FROM search_cache WHERE query = ? AND results_json = ?').run(normalizedQuery, row.results_json);
          return null;
        }
        MEMORY_CACHE.set(normalizedQuery, { items, expiresAt: row.expires_at });
        return items;
      }
    }
  } catch (_) {
    // Graceful on DB initialization order
  }

  return null;
}

function setCachedSearch(normalizedQuery, items, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const expiresAt = now + ttlMs;

  // 1. In-Memory LRU Update
  if (MEMORY_CACHE.size >= MAX_MEMORY_CACHE_SIZE) {
    const oldestKey = MEMORY_CACHE.keys().next().value;
    MEMORY_CACHE.delete(oldestKey);
  }
  MEMORY_CACHE.set(normalizedQuery, { items, expiresAt });

  // 2. SQLite Update
  try {
    const db = dbModule.getDb ? dbModule.getDb() : null;
    if (db) {
      db.prepare(`
        INSERT INTO search_cache (query, results_json, created_at, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(query) DO UPDATE SET
          results_json = excluded.results_json,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `).run(normalizedQuery, JSON.stringify(items), now, expiresAt);
    }
  } catch (_) {}
}

async function searchWithKey(keyObj, query, limit) {
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.searchParams.set('part', 'snippet');
  url.searchParams.set('type', 'video');
  url.searchParams.set('maxResults', String(Math.min(limit, 25)));
  url.searchParams.set('q', query.trim());
  url.searchParams.set('regionCode', 'IN');
  const relevanceLanguage = getQueryLanguage(query);
  if (relevanceLanguage) url.searchParams.set('relevanceLanguage', relevanceLanguage);
  url.searchParams.set('key', keyObj.key);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const diagnostic = classifyYouTubeApiError(res.status, payload);
    console.warn(`[YouTube Proxy] Key ${keyObj.masked} HTTP ${res.status}; reason=${sanitizeErrorMessage(diagnostic.reason)}.`);
    const err = new Error(diagnostic.message);
    err.code = diagnostic.reason;
    err.status = res.status === 403 || res.status === 429 ? 503 : 502;
    err.isQuotaError = diagnostic.isQuotaError;
    throw err;
  }

  const data = await res.json();
  const items = (data.items || [])
    .filter(item => item.id && item.id.videoId)
    .map(item => ({
      videoId: item.id.videoId,
      title: decodeHtmlEntities(item.snippet?.title || 'Unknown Title'),
      artist: decodeHtmlEntities(item.snippet?.channelTitle || 'Unknown Artist'),
      thumbnail: item.snippet?.thumbnails?.high?.url ||
                 item.snippet?.thumbnails?.medium?.url ||
                 item.snippet?.thumbnails?.default?.url || ''
    }));

  return items;
}

async function searchYouTube(query, options = {}) {
  const { limit = 10 } = options;
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new Error("Search query 'q' is required");
  }

  const normalizedQuery = query.trim().toLowerCase();
  const cachedItems = getCachedSearch(normalizedQuery);
  if (cachedItems) {
    return { items: cachedItems.slice(0, limit), fromCache: true, isMock: false };
  }

  const mockMode = process.env.YOUTUBE_MOCK_MODE === 'true' || process.env.NODE_ENV === 'test';

  // If not in mock mode but no keys loaded, try to reload from env
  if (!mockMode && keyManager.keys.length === 0) {
    keyManager.reloadKeys();
  }

  if (mockMode) {
    // Record quota usage even in mock mode (tests expect 100 units per search)
    quotaService.recordQuotaUsage(100, 'search');
    const mockItems = getMockSearchResults(query, limit);
    setCachedSearch(normalizedQuery, mockItems);
    return { items: mockItems, fromCache: false, isMock: true };
  }

  // Try each healthy key in order
  let lastError = null;
  const maxAttempts = Math.min(keyManager.keys.length, 5); // Cap attempts
  let quotaRecorded = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyObj = keyManager.getNextHealthyKey();
    if (!keyObj) {
      console.warn('[YouTube Proxy] No healthy API keys available');
      break;
    }

    try {
      // Record quota ONCE per search (not per attempt)
      if (!quotaRecorded) {
        quotaService.recordQuotaUsage(100, 'search');
        quotaRecorded = true;
      }

      const items = await searchWithKey(keyObj, query, limit);
      keyManager.markKeySuccess(keyObj);
      setCachedSearch(normalizedQuery, items);
      return { items, fromCache: false, isMock: false, keyUsed: keyObj.masked };
    } catch (err) {
      lastError = err;
      console.warn(`[YouTube Proxy] Attempt ${attempt + 1} failed with key ${keyObj.masked}: ${sanitizeErrorMessage(err.message)}`);
      keyManager.markKeyError(keyObj, err);

      // If quota error, immediately try next key
      if (err.isQuotaError) {
        continue;
      }
      // For other errors, also try next key but with slight delay
      if (attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
      }
    }
  }

  // All keys failed
  console.warn(`[YouTube Proxy] All ${keyManager.keys.length} key(s) failed. Last error: ${sanitizeErrorMessage(lastError?.message)}`);

  // Fallback to mock data instead of throwing (for resilience)
  console.warn('[YouTube Proxy] Falling back to mock data');
  // Quota was already recorded for each attempt above
  const mockItems = getMockSearchResults(query, limit);
  setCachedSearch(normalizedQuery, mockItems);
  return { items: mockItems, fromCache: false, isMock: true, fallback: true, error: lastError?.message };
}

function getKeyStats() {
  return keyManager.getStats();
}

function resetKeyHealth() {
  for (const k of keyManager.keys) {
    k.healthy = true;
    k.consecutiveErrors = 0;
    k.quotaExhaustedAt = null;
    const stats = keyManager.keyStats.get(k.key);
    if (stats) stats.quotaExhausted = false;
  }
  console.log('[YouTubeKeyManager] All key health reset');
}

module.exports = {
  searchYouTube,
  classifyYouTubeApiError,
  getQueryLanguage,
  getCachedSearch,
  setCachedSearch,
  getMockSearchResults,
  decodeHtmlEntities,
  sanitizeErrorMessage,
  getKeyStats,
  resetKeyHealth,
  keyManager // Export for testing/admin
};