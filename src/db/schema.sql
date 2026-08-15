-- ---------------------------------------------------------------------------
-- Patient registration schema
--
-- Constraints are duplicated here deliberately. The Zod layer gives the caller
-- (and the voice agent) friendly, field-specific error messages; these CHECK
-- constraints are the backstop that guarantees nothing malformed reaches disk
-- even if a future code path skips validation.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS patients (
  patient_id              TEXT PRIMARY KEY,

  -- Required demographics -------------------------------------------------
  first_name              TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 50),
  last_name               TEXT NOT NULL CHECK (length(last_name)  BETWEEN 1 AND 50),

  -- Stored ISO-8601 (YYYY-MM-DD) so string ordering equals chronological
  -- ordering. The API accepts MM/DD/YYYY on input and converts.
  date_of_birth           TEXT NOT NULL
                          CHECK (date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  sex                     TEXT NOT NULL
                          CHECK (sex IN ('Male', 'Female', 'Other', 'Decline to Answer')),

  -- Normalized to bare 10 digits (no +1, no punctuation) so lookups by caller
  -- ID always match. NANP rules: area code and exchange cannot start with 0/1.
  phone_number            TEXT NOT NULL
                          CHECK (phone_number GLOB '[2-9][0-9][0-9][2-9][0-9][0-9][0-9][0-9][0-9][0-9]'),

  address_line_1          TEXT NOT NULL CHECK (length(address_line_1) BETWEEN 1 AND 200),
  city                    TEXT NOT NULL CHECK (length(city) BETWEEN 1 AND 100),
  state                   TEXT NOT NULL CHECK (state GLOB '[A-Z][A-Z]'),
  zip_code                TEXT NOT NULL
                          CHECK (zip_code GLOB '[0-9][0-9][0-9][0-9][0-9]'
                              OR zip_code GLOB '[0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'),

  -- Optional demographics -------------------------------------------------
  email                   TEXT CHECK (email IS NULL OR email LIKE '%_@_%.__%'),
  address_line_2          TEXT CHECK (address_line_2 IS NULL OR length(address_line_2) <= 100),
  insurance_provider      TEXT CHECK (insurance_provider IS NULL OR length(insurance_provider) <= 100),
  insurance_member_id     TEXT CHECK (insurance_member_id IS NULL OR length(insurance_member_id) <= 50),
  preferred_language      TEXT NOT NULL DEFAULT 'English',
  emergency_contact_name  TEXT CHECK (emergency_contact_name IS NULL OR length(emergency_contact_name) <= 100),
  emergency_contact_phone TEXT
                          CHECK (emergency_contact_phone IS NULL
                              OR emergency_contact_phone GLOB '[2-9][0-9][0-9][2-9][0-9][0-9][0-9][0-9][0-9][0-9]'),

  -- Lifecycle -------------------------------------------------------------
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Soft delete: DELETE /patients/:id sets this; rows are never removed.
  deleted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_patients_last_name  ON patients (last_name);
CREATE INDEX IF NOT EXISTS idx_patients_dob        ON patients (date_of_birth);
CREATE INDEX IF NOT EXISTS idx_patients_phone      ON patients (phone_number);
CREATE INDEX IF NOT EXISTS idx_patients_active     ON patients (deleted_at);

-- ---------------------------------------------------------------------------
-- Call transcripts (bonus): every completed call is archived and, when the
-- call produced a registration, linked to the resulting patient record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calls (
  call_id           TEXT PRIMARY KEY,
  provider_call_id  TEXT UNIQUE,
  patient_id        TEXT REFERENCES patients (patient_id) ON DELETE SET NULL,
  caller_phone      TEXT,
  outcome           TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (outcome IN ('registered', 'updated', 'abandoned', 'unknown')),
  ended_reason      TEXT,
  duration_seconds  INTEGER,
  summary           TEXT,
  transcript        TEXT,
  collected_payload TEXT, -- JSON snapshot of what the agent gathered
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_patient ON calls (patient_id);

-- ---------------------------------------------------------------------------
-- Appointments (bonus): mock scheduling offered after a successful signup.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
  appointment_id TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL REFERENCES patients (patient_id) ON DELETE CASCADE,
  scheduled_for  TEXT NOT NULL,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments (patient_id);
