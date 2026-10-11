/**
 * SQLite Database inspection and cleanup helper for tests.
 * Uses native node:sqlite DatabaseSync available in Node.js v24.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.resolve(__dirname, '../../isa_music.db');

function getDatabase(dbPath = DB_PATH) {
  if (!fs.existsSync(dbPath)) {
    // Return null or create in-memory/test if needed
    return null;
  }
  return new DatabaseSync(dbPath);
}

function verifyTablesExist(dbPath = DB_PATH) {
  const db = getDatabase(dbPath);
  if (!db) {
    return {
      connected: false,
      tables: [],
      error: `Database file not found at ${dbPath}`
    };
  }

  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tables = rows.map(r => r.name);
    return {
      connected: true,
      tables,
      hasUsers: tables.includes('users'),
      hasLibrary: tables.includes('liked_library'),
      hasQuota: tables.includes('api_quota'),
      hasCache: tables.includes('search_cache')
    };
  } catch (err) {
    return {
      connected: false,
      tables: [],
      error: err.message
    };
  }
}

function findUserByEmail(email, dbPath = DB_PATH) {
  const db = getDatabase(dbPath);
  if (!db) return null;
  try {
    return db.prepare('SELECT id, email, created_at FROM users WHERE email = ?').get(email);
  } catch {
    return null;
  }
}

function cleanUserByEmail(email, dbPath = DB_PATH) {
  const db = getDatabase(dbPath);
  if (!db) return false;
  try {
    const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (user && user.id) {
      try {
        db.prepare('DELETE FROM liked_library WHERE user_id = ?').run(user.id);
      } catch {}
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DB_PATH,
  getDatabase,
  verifyTablesExist,
  findUserByEmail,
  cleanUserByEmail
};
