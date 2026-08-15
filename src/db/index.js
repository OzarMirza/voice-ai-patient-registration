/**
 * SQLite connection.
 *
 * Uses Node's built-in `node:sqlite` (Node >= 22.5) rather than better-sqlite3
 * so the project has zero native dependencies — nothing to compile in the
 * Docker image, nothing to break on a platform's Node upgrade.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let db = null;

export function getDb() {
  if (db) return db;

  const dbPath = config.databasePath;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  db = new DatabaseSync(dbPath);

  // WAL keeps reads (dashboard, REST API) from blocking the writes that happen
  // mid-call. `busy_timeout` means a concurrent write waits rather than
  // throwing SQLITE_BUSY at a caller who is on the phone.
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  logger.info('database ready', { path: dbPath });
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/** Run a set of statements atomically. */
export function transaction(fn) {
  const conn = getDb();
  conn.exec('BEGIN');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}
