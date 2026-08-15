/**
 * Patient service — the single source of truth for reading and writing
 * patient data, and the only module in the codebase that issues SQL.
 *
 * Both entry points go through here: the REST routes and the voice agent's
 * tool webhook. That is deliberate. The brief allows the agent to "use the
 * REST API or directly invoke the same service layer"; calling the service
 * in-process avoids an HTTP hop to ourselves (and its failure modes) while
 * guaranteeing the phone path and the API path apply identical validation.
 *
 * Every function here is async because storage may be local SQLite or a
 * hosted libSQL database over the network — see `src/db/index.js`.
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

/** Drivers bind null/number/string/bigint/Uint8Array — never undefined. */
const bind = (v) => (v === undefined ? null : v);

/** COUNT() can come back as a BigInt depending on the driver. */
const count = (row) => Number(row?.n ?? 0);

function wrapDbError(err, action) {
  if (String(err.message || '').includes('CHECK constraint failed')) {
    // The schema rejected something Zod let through — surface it as a
    // validation problem rather than a 500 so the caller gets an actionable
    // message instead of "internal error".
    return new ValidationError('Record rejected by database constraints', [
      { field: '_root', message: err.message },
    ]);
  }
  logger.error(`db ${action} failed`, { error: err.message });
  return new AppError(`Failed to ${action} patient`, { status: 500, code: 'database_error' });
}

export async function createPatient(input) {
  const parsed = createPatientSchema.safeParse(input ?? {});
  if (!parsed.success) throw new ValidationError('Validation failed', formatZodError(parsed.error));

  const data = parsed.data;
  const patientId = crypto.randomUUID();
  const ts = nowIso();

  const values = {
    ...Object.fromEntries(COLUMNS.map((c) => [c, bind(data[c])])),
    preferred_language: data.preferred_language ?? 'English',
  };

  const db = await getDb();
  try {
    await db.run(
      `INSERT INTO patients (patient_id, ${COLUMNS.join(', ')}, created_at, updated_at)
       VALUES (?, ${COLUMNS.map(() => '?').join(', ')}, ?, ?)`,
      [patientId, ...COLUMNS.map((c) => values[c]), ts, ts],
    );
  } catch (err) {
    throw wrapDbError(err, 'create');
  }

  logger.info('patient created', { patient_id: patientId, last_name: data.last_name });
  return getPatientById(patientId);
}

export async function getPatientById(patientId, { includeDeleted = true } = {}) {
  if (!patientId || typeof patientId !== 'string') return null;
  const db = await getDb();
  const sql = includeDeleted
    ? 'SELECT * FROM patients WHERE patient_id = ?'
    : 'SELECT * FROM patients WHERE patient_id = ? AND deleted_at IS NULL';
  return serializePatient(await db.get(sql, [patientId]));
}

export async function listPatients(rawQuery = {}) {
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
  const db = await getDb();

  const total = count(await db.get(`SELECT COUNT(*) AS n FROM patients ${clause}`, params));
  const rows = await db.all(
    `SELECT * FROM patients ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, q.limit, q.offset],
  );

  return {
    patients: rows.map(serializePatient),
    pagination: { total, limit: q.limit, offset: q.offset, returned: rows.length },
  };
}

export async function updatePatient(patientId, input) {
  const existing = await getPatientById(patientId);
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

  const db = await getDb();
  try {
    await db.run(
      `UPDATE patients SET ${updates.map((c) => `${c} = ?`).join(', ')}, updated_at = ?
       WHERE patient_id = ?`,
      [...updates.map((c) => bind(data[c])), nowIso(), patientId],
    );
  } catch (err) {
    throw wrapDbError(err, 'update');
  }

  logger.info('patient updated', { patient_id: patientId, fields: updates });
  return getPatientById(patientId);
}

/** Soft delete — sets deleted_at, never removes the row. Idempotent. */
export async function softDeletePatient(patientId) {
  const existing = await getPatientById(patientId);
  if (!existing) throw new NotFoundError(`No patient found with id ${patientId}`);
  if (existing.deleted_at) return existing;

  const ts = nowIso();
  const db = await getDb();
  await db.run('UPDATE patients SET deleted_at = ?, updated_at = ? WHERE patient_id = ?', [
    ts,
    ts,
    patientId,
  ]);

  logger.info('patient soft-deleted', { patient_id: patientId });
  return getPatientById(patientId);
}

/**
 * Duplicate detection for returning callers. Matches on normalized digits so
 * caller ID (+15551234567) finds a record saved as 5551234567.
 */
export async function findPatientsByPhone(phoneDigits) {
  if (!phoneDigits) return [];
  const db = await getDb();
  const rows = await db.all(
    `SELECT * FROM patients
     WHERE phone_number = ? AND deleted_at IS NULL
     ORDER BY updated_at DESC`,
    [phoneDigits],
  );
  return rows.map(serializePatient);
}

// ---------------------------------------------------------------------------
// Calls (bonus: transcript archive)
// ---------------------------------------------------------------------------

export async function upsertCall({
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
  const db = await getDb();
  const existing = providerCallId
    ? await db.get('SELECT call_id FROM calls WHERE provider_call_id = ?', [providerCallId])
    : null;

  const payload = collectedPayload ? JSON.stringify(collectedPayload) : null;

  if (existing) {
    await db.run(
      `UPDATE calls SET patient_id = COALESCE(?, patient_id),
                        caller_phone = COALESCE(?, caller_phone),
                        outcome = ?,
                        ended_reason = COALESCE(?, ended_reason),
                        duration_seconds = COALESCE(?, duration_seconds),
                        summary = COALESCE(?, summary),
                        transcript = COALESCE(?, transcript),
                        collected_payload = COALESCE(?, collected_payload)
       WHERE call_id = ?`,
      [
        bind(patientId), bind(callerPhone), outcome, bind(endedReason),
        bind(durationSeconds), bind(summary), bind(transcript), bind(payload), existing.call_id,
      ],
    );
    return existing.call_id;
  }

  const callId = crypto.randomUUID();
  await db.run(
    `INSERT INTO calls (call_id, provider_call_id, patient_id, caller_phone, outcome,
                        ended_reason, duration_seconds, summary, transcript, collected_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      callId, bind(providerCallId), bind(patientId), bind(callerPhone), outcome,
      bind(endedReason), bind(durationSeconds), bind(summary), bind(transcript), bind(payload),
    ],
  );
  return callId;
}

export async function listCalls({ patientId = null, limit = 50 } = {}) {
  const db = await getDb();
  const rows = patientId
    ? await db.all('SELECT * FROM calls WHERE patient_id = ? ORDER BY created_at DESC LIMIT ?', [
        patientId,
        limit,
      ])
    : await db.all('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?', [limit]);

  return rows.map((row) => ({
    ...row,
    collected_payload: row.collected_payload ? JSON.parse(row.collected_payload) : null,
  }));
}

// ---------------------------------------------------------------------------
// Appointments (bonus: mock scheduling)
// ---------------------------------------------------------------------------

export async function createAppointment({ patientId, scheduledFor, reason = null }) {
  const patient = await getPatientById(patientId, { includeDeleted: false });
  if (!patient) throw new NotFoundError(`No patient found with id ${patientId}`);

  const appointmentId = crypto.randomUUID();
  const db = await getDb();
  await db.run(
    'INSERT INTO appointments (appointment_id, patient_id, scheduled_for, reason) VALUES (?, ?, ?, ?)',
    [appointmentId, patientId, scheduledFor, bind(reason)],
  );

  logger.info('appointment created', { appointment_id: appointmentId, patient_id: patientId });
  return db.get('SELECT * FROM appointments WHERE appointment_id = ?', [appointmentId]);
}

export async function listAppointments(patientId) {
  const db = await getDb();
  return db.all('SELECT * FROM appointments WHERE patient_id = ? ORDER BY scheduled_for ASC', [
    patientId,
  ]);
}

/** Counters for the dashboard header. */
export async function getStats() {
  const db = await getDb();
  const [active, deleted, today, calls, appointments] = await Promise.all([
    db.get('SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NULL'),
    db.get('SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NOT NULL'),
    db.get(
      'SELECT COUNT(*) AS n FROM patients WHERE deleted_at IS NULL AND substr(created_at, 1, 10) = ?',
      [new Date().toISOString().slice(0, 10)],
    ),
    db.get('SELECT COUNT(*) AS n FROM calls'),
    db.get("SELECT COUNT(*) AS n FROM appointments WHERE status = 'scheduled'"),
  ]);

  return {
    patients_active: count(active),
    patients_deleted: count(deleted),
    registered_today: count(today),
    calls_logged: count(calls),
    appointments: count(appointments),
  };
}
