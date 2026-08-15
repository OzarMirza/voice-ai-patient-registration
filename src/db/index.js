/**
 * Database access.
 *
 * One async interface, two interchangeable drivers:
 *
 *   - `node:sqlite`  — local file, used for development and tests
 *   - Turso (libSQL) — hosted SQLite, used in production
 *
 * Selection is by configuration alone (`DATABASE_URL` present => Turso), so
 * nothing above this file knows or cares which is active. Both are SQLite, so
 * `schema.sql` and every query are shared verbatim.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { createLocalDriver } from './drivers/local.js';
import { createTursoDriver } from './drivers/turso.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let initPromise = null;

async function initialize() {
  const driver = config.databaseUrl
    ? createTursoDriver({ url: config.databaseUrl, authToken: config.databaseAuthToken })
    : createLocalDriver(config.databasePath);

  // Idempotent: schema.sql is written entirely with CREATE TABLE/INDEX IF NOT
  // EXISTS, so this runs safely on every boot and doubles as the migration.
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  await driver.executeMultiple(schema);

  logger.info('database ready', { driver: driver.name, target: driver.description });

  return {
    driver,

    /** All matching rows. */
    async all(sql, args = []) {
      const { rows } = await driver.execute({ sql, args });
      return rows;
    },

    /** First matching row, or null. */
    async get(sql, args = []) {
      const { rows } = await driver.execute({ sql, args });
      return rows[0] ?? null;
    },

    /** A write. Returns the number of affected rows. */
    async run(sql, args = []) {
      const { rowsAffected } = await driver.execute({ sql, args });
      return rowsAffected;
    },
  };
}

/**
 * Memoized on the promise, not the result, so concurrent callers during
 * startup share a single initialization instead of racing to create schemas.
 */
export function getDb() {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

export async function closeDb() {
  if (!initPromise) return;
  const db = await initPromise;
  await db.driver.close();
  initPromise = null;
}
