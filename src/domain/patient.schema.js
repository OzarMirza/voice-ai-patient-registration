/**
 * Patient validation.
 *
 * One schema serves both the REST API and the voice agent's tool calls, so a
 * record created by curl is indistinguishable from one created by phone. Error
 * messages are written to be *spoken aloud* — the agent reads them back to the
 * caller verbatim when a field fails, which is why they name the field and say
 * what a good answer looks like instead of emitting a validator code.
 */
import { z } from 'zod';
import {
  US_STATES,
  SEX_VALUES,
  ageFromDob,
  cleanString,
  formatDobUs,
  formatPhone,
  isValidEmail,
  isValidUsPhone,
  normalizeDob,
  normalizeEmail,
  normalizeLanguage,
  normalizeName,
  normalizePhone,
  normalizeSex,
  normalizeState,
  normalizeZip,
} from './normalize.js';

// Letters (incl. accented), spaces, hyphens, apostrophes, periods.
// The brief says "alphabetic + hyphens/apostrophes"; spaces and periods are
// allowed too because "Mary Ann" and "Jr." are ordinary US patient names and
// rejecting them would be a validation bug, not strictness.
const NAME_RE = /^[\p{L}][\p{L}\s'’.-]*$/u;

const MAX_AGE_YEARS = 120;

const requiredMsg = (label) => ({
  required_error: `${label} is required`,
  invalid_type_error: `${label} is required`,
});

const nameField = (label) =>
  z.preprocess(
    normalizeName,
    z
      .string(requiredMsg(label))
      .min(1, `${label} is required`)
      .max(50, `${label} must be 50 characters or fewer`)
      .regex(NAME_RE, `${label} may only contain letters, spaces, hyphens and apostrophes`),
  );

const optionalText = (label, max) =>
  z.preprocess(
    cleanString,
    z
      .string()
      .max(max, `${label} must be ${max} characters or fewer`)
      .nullish(),
  );

const dateOfBirthField = z
  .preprocess(
    normalizeDob,
    z.string({
      required_error: 'Date of birth is required',
      invalid_type_error: 'Date of birth must be a real calendar date in MM/DD/YYYY format',
    }),
  )
  .refine((iso) => iso <= new Date().toISOString().slice(0, 10), {
    message: 'Date of birth cannot be in the future',
  })
  .refine((iso) => (ageFromDob(iso) ?? 0) <= MAX_AGE_YEARS, {
    message: `Date of birth implies an age over ${MAX_AGE_YEARS} years — please re-check the year`,
  });

const phoneField = (label) =>
  z.preprocess(
    normalizePhone,
    z
      .string(requiredMsg(label))
      .refine(isValidUsPhone, `${label} must be a valid 10-digit US phone number`),
  );

const optionalPhoneField = (label) =>
  z.preprocess(
    normalizePhone,
    z
      .string()
      .refine(isValidUsPhone, `${label} must be a valid 10-digit US phone number`)
      .nullish(),
  );

const shape = {
  // --- Required ------------------------------------------------------------
  first_name: nameField('First name'),
  last_name: nameField('Last name'),
  date_of_birth: dateOfBirthField,
  sex: z.preprocess(
    normalizeSex,
    z.enum(SEX_VALUES, {
      ...requiredMsg('Sex'),
      invalid_type_error: 'Sex is required',
      message: `Sex must be one of: ${SEX_VALUES.join(', ')}`,
    }),
  ),
  phone_number: phoneField('Phone number'),
  address_line_1: z.preprocess(
    cleanString,
    z
      .string(requiredMsg('Street address'))
      .min(1, 'Street address is required')
      .max(200, 'Street address must be 200 characters or fewer'),
  ),
  city: z.preprocess(
    cleanString,
    z
      .string(requiredMsg('City'))
      .min(1, 'City is required')
      .max(100, 'City must be 100 characters or fewer'),
  ),
  state: z.preprocess(
    normalizeState,
    z
      .string(requiredMsg('State'))
      .refine((v) => Object.hasOwn(US_STATES, v), 'State must be a valid 2-letter US state abbreviation'),
  ),
  zip_code: z.preprocess(
    normalizeZip,
    z
      .string(requiredMsg('ZIP code'))
      .regex(/^\d{5}(-\d{4})?$/, 'ZIP code must be 5 digits, or ZIP+4 (12345-6789)'),
  ),

  // --- Optional ------------------------------------------------------------
  email: z.preprocess(
    normalizeEmail,
    z.string().refine(isValidEmail, 'Email must look like name@example.com').nullish(),
  ),
  address_line_2: optionalText('Apartment/suite', 100),
  insurance_provider: optionalText('Insurance provider', 100),
  insurance_member_id: z.preprocess(
    (v) => {
      const s = cleanString(v);
      // Member IDs are read aloud character by character; strip the spaces STT
      // leaves between them, but keep internal hyphens.
      return s ? s.replace(/\s+/g, '').toUpperCase() : s;
    },
    z
      .string()
      .max(50, 'Insurance member ID must be 50 characters or fewer')
      .regex(/^[A-Z0-9-]+$/, 'Insurance member ID may only contain letters, numbers and hyphens')
      .nullish(),
  ),
  preferred_language: z.preprocess(
    normalizeLanguage,
    z.string().max(50, 'Preferred language must be 50 characters or fewer').nullish(),
  ),
  emergency_contact_name: z.preprocess(
    normalizeName,
    z
      .string()
      .max(100, 'Emergency contact name must be 100 characters or fewer')
      .regex(NAME_RE, 'Emergency contact name may only contain letters, spaces, hyphens and apostrophes')
      .nullish(),
  ),
  emergency_contact_phone: optionalPhoneField('Emergency contact phone'),
};

/** Unknown keys are stripped rather than rejected — basic input sanitization. */
export const createPatientSchema = z.object(shape);

/**
 * Partial update. `.partial()` wraps each field in ZodOptional, which
 * short-circuits on `undefined` — so an absent key means "leave unchanged"
 * while an explicit `null` on an optional field means "clear it".
 */
export const updatePatientSchema = z
  .object(shape)
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });

export const listQuerySchema = z.object({
  last_name: z.preprocess(cleanString, z.string().max(50).nullish()),
  date_of_birth: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? null : (normalizeDob(v) ?? '__invalid__')),
    z.string().nullish(),
  ),
  phone_number: z.preprocess(
    (v) => (v === undefined || v === null || v === '' ? null : normalizePhone(v)),
    z.string().nullish(),
  ),
  include_deleted: z.preprocess(
    (v) => ['1', 'true', 'yes'].includes(String(v).toLowerCase()),
    z.boolean(),
  ),
  limit: z.preprocess(
    (v) => (v === undefined || v === '' ? 100 : Number(v)),
    z.number().int().min(1).max(500),
  ),
  offset: z.preprocess((v) => (v === undefined || v === '' ? 0 : Number(v)), z.number().int().min(0)),
});

/** Flatten a ZodError into `[{ field, message }]` for the API error envelope. */
export function formatZodError(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '_root',
    message: issue.message,
  }));
}

/** The fields the voice agent must collect before it may save a record. */
export const REQUIRED_FIELDS = [
  'first_name',
  'last_name',
  'date_of_birth',
  'sex',
  'phone_number',
  'address_line_1',
  'city',
  'state',
  'zip_code',
];

export const OPTIONAL_FIELDS = [
  'email',
  'address_line_2',
  'insurance_provider',
  'insurance_member_id',
  'preferred_language',
  'emergency_contact_name',
  'emergency_contact_phone',
];

/**
 * Shape a DB row for API output: add the derived, human-friendly fields that
 * both the dashboard and the agent's read-back step want, without storing
 * anything redundant.
 */
export function serializePatient(row) {
  if (!row) return null;
  return {
    patient_id: row.patient_id,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: `${row.first_name} ${row.last_name}`,
    date_of_birth: row.date_of_birth,
    date_of_birth_us: formatDobUs(row.date_of_birth),
    age: ageFromDob(row.date_of_birth),
    sex: row.sex,
    phone_number: row.phone_number,
    phone_number_formatted: formatPhone(row.phone_number),
    email: row.email ?? null,
    address_line_1: row.address_line_1,
    address_line_2: row.address_line_2 ?? null,
    city: row.city,
    state: row.state,
    zip_code: row.zip_code,
    insurance_provider: row.insurance_provider ?? null,
    insurance_member_id: row.insurance_member_id ?? null,
    preferred_language: row.preferred_language,
    emergency_contact_name: row.emergency_contact_name ?? null,
    emergency_contact_phone: row.emergency_contact_phone ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at ?? null,
  };
}
