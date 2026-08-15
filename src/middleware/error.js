import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

export function notFoundHandler(req, res) {
  res.fail(404, 'not_found', `No route matches ${req.method} ${req.path}`);
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity
export function errorHandler(err, req, res, next) {
  // Defensive: if an error escapes before `envelope` ran, still answer in the
  // documented shape rather than falling through to Express's HTML page.
  if (typeof res.fail !== 'function') {
    res.fail = (status, code, message, details = null) =>
      res.status(status).json({ data: null, error: { code, message, ...(details ? { details } : {}) } });
  }

  // Malformed JSON body — express.json() throws this before any route runs.
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.fail(400, 'invalid_json', 'Request body is not valid JSON');
  }
  if (err?.type === 'entity.too.large') {
    return res.fail(413, 'payload_too_large', 'Request body is too large');
  }

  if (err instanceof AppError) {
    if (err.status >= 500) logger.error(err.message, { code: err.code, stack: err.stack });
    return res.fail(err.status, err.code, err.message, err.details);
  }

  logger.error('unhandled error', { message: err?.message, stack: err?.stack });
  return res.fail(
    500,
    'internal_error',
    config.env === 'production' ? 'An unexpected error occurred' : String(err?.message || err),
  );
}

/** Wrap an async route so rejected promises reach the error handler. */
export const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
