import { createApp } from './app.js';
import { config } from './config.js';
import { closeDb, getDb } from './db/index.js';
import { logger } from './lib/logger.js';

// Open (and migrate) the database before accepting traffic, so a bad
// connection string fails at boot rather than on the first phone call.
await getDb();

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info('server listening', {
    port: config.port,
    env: config.env,
    database: config.databaseUrl ? 'turso (libsql)' : config.databasePath,
    public_base_url: config.publicBaseUrl ?? '(not set)',
  });
});

function shutdown(signal) {
  logger.info('shutting down', { signal });
  server.close(async () => {
    await closeDb();
    process.exit(0);
  });
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { reason: String(reason) });
});
