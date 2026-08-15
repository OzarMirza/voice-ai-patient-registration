/**
 * Central configuration. Everything secret or environment-specific is read here
 * and nowhere else, so there is exactly one place to audit for hardcoded keys.
 */
import path from 'node:path';

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  /**
   * SQLite file location. On Railway this points at a mounted volume
   * (e.g. /data/patients.sqlite) so records survive redeploys and restarts —
   * the assessment explicitly checks that Call 1's data exists on Call 2.
   */
  databasePath: process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'patients.sqlite'),

  /**
   * Optional bearer key for mutating REST endpoints (POST/PUT/DELETE).
   * Left unset by default so reviewers can exercise the API without friction;
   * set API_KEY in the environment to lock writes down.
   */
  apiKey: process.env.API_KEY || null,

  vapi: {
    /** Private API key — only used by scripts/provision-vapi.js, never at request time. */
    apiKey: process.env.VAPI_API_KEY || null,
    /**
     * Shared secret Vapi sends back as the `x-vapi-secret` header on every
     * webhook. If set, unsigned webhook calls are rejected with 401.
     */
    serverSecret: process.env.VAPI_SERVER_SECRET || null,
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || null,
    assistantId: process.env.VAPI_ASSISTANT_ID || null,
  },

  /** Public base URL of this service; used when registering webhooks with Vapi. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL || null,

  /** Log the full collected payload at the end of every call (required by the brief). */
  logTranscripts: bool(process.env.LOG_TRANSCRIPTS, true),

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 240),
  },
};
