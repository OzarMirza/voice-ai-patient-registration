/**
 * Voice agent tools.
 *
 * Each tool has two halves that live side by side on purpose:
 *   - `definition`: the JSON schema handed to the LLM (and uploaded to Vapi)
 *   - `handler`:    the server-side implementation
 *
 * Handlers return plain objects that get JSON-stringified back to the model.
 * Every response carries an `instruction` string — a short, imperative nudge
 * telling the model what to *say* next. This is the cheapest reliable way to
 * keep a voice agent on-script: the guidance arrives at the exact moment it is
 * needed rather than being buried in a long system prompt.
 */
import {
  createPatient,
  createAppointment,
  findPatientsByPhone,
  getPatientById,
  updatePatient,
} from '../domain/patient.service.js';
import {
  createPatientSchema,
  formatZodError,
  updatePatientSchema,
} from '../domain/patient.schema.js';
import { formatPhone, normalizePhone } from '../domain/normalize.js';
import { logger } from '../lib/logger.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "1985-03-05" -> "March 5, 1985" — reads correctly through any TTS engine. */
function spokenDate(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

/** Compose the sentence the agent reads back before saving. */
function buildReadback(p) {
  const parts = [];
  parts.push(`${p.first_name} ${p.last_name}, born ${spokenDate(p.date_of_birth)}`);

  const street = p.address_line_2 ? `${p.address_line_1}, ${p.address_line_2}` : p.address_line_1;
  parts.push(`${street}, ${p.city}, ${p.state} ${p.zip_code}`);
  parts.push(`phone ${formatPhone(p.phone_number)}`);

  if (p.email) parts.push(`email ${p.email}`);
  if (p.insurance_provider) {
    parts.push(
      p.insurance_member_id
        ? `insurance ${p.insurance_provider}, member ID ${p.insurance_member_id}`
        : `insurance ${p.insurance_provider}`,
    );
  }
  if (p.emergency_contact_name) {
    parts.push(
      p.emergency_contact_phone
        ? `emergency contact ${p.emergency_contact_name} at ${formatPhone(p.emergency_contact_phone)}`
        : `emergency contact ${p.emergency_contact_name}`,
    );
  }
  if (p.preferred_language && p.preferred_language !== 'English') {
    parts.push(`preferred language ${p.preferred_language}`);
  }
  if (p.sex) parts.push(`sex recorded as ${p.sex}`);

  return parts.join('. ');
}

const PATIENT_PROPERTIES = {
  first_name: { type: 'string', description: "Patient's legal first name." },
  last_name: { type: 'string', description: "Patient's legal last name." },
  date_of_birth: {
    type: 'string',
    description: 'Date of birth in MM/DD/YYYY format, e.g. 03/05/1985. Must be a real past date.',
  },
  sex: {
    type: 'string',
    enum: ['Male', 'Female', 'Other', 'Decline to Answer'],
    description: 'Sex recorded on the medical chart.',
  },
  phone_number: {
    type: 'string',
    description: '10-digit US phone number. Digits only is fine, e.g. 5551234567.',
  },
  email: { type: 'string', description: 'Email address. Optional.' },
  address_line_1: { type: 'string', description: 'Street address, e.g. 42 Oak Street.' },
  address_line_2: { type: 'string', description: 'Apartment, suite or unit. Optional.' },
  city: { type: 'string', description: 'City name.' },
  state: {
    type: 'string',
    description: 'US state. Two-letter abbreviation or full name — both accepted.',
  },
  zip_code: { type: 'string', description: '5-digit ZIP code, or ZIP+4.' },
  insurance_provider: { type: 'string', description: 'Insurance company name. Optional.' },
  insurance_member_id: { type: 'string', description: 'Insurance member/subscriber ID. Optional.' },
  preferred_language: {
    type: 'string',
    description: 'Preferred spoken language. Defaults to English.',
  },
  emergency_contact_name: { type: 'string', description: 'Emergency contact full name. Optional.' },
  emergency_contact_phone: {
    type: 'string',
    description: '10-digit US phone number for the emergency contact. Optional.',
  },
};

// ---------------------------------------------------------------------------
// lookup_patient
// ---------------------------------------------------------------------------

const lookupPatient = {
  definition: {
    type: 'function',
    function: {
      name: 'lookup_patient',
      description:
        "Check whether a phone number already belongs to a registered patient. Call this at the start of the call using the caller's number, or whenever the caller says they might already be in the system.",
      parameters: {
        type: 'object',
        properties: {
          phone_number: {
            type: 'string',
            description: '10-digit US phone number to search for.',
          },
        },
        required: ['phone_number'],
      },
    },
  },

  async handler({ phone_number: phoneNumber }) {
    const digits = normalizePhone(phoneNumber);
    const matches = await findPatientsByPhone(digits);

    if (matches.length === 0) {
      return {
        found: false,
        instruction:
          'No existing record. Continue registering this caller as a brand new patient. Do not mention that you checked.',
      };
    }

    return {
      found: true,
      matches: matches.map((p) => ({
        patient_id: p.patient_id,
        first_name: p.first_name,
        last_name: p.last_name,
        date_of_birth: spokenDate(p.date_of_birth),
        city: p.city,
        state: p.state,
      })),
      instruction:
        matches.length === 1
          ? `Say: "It looks like we already have a record for ${matches[0].first_name} ${matches[0].last_name}. Would you like to update your information instead?" If they say yes, use update_patient. If it is a different person (for example a family member sharing the phone), register them as new.`
          : `There are ${matches.length} records on this number — likely a household. Ask which family member you are speaking with before continuing.`,
    };
  },
};

// ---------------------------------------------------------------------------
// save_patient (two-phase: dry run, then commit)
// ---------------------------------------------------------------------------

const savePatient = {
  definition: {
    type: 'function',
    function: {
      name: 'save_patient',
      description:
        'Validate and then save a new patient. Call with confirmed=false first to check the data and get the exact values to read back to the caller. After the caller confirms out loud, call again with confirmed=true to actually save. Never call with confirmed=true before the caller has confirmed.',
      parameters: {
        type: 'object',
        properties: {
          ...PATIENT_PROPERTIES,
          confirmed: {
            type: 'boolean',
            description:
              'false = validate only, nothing is saved. true = the caller has verbally confirmed the read-back; write the record.',
          },
        },
        required: [
          'confirmed',
          'first_name',
          'last_name',
          'date_of_birth',
          'sex',
          'phone_number',
          'address_line_1',
          'city',
          'state',
          'zip_code',
        ],
      },
    },
  },

  async handler(args, context = {}) {
    const { confirmed, ...fields } = args ?? {};
    const parsed = createPatientSchema.safeParse(fields);

    if (!parsed.success) {
      const errors = formatZodError(parsed.error);
      logger.warn('save_patient validation failed', {
        call_id: context.callId,
        fields: errors.map((e) => e.field),
      });
      return {
        ok: false,
        status: 'invalid',
        errors,
        instruction: `These fields need fixing: ${errors
          .map((e) => e.message)
          .join(' ')} Re-ask ONLY those items, conversationally, then call save_patient again with confirmed=false. Do not read anything else back yet.`,
      };
    }

    const clean = { ...parsed.data, preferred_language: parsed.data.preferred_language ?? 'English' };

    if (!confirmed) {
      const duplicates = await findPatientsByPhone(clean.phone_number);
      return {
        ok: true,
        status: 'validated',
        saved: false,
        readback: buildReadback(clean),
        possible_duplicate:
          duplicates.length > 0
            ? `${duplicates[0].first_name} ${duplicates[0].last_name} is already registered on this number.`
            : null,
        instruction:
          'Nothing has been saved yet. Read the `readback` text to the caller as natural flowing speech — do not read it as a list and do not mention field names. Then ask "Did I get all of that right?" Only after they confirm, call save_patient again with confirmed=true and the exact same values.',
      };
    }

    try {
      const patient = await createPatient(clean);
      logger.info('patient registered by voice agent', {
        call_id: context.callId,
        patient_id: patient.patient_id,
        // The brief asks for the final collected payload in the logs.
        payload: patient,
      });

      return {
        ok: true,
        status: 'saved',
        saved: true,
        patient_id: patient.patient_id,
        instruction: `The record is saved. Tell the caller "You're all set, ${patient.first_name}." Then offer once to book a first appointment using schedule_appointment. Do not read the information back again.`,
      };
    } catch (err) {
      logger.error('voice save_patient failed', { call_id: context.callId, error: err.message });
      return {
        ok: false,
        status: 'save_failed',
        error: err.message,
        instruction:
          "The record could NOT be saved. Do not tell the caller they are registered. Apologize briefly, say someone from the office will call them right back to finish the registration, and end the call politely.",
      };
    }
  },
};

// ---------------------------------------------------------------------------
// update_patient
// ---------------------------------------------------------------------------

const updatePatientTool = {
  definition: {
    type: 'function',
    function: {
      name: 'update_patient',
      description:
        'Update an existing patient record. Same two-step pattern as save_patient: confirmed=false to validate and get the read-back, confirmed=true to commit. Only include the fields that are actually changing.',
      parameters: {
        type: 'object',
        properties: {
          patient_id: {
            type: 'string',
            description: 'The patient_id returned by lookup_patient.',
          },
          ...PATIENT_PROPERTIES,
          confirmed: {
            type: 'boolean',
            description: 'false = validate only. true = caller confirmed; write the changes.',
          },
        },
        required: ['patient_id', 'confirmed'],
      },
    },
  },

  async handler(args, context = {}) {
    const { patient_id: patientId, confirmed, ...fields } = args ?? {};

    const existing = await getPatientById(patientId, { includeDeleted: false });
    if (!existing) {
      return {
        ok: false,
        status: 'not_found',
        instruction:
          'That record could not be found. Apologize briefly and offer to register them as a new patient instead.',
      };
    }

    const provided = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    );
    if (Object.keys(provided).length === 0) {
      return {
        ok: false,
        status: 'invalid',
        instruction: 'Ask the caller which specific details they would like to change.',
      };
    }

    const parsed = updatePatientSchema.safeParse(provided);
    if (!parsed.success) {
      const errors = formatZodError(parsed.error);
      return {
        ok: false,
        status: 'invalid',
        errors,
        instruction: `These need fixing: ${errors.map((e) => e.message).join(' ')} Re-ask only those items.`,
      };
    }

    const merged = { ...existing, ...parsed.data };

    if (!confirmed) {
      return {
        ok: true,
        status: 'validated',
        saved: false,
        changed_fields: Object.keys(parsed.data),
        readback: buildReadback(merged),
        instruction:
          'Nothing saved yet. Read back only the details that changed, naturally, and ask the caller to confirm. Then call update_patient again with confirmed=true.',
      };
    }

    try {
      const patient = await updatePatient(patientId, parsed.data);
      logger.info('patient updated by voice agent', {
        call_id: context.callId,
        patient_id: patient.patient_id,
        payload: patient,
      });
      return {
        ok: true,
        status: 'saved',
        saved: true,
        patient_id: patient.patient_id,
        instruction: `The update is saved. Tell the caller "You're all set, ${patient.first_name}." then close the call warmly.`,
      };
    } catch (err) {
      logger.error('voice update_patient failed', { call_id: context.callId, error: err.message });
      return {
        ok: false,
        status: 'save_failed',
        error: err.message,
        instruction:
          'The update failed. Do not claim it was saved. Say someone from the office will call them back, then close politely.',
      };
    }
  },
};

// ---------------------------------------------------------------------------
// schedule_appointment (bonus — mock availability)
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Mock scheduler: offers the next weekday at least two days out that matches
 * the caller's stated preference. Real availability would come from the
 * practice management system.
 */
function nextSlot({ dayPreference, timePreference }, from = new Date()) {
  const wanted = WEEKDAY_NAMES.findIndex(
    (d) => d.toLowerCase() === String(dayPreference || '').trim().toLowerCase(),
  );

  const candidate = new Date(from);
  candidate.setDate(candidate.getDate() + 2);

  for (let i = 0; i < 21; i += 1) {
    const dow = candidate.getDay();
    const isWeekday = dow >= 1 && dow <= 5;
    if (isWeekday && (wanted === -1 || dow === wanted)) break;
    candidate.setDate(candidate.getDate() + 1);
  }

  const afternoon = String(timePreference || '').toLowerCase().includes('afternoon');
  candidate.setHours(afternoon ? 14 : 9, afternoon ? 30 : 15, 0, 0);

  const iso = candidate.toISOString();
  const hours = candidate.getHours();
  const spoken = `${WEEKDAY_NAMES[candidate.getDay()]}, ${
    MONTH_NAMES[candidate.getMonth()]
  } ${candidate.getDate()} at ${((hours + 11) % 12) + 1}:${String(candidate.getMinutes()).padStart(2, '0')} ${
    hours >= 12 ? 'PM' : 'AM'
  }`;

  return { iso, spoken };
}

const scheduleAppointment = {
  definition: {
    type: 'function',
    function: {
      name: 'schedule_appointment',
      description:
        'Book a first appointment for a patient who has already been saved. Only call this after save_patient returned status "saved" and the caller said yes to scheduling.',
      parameters: {
        type: 'object',
        properties: {
          patient_id: { type: 'string', description: 'patient_id returned by save_patient.' },
          day_preference: {
            type: 'string',
            description: 'Preferred weekday if the caller named one, e.g. "Tuesday". Optional.',
          },
          time_preference: {
            type: 'string',
            enum: ['morning', 'afternoon'],
            description: 'Whether the caller prefers mornings or afternoons.',
          },
          reason: { type: 'string', description: 'Brief reason for the visit. Optional.' },
        },
        required: ['patient_id'],
      },
    },
  },

  async handler(args, context = {}) {
    const { patient_id: patientId, day_preference, time_preference, reason } = args ?? {};
    const slot = nextSlot({ dayPreference: day_preference, timePreference: time_preference });

    try {
      const appointment = await createAppointment({
        patientId,
        scheduledFor: slot.iso,
        reason: reason ?? 'New patient visit',
      });
      logger.info('appointment booked by voice agent', {
        call_id: context.callId,
        appointment_id: appointment.appointment_id,
      });
      return {
        ok: true,
        status: 'scheduled',
        appointment_id: appointment.appointment_id,
        scheduled_for: slot.spoken,
        instruction: `Tell the caller you have them down for ${slot.spoken}, mention we'll send a reminder, then close the call warmly.`,
      };
    } catch (err) {
      logger.error('voice schedule_appointment failed', { error: err.message });
      return {
        ok: false,
        status: 'failed',
        instruction:
          "Scheduling isn't going through. Reassure the caller that their registration is complete and that the office will call to book the visit. Then close politely.",
      };
    }
  },
};

// ---------------------------------------------------------------------------

export const TOOLS = {
  lookup_patient: lookupPatient,
  save_patient: savePatient,
  update_patient: updatePatientTool,
  schedule_appointment: scheduleAppointment,
};

/** Tool schemas for the Vapi assistant config, each pointed at our webhook. */
export function toolDefinitions(serverUrl, secret = null) {
  return Object.values(TOOLS).map((tool) => ({
    ...tool.definition,
    ...(serverUrl
      ? { server: { url: serverUrl, ...(secret ? { secret } : {}) } }
      : {}),
  }));
}

/** Dispatch a tool call by name. Unknown names fail closed with guidance. */
export async function invokeTool(name, args, context = {}) {
  const tool = TOOLS[name];
  if (!tool) {
    logger.warn('unknown tool requested', { name });
    return {
      ok: false,
      status: 'unknown_tool',
      instruction: 'That action is not available. Continue the conversation without it.',
    };
  }
  return tool.handler(args ?? {}, context);
}

export const __testables = { buildReadback, nextSlot, spokenDate };
