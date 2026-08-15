/**
 * Local driver — Node's built-in `node:sqlite`.
 *
 * Used for development and the test suite: a real SQLite file, no accounts, no
 * network, no install step. The synchronous API is wrapped in promises so it
 * satisfies the same async contract as the Turso driver, which means the
 * service layer is written once and never learns which driver it is talking to.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Statements that return rows. We control every query in this codebase, so a
// leading-keyword test is sufficient (and avoids parsing SQL).
const RETURNS_ROWS = /^\s*(select|pragma|with|explain)/i;

export function createLocalDriver(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const db = new DatabaseSync(filePath);

  // WAL keeps dashboard reads from blocking the writes that happen mid-call.
  // busy_timeout makes a contended write wait rather than throwing at someone
  // who is currently on the phone.
  if (filePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  return {
    name: 'sqlite',
    description: filePath,

    async execute({ sql, args = [] }) {
      const stmt = db.prepare(sql);
      if (RETURNS_ROWS.test(sql)) {
        return { rows: stmt.all(...args), rowsAffected: 0 };
      }
      const info = stmt.run(...args);
      return { rows: [], rowsAffected: Number(info.changes ?? 0) };
    },

    async executeMultiple(sql) {
      db.exec(sql);
    },

    async close() {
      db.close();
    },
  };
}
