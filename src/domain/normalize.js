/**
 * Input normalizers.
 *
 * These exist because the primary client is a *speech* pipeline. A transcript
 * says "five five five, one two three, four five six seven", "California",
 * "j smith at gmail dot com" — all correct answers that a naive validator
 * would reject. Normalizing before validating is what keeps the agent from
 * badgering a caller who already gave a perfectly good answer.
 *
 * Everything here is pure and unit-tested; the REST API runs the same
 * normalizers, so a curl request and a phone call produce identical records.
 */

export const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  // Territories and military mail — real ZIP/state combinations for US patients.
  AS: 'American Samoa', GU: 'Guam', MP: 'Northern Mariana Islands',
  PR: 'Puerto Rico', VI: 'U.S. Virgin Islands',
  AA: 'Armed Forces Americas', AE: 'Armed Forces Europe', AP: 'Armed Forces Pacific',
};

const STATE_BY_NAME = Object.fromEntries(
  Object.entries(US_STATES).map(([abbr, name]) => [name.toLowerCase(), abbr]),
);

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export const SEX_VALUES = ['Male', 'Female', 'Other', 'Decline to Answer'];

const SEX_ALIASES = new Map([
  ['m', 'Male'], ['male', 'Male'], ['man', 'Male'], ['boy', 'Male'], ['masculino', 'Male'],
  ['f', 'Female'], ['female', 'Female'], ['woman', 'Female'], ['girl', 'Female'], ['femenino', 'Female'],
  ['o', 'Other'], ['other', 'Other'], ['non-binary', 'Other'], ['nonbinary', 'Other'],
  ['nb', 'Other'], ['x', 'Other'], ['intersex', 'Other'],
  ['decline', 'Decline to Answer'], ['decline to answer', 'Decline to Answer'],
  ['declined', 'Decline to Answer'], ['prefer not to say', 'Decline to Answer'],
  ['prefer not to answer', 'Decline to Answer'], ['unknown', 'Decline to Answer'],
  ['n/a', 'Decline to Answer'], ['skip', 'Decline to Answer'],
]);

/** Trim, collapse runs of whitespace, and coerce empty-ish input to null. */
export function cleanString(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Speech-to-text sometimes yields these when a caller declines a field.
  if (['n/a', 'na', 'none', 'null', 'undefined', 'skip'].includes(s.toLowerCase())) return null;
  return s;
}

/**
 * Names arrive from a transcript, so casing is unreliable. If a token is
 * entirely lowercase we title-case it; anything with existing capitals is left
 * alone so "McDonald", "DeLuca" and "O'Brien" survive intact.
 */
export function normalizeName(value) {
  const s = cleanString(value);
  if (!s) return null;
  return s
    .split(' ')
    .map((token) =>
      token === token.toLowerCase()
        ? token.replace(/(^|[-'])([a-zà-ÿ])/g, (_, sep, ch) => sep + ch.toUpperCase())
        : token,
    )
    .join(' ');
}

/**
 * Reduce a US phone number to bare 10 digits.
 * Accepts "+1 (555) 123-4567", "555.123.4567", "15551234567", and the
 * digit-run a transcript produces when the caller reads it aloud.
 */
export function normalizePhone(value) {
  const s = cleanString(value);
  if (!s) return null;
  let digits = s.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

export function isValidUsPhone(digits) {
  // NANP: 10 digits, area code and exchange code both start 2-9.
  return typeof digits === 'string' && /^[2-9]\d{2}[2-9]\d{6}$/.test(digits);
}

export function formatPhone(digits) {
  if (!isValidUsPhone(digits)) return digits ?? null;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** Convert 10 normalized digits to the E.164 form telephony providers expect. */
export function toE164(digits) {
  return isValidUsPhone(digits) ? `+1${digits}` : null;
}

/**
 * Parse a date of birth into ISO `YYYY-MM-DD`.
 * Handles MM/DD/YYYY (the format the agent is prompted to emit), ISO, and
 * spoken forms like "March 5, 1985" that occasionally slip through.
 * Returns null if the input is not a real calendar date.
 */
export function normalizeDob(value) {
  const s = cleanString(value);
  if (!s) return null;

  let year;
  let month;
  let day;
  let m;

  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    [, year, month, day] = m;
  } else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    // US convention: month first.
    [, month, day, year] = m;
  } else if ((m = s.match(/^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) {
    month = MONTHS.findIndex((name) => name.startsWith(m[1].toLowerCase().slice(0, 3))) + 1;
    [, , day, year] = m;
  } else if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/))) {
    month = MONTHS.findIndex((name) => name.startsWith(m[2].toLowerCase().slice(0, 3))) + 1;
    [, day, , year] = m;
  } else {
    return null;
  }

  year = Number(year);
  month = Number(month);
  day = Number(day);
  if (!month || !day || !year) return null;

  // Round-trip through Date to reject impossible dates like 02/30/1990.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Format an ISO date back to MM/DD/YYYY for reading aloud or display. */
export function formatDobUs(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

export function ageFromDob(iso, now = new Date()) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const beforeBirthday =
    now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

export function normalizeSex(value) {
  const s = cleanString(value);
  if (!s) return null;
  const key = s.toLowerCase().replace(/[.]/g, '');
  if (SEX_ALIASES.has(key)) return SEX_ALIASES.get(key);
  const exact = SEX_VALUES.find((v) => v.toLowerCase() === key);
  return exact ?? s; // pass through so validation reports the bad value verbatim
}

/** "California" -> "CA"; "ca" -> "CA". */
export function normalizeState(value) {
  const s = cleanString(value);
  if (!s) return null;
  const upper = s.toUpperCase();
  if (US_STATES[upper]) return upper;
  const byName = STATE_BY_NAME[s.toLowerCase()];
  return byName ?? upper;
}

/** 5-digit or ZIP+4. Tolerates "12345 6789" and "123456789" from speech. */
export function normalizeZip(value) {
  const s = cleanString(value);
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return s;
}

/**
 * Email from speech: callers say "at" and "dot", and STT inserts spaces
 * around them. Reconstruct before validating.
 */
export function normalizeEmail(value) {
  const s = cleanString(value);
  if (!s) return null;
  return s
    .toLowerCase()
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+dash\s+|\s+hyphen\s+/g, '-')
    .replace(/\s+/g, '')
    .replace(/\.$/, '');
}

export function isValidEmail(value) {
  // Deliberately permissive: rejecting an address the caller can actually
  // receive mail at is worse than accepting an odd-looking one.
  return typeof value === 'string' && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value);
}

const LANGUAGE_ALIASES = new Map([
  ['en', 'English'], ['english', 'English'], ['ingles', 'English'],
  ['es', 'Spanish'], ['spanish', 'Spanish'], ['espanol', 'Spanish'], ['español', 'Spanish'],
  ['fr', 'French'], ['french', 'French'],
  ['zh', 'Chinese'], ['chinese', 'Chinese'], ['mandarin', 'Mandarin'], ['cantonese', 'Cantonese'],
  ['vi', 'Vietnamese'], ['vietnamese', 'Vietnamese'],
  ['tl', 'Tagalog'], ['tagalog', 'Tagalog'], ['filipino', 'Tagalog'],
  ['ar', 'Arabic'], ['arabic', 'Arabic'],
  ['ko', 'Korean'], ['korean', 'Korean'],
  ['ru', 'Russian'], ['russian', 'Russian'],
  ['pt', 'Portuguese'], ['portuguese', 'Portuguese'],
  ['hi', 'Hindi'], ['hindi', 'Hindi'], ['ur', 'Urdu'], ['urdu', 'Urdu'],
]);

export function normalizeLanguage(value) {
  const s = cleanString(value);
  if (!s) return null;
  const key = s.toLowerCase();
  if (LANGUAGE_ALIASES.has(key)) return LANGUAGE_ALIASES.get(key);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
