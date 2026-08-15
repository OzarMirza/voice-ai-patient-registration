/**
 * Patient service — the single source of truth for reading and writing
 * patient data.
 *
 * Both entry points go through here: the REST routes and the voice agent's
 * tool webhook. That is deliberate. The brief allows the agent to "use the
 * REST API or directly invoke the same service layer"; calling the service
 * in-process avoids an HTTP hop to ourselves (and its failure modes) while
 * guaranteeing the phone path and the API path apply identical validation.
 */
import crypto from 'node:crypto';
import { getDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { AppError, NotFoundError, ValidationError } from '../lib/errors.js';
import {
  createPatientSchema,
  formatZodError,
  listQuerySchema,
  serializePatient,
  updatePatientSchema,
} from './patient.schema.js';

const nowIso = () => new Date().toISOString();

const COLUMNS = [
  'first_name',
  'last_name',
  'date_of_birth',
  'sex',
  'phone_number',
  'email',
  'address_line_1',
  'address_line_2',
  'city',
  'state',
  'zip_code',
  'insurance_provider',
  'insurance_member_id',
  'preferred_language',
  'emergency_contact_name',
  'emergency_contact_phone',
];

/** node:sqlite only binds null/number/string/bigint/Uint8Array. */
const bind = (v) => (v === undefined ? null : v);

function wrapSqliteError(err, action) {
  if (String(err.message || '').includes('CHECK constraint failed')) {
    // The schema rejected something Zod let through — treat as a validation
    // problem rather than a 500 so the caller gets an actionable message.
    return new ValidationError('Record rejected by database constraints', [
      { field: '_root', message: err.message },
    ]);
  }
  logger.error(`db ${action} failed`, { error: err.message });
  return new AppError(`Failed to ${action} patient`, { status: 500, code: 'database_error' });
}

export function createPatient(input) {
  const parsed = createPatientSchema.safeParse(input ?? {});
  if (!parsed.success) throw new ValidationError('Validation failed', formatZodError(parsed.error));

  const data = parsed.data;
  const patientId = crypto.randomUUID();
  const ts = nowIso();

  const values = {
    ...Object.fromEntries(COLUMNS.map((c) => [c, bind(data[c])])),
    preferred_language: data.preferred_language ?? 'English',
  };

  try {
    getDb()
      .prepare(
        `INSERT INTO patients (patient_id, ${COLUMNS.join(', ')}, created_at, updated_at)
         VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      )
      .run(patientId, ...COLUMNS.map((c) => values[c]), ts, ts);
  } catch (err) {
    throw wrapSqliteError(err, 'create');
  }

  logger.info('patient created', { patient_id: patientId, last_name: data.last_name });
  return getPatientById(patientId);
}

export function getPatientById(patientId, { includeDeleted = true } = {}) {
  if (!patientId || typeof patientId !== 'string') return null;
  const sql = includeDeleted
    ? 'SELECT * FROM patients WHERE patient_id = ?'
    : 'SELECT * FROM patients WHERE patient_id = ? AND deleted_at IS NULL';
  return serializePatient(getDb().prepare(sql).get(patientId));
}

export function listPatients(rawQuery = {}) {
  const parsed = listQuerySchema.safeParse(rawQuery);
  if (!parsed.success) throw new ValidationError('Invalid query parameters', formatZodError(parsed.error));
  const q = parsed.data;

  // A DOB filter that could not be parsed is a client error, not "no results".
  if (q.date_of_birth === '__invalid__') {
    throw new ValidationError('Invalid query parameters', [
      { field: 'date_of_birth', message: 'date_of_birth must be a real date (MM/DD/YYYY or YYYY-MM-DD)' },
    ]);
  }

  const where = [];
  const params = [];

  if (!q.include_deleted) where.push('deleted_at IS NULL');
  if (q.last_name) {
    where.push('last_name LIKE ? COLLATE NOCASE');
    params.push(`%${q.last_name}%`);
  }
  if (q.date_of_birth) {
    where.push('date_of_birth = ?');
    params.push(q.date_of_birth);
  }
  if (q.phone_number) {
    where.push('phone_number = ?');
    params.push(q.phone_number);
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = getDb();

  const total = db.prepare(`SELECT COUNT(*) AS n FROM patients ${clause}`).get(...params).n;
  const rows = db
    .prepare(`SELECT * FROM patients ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, q.limit, q.offset);

  return {
    patients: rows.map(serializePatient),
    pagination: { total, limit: q.limit, offset: q.offset, returned: rows.length },
  };
}

export function updatePatient(patientId, input) {
  const existing = getPatientById(patientId);
  if (!existing) throw new NotFoundError(`No patient found with id ${patientId}`);
  if (existing.deleted_at) {
    throw new AppError('Cannot update a deleted patient record', {
      status: 409,
      code: 'record_deleted',
    });
  }

  const parsed = updatePatientSchema.safeParse(input ?? {});
  if (!parsed.success) throw new ValidationError('Validation failed', formatZodError(parsed.error));

  const data = parsed.data;
  const updates = COLUMNS.filter((c) => data[c] !== undefined);
  if (updates.length === 0) {
    throw new ValidationError('Validation failed', [
      { field: '_root', message: 'At least one updatable field must be provided' },
    ]);
  }

  try {
    getDb()
      .prepare(
        `UPDATE patients SET ${updates.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
         WHERE patient_id = ?`,
      )
      .run(...updates.map((c) => bind(data[c])), nowIso(), patientId);
  } catch (err) {
    throw wrapSqliteError(err, 'update');
  }

  logger.info('patient updated', { patient_id: patientId, fields: updates });
  return getPatientById(patientId);
}

/** Soft delete — sets deleted_at, never removes the row. Idempotent. */
export function softDeletePatient(patientId) {
  const existing = getPatientById(patientId);
  if (!existing) throw new NotFoundError(`No patient found with id ${patientId}`);
  if (existing.deleted_at) return existing;

  const ts = nowIso();
  getDb()
    .prepare('UPDATE patients SET deleted_at = ?, updated_at = ? WHERE patient_id = ?')
    .run(ts, ts, patientId);

  logger.info('patient soft-deleted', { patient_id: patientId });
  return getPatientById(patientId);
}

/**
 * Duplicate detection for returning callers. Matches on normalized digits so
 * caller ID (+15551234567) finds a record saved as 5551234567.
 */
export function findPatientsByPhone(phoneDigits) {
  if (!phoneDigits) return [];
  return getDb()
    .prepare(
      `SELECT * FROM patients
       WHERE phone_number = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
    )
    .all(phoneDigits)
    .map(serializePatient);
}

// ---------------------------------------------------------------------------
// Calls (bonus: transcript archive)
// ---------------------------------------------------------------------------

export function upsertCall({
  providerCallId,
  patientId = null,
  callerPhone = null,
  outcome = 'unknown',
  endedReason = null,
  durationSeconds = null,
  summary = null,
  transcript = null,
  collectedPayload = null,
}) {
  const db = getDb();
  const existing = providerCallId
    ? db.prepare('SELECT call_id FROM calls WHERE provider_call_id = ?').get(providerCallId)
    : null;

  const payload = collectedPayload ? JSON.stringify(collectedPayload) : null;

  if (existing) {
    db.prepare(
      `UPDATE calls SET patient_id = COALESCE(?, patient_id),
                        caller_phone = COALESCE(?, caller_phone),
                        outcome = ?,
                        ended_reason = COALESCE(?, ended_reason),
                        duration_seconds = COALESCE(?, duration_seconds),
                        summary = COALESCE(?, summary),
                        transcript = COALESCE(?, transcript),
                        collected_payload = COALESCE(?, collected_payload)
       WHERE call_id = ?`,
    ).run(
      bind(patientId), bind(callerPhone), outcome, bind(endedReason),
      bind(durationSeconds), bind(summary), bind(transcript), bind(payload), existing.call_id,
    );
    return existing.call_id;
  }

  const callId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO calls (call_id, provider_call_id, patient_id, caller_phone, outcome,
                        ended_reason, duration_seconds, summary, transcript, collected_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    callId, bind(providerCallId), bind(patientId), bind(callerPhone), outcome,
    bind(endedReason), bind(durationSeconds), bind(summary), bind(transcript), bind(payload),
  );
  return callId;
}

export function listCalls({ patientId = null, limit = 50 } = {}) {
  const db = getDb();
  const rows = patientId
    ? db
        .prepare('SELECT * FROM calls WHERE patient_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(patientId, limit)
    : db.prepare('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?').all(limit);

  return rows.map((row) => ({
    ...row,
    collected_payload: row.collected_payload ? JSON.parse(row.collected_payload) : null,
  }));
}

// ---------------------------------------------------------------------------
// Appointments (bonus: mock scheduling)
// ---------------------------------------------------------------------------

export function createAppointment({ patientId, scheduledFor, reason = null }) {
  const patient = getPatientById(patientId, { includeDeleted: false });
  if (!patient) throw new NotFoundError(`No patient found with id ${patientId}`);

  const appointmentId = crypto.randomUUID();
  getDb()
    .prepare(
      'INSERT INTO appointments (appointment_id, patient_id, scheduled_for, reason) VALUES (?, ?, ?, ?)',
    )
    .run(appointmentId, patientId, scheduledFor, bind(reason));

  logger.info('appointment created', { appointment_id: appointmentId, patient_id: patientId });
  return getDb()
    .prepare('SELECT * FROM appointments WHERE appointment_id = ?')
    .get(appointmentId);
}

export function listAppointments(patientId) {
  return getDb()
    .prepare('SELECT * FROM appointments WHERE patient_id = ? ORDER BY scheduled_for ASC')
    .all(patientId);
}

/** Counters for the dashboard header. */
export function getStats() {
  const db = getDb();
  return {
    patients_active: db.prepare('SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NULL').get().n,
    patients_deleted: db.prepare('SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NOT NULL').get().n,
    registered_today: db
      .prepare("SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NULL AND substr(created_at, 1, 10) = ?")
      .get(new Date().toISOString().slice(0, 10)).n,
    calls_logged: db.prepare('SELECT COUNT(*) AS n FROM calls').get().n,
    appointments: db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'scheduled'").get().n,
  };
}
