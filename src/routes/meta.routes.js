/** Health, stats and call-log endpoints (used by monitors and the dashboard). */
import { Router } from 'express';
import { asyncRoute } from '../middleware/error.js';
import { getDb } from '../db/index.js';
import { getStats, listCalls } from '../domain/patient.service.js';
import { config } from '../config.js';

export const metaRouter = Router();

metaRouter.get('/health', (req, res) => {
  // Touch the database so the check fails loudly if the volume is unmounted.
  let database = 'ok';
  try {
    getDb().prepare('SELECT 1 AS ok').get();
  } catch (err) {
    database = `error: ${err.message}`;
  }

  const healthy = database === 'ok';
  res.status(healthy ? 200 : 503).json({
    data: {
      status: healthy ? 'healthy' : 'degraded',
      database,
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
  asyncRoute((req, res) => res.ok(getStats())),
);

metaRouter.get(
  '/calls',
  asyncRoute((req, res) => res.ok({ calls: listCalls({ limit: 100 }) })),
);
