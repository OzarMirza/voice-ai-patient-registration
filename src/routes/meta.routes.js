/** Health, stats and call-log endpoints (used by monitors and the dashboard). */
import { Router } from 'express';
import { asyncRoute } from '../middleware/error.js';
import { getDb } from '../db/index.js';
import { getStats, listCalls } from '../domain/patient.service.js';
import { config } from '../config.js';

export const metaRouter = Router();

metaRouter.get('/health', async (req, res) => {
  // Touch the database so the check fails loudly if the connection is broken
  // rather than reporting healthy right up until the first phone call.
  let database = 'ok';
  let storage = 'unknown';
  try {
    const db = await getDb();
    await db.get('SELECT 1 AS ok');
    storage = db.driver.name;
  } catch (err) {
    database = `error: ${err.message}`;
  }

  // A misconfigured deployment (DATABASE_URL missing) still connects happily
  // to a local file and would otherwise report perfect health right up until
  // the container restarts and takes every patient record with it. Say plainly
  // when storage is not durable rather than letting that pass silently.
  const ephemeral = storage === 'sqlite' && config.env === 'production';

  const healthy = database === 'ok';
  res.status(healthy ? 200 : 503).json({
    data: {
      status: healthy ? 'healthy' : 'degraded',
      database,
      storage,
      persistent: !ephemeral,
      ...(ephemeral
        ? {
            warning:
              'Running in production against a local SQLite file. Data will be LOST on restart — set DATABASE_URL and DATABASE_AUTH_TOKEN to a Turso database.',
          }
        : {}),
      uptime_seconds: Math.round(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
      voice_agent_configured: Boolean(config.vapi.apiKey || config.vapi.assistantId),
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
});

metaRouter.get(
  '/stats',
  asyncRoute(async (req, res) => res.ok(await getStats())),
);

metaRouter.get(
  '/calls',
  asyncRoute(async (req, res) => res.ok({ calls: await listCalls({ limit: 100 }) })),
);
