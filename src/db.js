// src/db.js - ISA Music SQLite Connection & Data Access Layer
const path = require('path');
const fs = require('fs');

let dbInstance = null;

/**
 * Initializes and returns the SQLite database connection.
 * Prioritizes Node.js native node:sqlite DatabaseSync, falling back to better-sqlite3.
 */
function getDb(customPath) {
  if (dbInstance) return dbInstance;

  const dbPath = customPath || process.env.DB_PATH || path.join(__dirname, '..', 'isa_music.db');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    dbInstance = new DatabaseSync(dbPath);
  } catch (err) {
    try {
      const Database = require('better-sqlite3');
      dbInstance = new Database(dbPath);
    } catch (fallbackErr) {
      throw new Error(`Failed to load SQLite engine: ${err.message}. Fallback: ${fallbackErr.message}`);
    }
  }

  // Enforce SQLite pragmas
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  try {
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
  } catch (_) {
    // In-memory or temporary DB may not support WAL pragma
  }

  initSchema(dbInstance);
  return dbInstance;
}

/**
 * Executes DDL migrations to ensure all tables, views, indices, and required columns exist.
 */
function initSchema(db) {
  // 1. Core tables & views
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS liked_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      thumbnail TEXT,
      duration TEXT,
      liked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, video_id)
    );
    CREATE INDEX IF NOT EXISTS idx_liked_user ON liked_library(user_id);
    CREATE INDEX IF NOT EXISTS idx_liked_user_video ON liked_library(user_id, video_id);

    CREATE VIEW IF NOT EXISTS liked_songs AS SELECT * FROM liked_library;

    CREATE TABLE IF NOT EXISTS api_quota (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT,
      units_used INTEGER NOT NULL DEFAULT 0,
      units_limit INTEGER NOT NULL DEFAULT 10000,
      search_count INTEGER NOT NULL DEFAULT 0,
      stream_count INTEGER NOT NULL DEFAULT 0,
      reset_at TEXT,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS search_cache (
      query TEXT PRIMARY KEY,
      query_hash TEXT,
      results_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_cache_expires_at ON search_cache(expires_at);

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_value TEXT NOT NULL,
      key_masked TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys(created_by);
  `);

  // 2. Schema compatibility migrations for api_quota
  try {
    const quotaCols = db.prepare('PRAGMA table_info(api_quota)').all().map(c => c.name);
    if (!quotaCols.includes('date')) {
      db.exec('ALTER TABLE api_quota ADD COLUMN date TEXT;');
    }
    if (!quotaCols.includes('units_limit')) {
      db.exec('ALTER TABLE api_quota ADD COLUMN units_limit INTEGER NOT NULL DEFAULT 10000;');
    }
    if (!quotaCols.includes('search_count')) {
      db.exec('ALTER TABLE api_quota ADD COLUMN search_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!quotaCols.includes('stream_count')) {
      db.exec('ALTER TABLE api_quota ADD COLUMN stream_count INTEGER NOT NULL DEFAULT 0;');
    }
    if (!quotaCols.includes('reset_at')) {
      db.exec('ALTER TABLE api_quota ADD COLUMN reset_at TEXT;');
    }
    if (!quotaCols.includes('last_updated')) {
      db.exec('ALTER TABLE api_quota ADD COLUMN last_updated DATETIME DEFAULT CURRENT_TIMESTAMP;');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_api_quota_date ON api_quota(date);');
    // Older app builds counted search.list as 100 units; the current API assigns 1 unit per call.
    db.exec('UPDATE api_quota SET units_used = search_count WHERE search_count > 0 AND units_used = search_count * 100;');
  } catch (_) {}

  // 3. Schema compatibility migrations for users
  try {
    const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
    if (!userCols.includes('updated_at')) {
      db.exec('ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;');
    }
  } catch (_) {}
}

function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_) {}
    dbInstance = null;
  }
}

// ----------------------------------------------------------------------------
// High-Level Data Access Methods
// ----------------------------------------------------------------------------

const users = {
  create(email, passwordHash) {
    const db = getDb();
    const stmt = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
    const res = stmt.run(email, passwordHash);
    return {
      id: Number(res.lastInsertRowid),
      email,
      created_at: new Date().toISOString()
    };
  },

  findByEmail(email) {
    const db = getDb();
    const stmt = db.prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?');
    return stmt.get(email) || null;
  },

  findById(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?');
    return stmt.get(id) || null;
  }
};

const library = {
  add(userId, { videoId, title, artist = 'Unknown Artist', thumbnail = '', duration = '' }) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO liked_library (user_id, video_id, title, artist, thumbnail, duration, liked_at)
      VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, video_id) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        thumbnail = excluded.thumbnail,
        duration = excluded.duration,
        liked_at = CURRENT_TIMESTAMP
    `);
    stmt.run(userId, videoId, title, artist, thumbnail, duration);

    return db.prepare(`
      SELECT id, video_id AS videoId, title, artist, thumbnail, duration, liked_at AS likedAt, created_at AS createdAt
      FROM liked_library
      WHERE user_id = ? AND video_id = ?
    `).get(userId, videoId);
  },

  getByUserId(userId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT id, video_id AS videoId, title, artist, thumbnail, duration, liked_at AS likedAt, created_at AS createdAt
      FROM liked_library
      WHERE user_id = ?
      ORDER BY liked_at DESC
    `);
    return stmt.all(userId);
  },

  remove(userId, videoId) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM liked_library WHERE user_id = ? AND video_id = ?');
    const res = stmt.run(userId, videoId);
    return res.changes > 0;
  },

  isLiked(userId, videoId) {
    const db = getDb();
    const stmt = db.prepare('SELECT id FROM liked_library WHERE user_id = ? AND video_id = ?');
    return !!stmt.get(userId, videoId);
  }
};

const quota = {
  getToday(dateString) {
    const db = getDb();
    let record = null;
    try {
      record = db.prepare('SELECT * FROM api_quota WHERE date = ?').get(dateString);
    } catch (_) {}

    if (!record) {
      try {
        const ins = db.prepare('INSERT INTO api_quota (date, units_used, units_limit, reset_at) VALUES (?, 0, 10000, ?)');
        ins.run(dateString, dateString);
        record = db.prepare('SELECT * FROM api_quota WHERE date = ?').get(dateString);
      } catch (_) {
        record = null;
      }
    }

    return {
      date: record?.date || dateString,
      unitsUsed: record?.units_used || 0,
      unitsLimit: record?.units_limit || 10000,
      remaining: Math.max(0, (record?.units_limit || 10000) - (record?.units_used || 0)),
      searchCount: record?.search_count || 0,
      streamCount: record?.stream_count || 0
    };
  },

  increment(dateString, units, type = 'search') {
    const db = getDb();
    quota.getToday(dateString); // ensure record exists
    const column = type === 'search' ? 'search_count' : 'stream_count';
    try {
      const stmt = db.prepare(`
        UPDATE api_quota 
        SET units_used = units_used + ?, ${column} = ${column} + 1, last_updated = CURRENT_TIMESTAMP
        WHERE date = ?
      `);
      stmt.run(units, dateString);
    } catch (_) {}
    return quota.getToday(dateString);
  }
};

const cache = {
  get(query) {
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare('SELECT results_json, expires_at FROM search_cache WHERE query = ?');
    const row = stmt.get(query);
    if (!row) return null;
    if (row.expires_at <= now) {
      db.prepare('DELETE FROM search_cache WHERE query = ?').run(query);
      return null;
    }
    try {
      return JSON.parse(row.results_json);
    } catch {
      return null;
    }
  },

  set(query, results, ttlMs = 86400000) {
    const db = getDb();
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const stmt = db.prepare(`
      INSERT INTO search_cache (query, results_json, created_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(query) DO UPDATE SET
        results_json = excluded.results_json,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `);
    stmt.run(query, JSON.stringify(results), now, expiresAt);
  },

  purgeExpired() {
    const db = getDb();
    const now = Date.now();
    const stmt = db.prepare('DELETE FROM search_cache WHERE expires_at <= ?');
    const res = stmt.run(now);
    return res.changes;
  }
};

module.exports = {
  getDb,
  initDb: () => getDb(),
  closeDb,
  users,
  library,
  quota,
  cache
};
