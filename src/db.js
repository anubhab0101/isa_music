// src/db.js - ISA Music Dual-Engine Data Access Layer (Supabase PostgreSQL & SQLite)
const path = require('path');
const fs = require('fs');

let dbInstance = null;
let pgPool = null;
let isPostgres = false;

/**
 * Initializes and returns the database connection.
 * If DATABASE_URL is configured (e.g. Supabase PostgreSQL), uses pg Pool.
 * Otherwise, falls back to local SQLite (Node native DatabaseSync or better-sqlite3).
 */
function getDb(customPath) {
  if (dbInstance) return dbInstance;

  const dbUrl = process.env.DATABASE_URL || '';

  if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
    try {
      const { Pool } = require('pg');
      pgPool = new Pool({
        connectionString: dbUrl,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000
      });
      isPostgres = true;
      console.log('[Database] Connected to persistent Supabase PostgreSQL cluster.');
      initPgSchema(pgPool);
      dbInstance = createPgDbWrapper(pgPool);
      return dbInstance;
    } catch (err) {
      console.warn('[Database] Failed to initialize PostgreSQL pool, falling back to SQLite:', err.message);
    }
  }

  // SQLite Fallback
  isPostgres = false;
  const dbPath = customPath || process.env.DB_PATH || path.join(__dirname, '..', 'isa_music.db');

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  let sqliteInstance = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    sqliteInstance = new DatabaseSync(dbPath);
  } catch (err) {
    try {
      const Database = require('better-sqlite3');
      sqliteInstance = new Database(dbPath);
    } catch (fallbackErr) {
      throw new Error(`Failed to load SQLite engine: ${err.message}. Fallback: ${fallbackErr.message}`);
    }
  }

  sqliteInstance.exec('PRAGMA foreign_keys = ON;');
  try {
    sqliteInstance.exec('PRAGMA journal_mode = WAL;');
    sqliteInstance.exec('PRAGMA synchronous = NORMAL;');
  } catch (_) {}

  initSqliteSchema(sqliteInstance);
  dbInstance = sqliteInstance;
  return dbInstance;
}

/**
 * Executes DDL migrations for Supabase PostgreSQL
 */
async function initPgSchema(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

      CREATE TABLE IF NOT EXISTS liked_library (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        video_id VARCHAR(32) NOT NULL,
        title VARCHAR(255) NOT NULL,
        artist VARCHAR(255) NOT NULL,
        thumbnail TEXT,
        duration VARCHAR(32),
        liked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, video_id)
      );
      CREATE INDEX IF NOT EXISTS idx_liked_user ON liked_library(user_id);
      CREATE INDEX IF NOT EXISTS idx_liked_user_video ON liked_library(user_id, video_id);

      CREATE TABLE IF NOT EXISTS api_quota (
        id SERIAL PRIMARY KEY,
        date VARCHAR(32),
        units_used INTEGER NOT NULL DEFAULT 0,
        units_limit INTEGER NOT NULL DEFAULT 10000,
        search_count INTEGER NOT NULL DEFAULT 0,
        stream_count INTEGER NOT NULL DEFAULT 0,
        reset_at TEXT,
        last_updated TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS search_cache (
        query VARCHAR(255) PRIMARY KEY,
        query_hash VARCHAR(64),
        results_json TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        key_value VARCHAR(255) NOT NULL,
        key_masked VARCHAR(64) NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys(created_by);
    `);
    console.log('[Database] Supabase PostgreSQL schemas verified successfully.');
  } catch (err) {
    console.warn('[Database] PostgreSQL schema migration notice:', err.message);
  }
}

/**
 * Translates standard SQLite SQL to PostgreSQL syntax (replaces '?' with '$1, $2', etc.)
 */
function translateSqlToPg(sql) {
  let paramIndex = 1;
  let pgSql = sql.replace(/\?/g, () => `$${paramIndex++}`);

  // In PostgreSQL, auto-increment last insert id requires RETURNING id
  if (/^\s*INSERT\s+INTO/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
    pgSql += ' RETURNING id';
  }

  // Handle CURRENT_TIMESTAMP syntax if any difference
  return pgSql;
}

/**
 * Wraps pgPool to provide an API identical to SQLite prepare(sql).get/all/run
 */
function createPgDbWrapper(pool) {
  return {
    isPostgres: true,
    pool,

    prepare(rawSql) {
      const pgSql = translateSqlToPg(rawSql);
      return {
        async get(...args) {
          const params = args.flat();
          try {
            const res = await pool.query(pgSql, params);
            return res.rows[0] || null;
          } catch (err) {
            console.error('[PostgreSQL get error]:', err.message, 'SQL:', pgSql);
            return null;
          }
        },

        async all(...args) {
          const params = args.flat();
          try {
            const res = await pool.query(pgSql, params);
            return res.rows || [];
          } catch (err) {
            console.error('[PostgreSQL all error]:', err.message, 'SQL:', pgSql);
            return [];
          }
        },

        async run(...args) {
          const params = args.flat();
          try {
            const res = await pool.query(pgSql, params);
            const insertedId = res.rows && res.rows[0] ? (res.rows[0].id || res.rows[0].lastinsertrowid) : 1;
            return {
              lastInsertRowid: Number(insertedId) || 1,
              changes: res.rowCount || 0
            };
          } catch (err) {
            console.error('[PostgreSQL run error]:', err.message, 'SQL:', pgSql);
            return { lastInsertRowid: 0, changes: 0 };
          }
        }
      };
    },

    async exec(sql) {
      return pool.query(sql);
    },

    close() {
      if (pool) {
        pool.end().catch(() => {});
      }
    }
  };
}

/**
 * Executes DDL migrations for SQLite
 */
function initSqliteSchema(db) {
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

  try {
    const quotaCols = db.prepare('PRAGMA table_info(api_quota)').all().map(c => c.name);
    if (!quotaCols.includes('date')) db.exec('ALTER TABLE api_quota ADD COLUMN date TEXT;');
    if (!quotaCols.includes('units_limit')) db.exec('ALTER TABLE api_quota ADD COLUMN units_limit INTEGER NOT NULL DEFAULT 10000;');
    if (!quotaCols.includes('search_count')) db.exec('ALTER TABLE api_quota ADD COLUMN search_count INTEGER NOT NULL DEFAULT 0;');
    if (!quotaCols.includes('stream_count')) db.exec('ALTER TABLE api_quota ADD COLUMN stream_count INTEGER NOT NULL DEFAULT 0;');
    if (!quotaCols.includes('reset_at')) db.exec('ALTER TABLE api_quota ADD COLUMN reset_at TEXT;');
    if (!quotaCols.includes('last_updated')) db.exec('ALTER TABLE api_quota ADD COLUMN last_updated DATETIME DEFAULT CURRENT_TIMESTAMP;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_api_quota_date ON api_quota(date);');
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
  async create(email, passwordHash) {
    const db = getDb();
    const stmt = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)');
    const res = await stmt.run(email, passwordHash);
    return {
      id: Number(res.lastInsertRowid),
      email,
      created_at: new Date().toISOString()
    };
  },

  async findByEmail(email) {
    const db = getDb();
    const stmt = db.prepare('SELECT id, email, password_hash, created_at FROM users WHERE email = ?');
    return (await stmt.get(email)) || null;
  },

  async findById(id) {
    const db = getDb();
    const stmt = db.prepare('SELECT id, email, created_at FROM users WHERE id = ?');
    return (await stmt.get(id)) || null;
  }
};

const library = {
  async add(userId, { videoId, title, artist = 'Unknown Artist', thumbnail = '', duration = '' }) {
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
    await stmt.run(userId, videoId, title, artist, thumbnail, duration);

    return await db.prepare(`
      SELECT id, video_id AS videoId, title, artist, thumbnail, duration, liked_at AS likedAt, created_at AS createdAt
      FROM liked_library
      WHERE user_id = ? AND video_id = ?
    `).get(userId, videoId);
  },

  async getByUserId(userId) {
    const db = getDb();
    const stmt = db.prepare(`
      SELECT id, video_id AS videoId, title, artist, thumbnail, duration, liked_at AS likedAt, created_at AS createdAt
      FROM liked_library
      WHERE user_id = ?
      ORDER BY liked_at DESC
    `);
    return await stmt.all(userId);
  },

  async remove(userId, videoId) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM liked_library WHERE user_id = ? AND video_id = ?');
    const res = await stmt.run(userId, videoId);
    return res.changes > 0;
  },

  async isLiked(userId, videoId) {
    const db = getDb();
    const stmt = db.prepare('SELECT id FROM liked_library WHERE user_id = ? AND video_id = ?');
    const row = await stmt.get(userId, videoId);
    return Boolean(row);
  }
};

module.exports = {
  getDb,
  initDb: () => getDb(),
  closeDb,
  users,
  library
};
