/**
 * Express app wiring.
 *
 * Separated from `index.js` (which owns the listener and shutdown) so tests
 * can mount the app on an ephemeral port without side effects.
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { envelope } from './middleware/envelope.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { rateLimit, securityHeaders } from './middleware/security.js';
import { patientsRouter } from './routes/patients.routes.js';
import { metaRouter } from './routes/meta.routes.js';
import { vapiRouter } from './voice/vapi.webhook.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();

  // Railway/Render sit behind a proxy; without this req.ip is always the proxy.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(securityHeaders);
  // `envelope` must come before the body parser: express.json() throws on
  // malformed JSON, and the error handler needs res.fail() to already exist
  // or that 400 turns into an unhandled 500.
  app.use(envelope);
  app.use(express.json({ limit: '256kb' }));

  // Read-only cross-origin access, so the API can be poked from a browser
  // console or an external dashboard without a proxy.
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    return next();
  });

  // One log line per request, with duration.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('request', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        duration_ms: Math.round(ms),
      });
    });
    next();
  });

  app.use(rateLimit(config.rateLimit));

  // --- Routes ------------------------------------------------------------
  app.use('/', metaRouter);

  // Primary path is the one the brief specifies. /api/patients is an alias so
  // either convention works for whoever is testing.
  app.use('/patients', patientsRouter);
  app.use('/api/patients', patientsRouter);

  app.use('/vapi', vapiRouter);

  app.use('/dashboard', express.static(publicDir, { index: 'index.html' }));

  app.get('/', (req, res) =>
    res.ok({
      service: 'Voice AI Patient Registration',
      status: 'running',
      dashboard: '/dashboard',
      health: '/health',
      endpoints: {
        list_patients: 'GET /patients?last_name=&date_of_birth=&phone_number=',
        get_patient: 'GET /patients/:id',
        create_patient: 'POST /patients',
        update_patient: 'PUT /patients/:id',
        delete_patient: 'DELETE /patients/:id (soft delete)',
        stats: 'GET /stats',
        calls: 'GET /calls',
        voice_webhook: 'POST /vapi/webhook',
      },
    }),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
