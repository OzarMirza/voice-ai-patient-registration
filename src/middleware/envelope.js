/**
 * Response envelope.
 *
 * The brief requires every JSON response to be `{ "data": ..., "error": ... }`.
 * Attaching helpers to `res` keeps that contract in one place instead of
 * relying on each route to remember the shape.
 */
export function envelope(req, res, next) {
  res.ok = (data, status = 200) => res.status(status).json({ data, error: null });
  res.fail = (status, code, message, details = null) =>
    res.status(status).json({
      data: null,
      error: { code, message, ...(details ? { details } : {}) },
    });
  next();
}
