/**
 * Minimal structured logger. Emits one JSON object per line to stdout, which is
 * what Railway/Render/Fly all ingest natively — no logging dependency needed.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(meta && Object.keys(meta).length ? { ...meta } : {}),
  };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const logger = {
  debug: (message, meta) => emit('debug', message, meta),
  info: (message, meta) => emit('info', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  error: (message, meta) => emit('error', message, meta),
};
