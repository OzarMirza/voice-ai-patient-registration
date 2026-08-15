import { config } from '../config.js';

/**
 * Optional API-key gate for mutating REST endpoints.
 *
 * Disabled unless API_KEY is set, so reviewers can exercise POST/PUT/DELETE
 * out of the box. The voice agent never passes through here — it calls the
 * service layer in-process — so turning this on does not break phone
 * registration.
 */
export function requireApiKey(req, res, next) {
  if (!config.apiKey) return next();

  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
  const provided = bearer || req.get('x-api-key');

  if (provided !== config.apiKey) {
    return res.fail(401, 'unauthorized', 'A valid API key is required for this operation');
  }
  return next();
}

/**
 * In-memory fixed-window rate limiter. Enough to stop a stray script from
 * hammering a demo box; a real deployment would use a shared store.
 */
export function rateLimit({ windowMs = 60_000, max = 240 } = {}) {
  const hits = new Map();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    const entry = hits.get(key);

    if (!entry || now > entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;
      if (entry.count > max) {
        res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
        return res.fail(429, 'rate_limited', 'Too many requests — please slow down');
      }
    }

    // Opportunistic cleanup so the map cannot grow without bound.
    if (hits.size > 5000) {
      for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
    }
    return next();
  };
}

/** Conservative security headers (avoids pulling in helmet for five lines). */
export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
}
