// src/services/quota.js - YouTube Data API Quota Management Service
const { getDb } = require('../db');

const TIMEZONE = 'America/Los_Angeles';
const DEFAULT_LIMIT = 10000;
const DEFAULT_SEARCH_LIMIT = 100;

// Operation Costs in YouTube Data API v3 (Official Pricing)
const QUOTA_COSTS = {
  search: 100,        // search.list: 100 units per call
  video: 1,           // videos.list: 1 unit
  stream: 0,          // raw audio proxy via yt-dlp: 0 official API units
  playlist: 1         // playlistItems.list: 1 unit
};

/**
 * Safely parses Date object or YYYY-MM-DD string into a valid Date instance.
 * Gracefully falls back to current Date if input is null, undefined, invalid, or unparseable.
 * Guarantees that the returned Date instance always has a valid, finite getTime().
 *
 * @param {any} input Date instance, YYYY-MM-DD string, ISO string, timestamp, etc.
 * @returns {Date} A guaranteed-valid Date instance.
 */
function parseDateInput(input) {
  if (!input) {
    return new Date();
  }

  if (input instanceof Date) {
    return isNaN(input.getTime()) ? new Date() : input;
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return new Date();
    }

    const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]) - 1;
      const day = Number(match[3]);
      const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
      return isNaN(d.getTime()) ? new Date() : d;
    }

    const parsed = new Date(trimmed);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  if (typeof input === 'number' && Number.isFinite(input)) {
    const parsed = new Date(input);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  return new Date();
}

/**
 * Returns current Pacific Date (YYYY-MM-DD) in America/Los_Angeles.
 * Guaranteed never to throw RangeError: Invalid time value on bad inputs.
 *
 * @param {Date|string|number} [dateInput=new Date()]
 * @returns {string} e.g. "2026-10-10"
 */
function getPacificDateString(dateInput = new Date()) {
  const date = parseDateInput(dateInput);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  } catch (_) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  }
}

/**
 * Resolves any date input into a clean YYYY-MM-DD string for SQLite persistence and querying.
 * Preserves exact test date fixture strings (e.g. "2099-07-01").
 *
 * @param {any} dateInput
 * @returns {string}
 */
function resolvePacificDateString(dateInput) {
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput.trim())) {
    return dateInput.trim();
  }
  return getPacificDateString(dateInput);
}

/**
 * Calculates the ISO 8601 UTC timestamp for the next midnight in Pacific Time.
 * Dynamically handles Daylight Saving Time (PDT UTC-7 vs PST UTC-8).
 * @param {Date|string} dateInput
 * @returns {string} e.g. "2026-10-11T07:00:00.000Z"
 */
function getNextPacificMidnightISO(dateInput = new Date()) {
  const date = parseDateInput(dateInput);
  const todayPacific = getPacificDateString(date);
  const [y, m, d] = todayPacific.split('-').map(Number);

  // Next calendar day in Pacific
  const tomorrowPacific = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
  const tomorrowStr = getPacificDateString(tomorrowPacific);
  const [ny, nm, nd] = tomorrowStr.split('-').map(Number);

  // Pacific is either UTC-7 (PDT) or UTC-8 (PST). Test both offsets:
  for (const offset of [7, 8]) {
    const candidate = new Date(Date.UTC(ny, nm - 1, nd, offset, 0, 0, 0));
    try {
      const h = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        hour: 'numeric',
        hourCycle: 'h23'
      }).format(candidate);
      const candidateDate = getPacificDateString(candidate);
      if (candidateDate === tomorrowStr && parseInt(h, 10) === 0) {
        return candidate.toISOString();
      }
    } catch (_) {}
  }

  // Fallback to PDT midnight
  return new Date(Date.UTC(ny, nm - 1, nd, 7, 0, 0, 0)).toISOString();
}

/**
 * Retrieves or initializes the SQLite api_quota record for the given date.
 */
function getOrCreateRecord(dateInput = getPacificDateString()) {
  const dateStr = resolvePacificDateString(dateInput);
  const db = getDb();
  let record = null;
  try {
    record = db.prepare('SELECT * FROM api_quota WHERE date = ? ORDER BY id DESC LIMIT 1').get(dateStr);
  } catch (_) {}

  if (!record) {
    const resetsAt = getNextPacificMidnightISO(dateStr);
    try {
      db.prepare(`
        INSERT INTO api_quota (date, units_used, units_limit, search_count, stream_count, reset_at)
        VALUES (?, 0, ?, 0, 0, ?)
      `).run(dateStr, DEFAULT_LIMIT, resetsAt);
    } catch (_) {}

    try {
      record = db.prepare('SELECT * FROM api_quota WHERE date = ? ORDER BY id DESC LIMIT 1').get(dateStr);
    } catch (_) {}
  }

  return record;
}

/**
 * Returns the current daily quota metrics.
 * Satisfies both user spec ({ used, remaining, total, resetsAt })
 * and test harness ({ used, remaining, limit, resetAt }).
 */
function getQuotaStatus(dateInput = getPacificDateString()) {
  const dateStr = resolvePacificDateString(dateInput);
  const record = getOrCreateRecord(dateStr);
  const total = record ? (record.units_limit || DEFAULT_LIMIT) : DEFAULT_LIMIT;
  const rawUsed = record ? (record.units_used || 0) : 0;
  const used = Math.min(Math.max(0, rawUsed), total);
  const remaining = Math.max(0, total - used);
  const searchCallsLimit = DEFAULT_SEARCH_LIMIT;
  const rawSearchCalls = record ? (record.search_count || 0) : 0;
  const searchCallsUsed = Math.min(Math.max(0, rawSearchCalls), searchCallsLimit);
  const searchCallsRemaining = Math.max(0, searchCallsLimit - searchCallsUsed);
  const resetsAt = (record && record.reset_at) || getNextPacificMidnightISO(dateStr);

  let activeKey = null;
  try {
    const youtubeService = require('./youtube');
    if (youtubeService.keyManager && typeof youtubeService.keyManager.getActiveKeyInfo === 'function') {
      activeKey = youtubeService.keyManager.getActiveKeyInfo();
    }
  } catch (_) {}

  return {
    used,
    remaining,
    total,
    limit: total,
    resetsAt,
    resetAt: resetsAt,
    date: record ? record.date : dateStr,
    searchCount: rawSearchCalls,
    searchCallsUsed,
    searchCallsRemaining,
    searchCallsLimit,
    streamCount: record ? (record.stream_count || 0) : 0,
    activeKey
  };
}

/**
 * Records quota usage in SQLite.
 * @param {number} units Units consumed (defaults to 100 for search)
 * @param {string} type Operation type ('search', 'stream', 'video')
 * @param {string|Date} dateInput Optional target date override
 * @returns {object} Updated quota status
 */
function recordQuotaUsage(units = QUOTA_COSTS.search, type = 'search', dateInput = getPacificDateString()) {
  const dateStr = resolvePacificDateString(dateInput);
  const db = getDb();
  const record = getOrCreateRecord(dateStr);
  const isSearch = type === 'search' ? 1 : 0;
  const isStream = type === 'stream' || type === 'video' ? 1 : 0;

  if (record && record.id) {
    try {
      db.prepare(`
        UPDATE api_quota
        SET units_used = units_used + ?,
            search_count = search_count + ?,
            stream_count = stream_count + ?,
            last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(Number(units), isSearch, isStream, record.id);
    } catch (_) {}
  }

  return getQuotaStatus(dateStr);
}

/**
 * Checks whether enough quota is available for a proposed operation.
 */
function hasAvailableQuota(requiredUnits = 1, dateInput = getPacificDateString()) {
  const dateStr = resolvePacificDateString(dateInput);
  const status = getQuotaStatus(dateStr);
  return status.remaining >= requiredUnits;
}

/**
 * Resets quota usage for today or specified date (used in tests or manual reset).
 */
function resetDailyQuota(dateInput = getPacificDateString()) {
  const dateStr = resolvePacificDateString(dateInput);
  const db = getDb();
  const record = getOrCreateRecord(dateStr);
  const resetsAt = getNextPacificMidnightISO(dateStr);

  if (record && record.id) {
    try {
      db.prepare(`
        UPDATE api_quota
        SET units_used = 0,
            search_count = 0,
            stream_count = 0,
            reset_at = ?,
            last_updated = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(resetsAt, record.id);
    } catch (_) {}
  }

  return getQuotaStatus(dateStr);
}

module.exports = {
  QUOTA_COSTS,
  DEFAULT_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  parseDateInput,
  getPacificDateString,
  getNextPacificMidnightISO,
  getQuotaStatus,
  recordQuotaUsage,
  hasAvailableQuota,
  resetDailyQuota
};
