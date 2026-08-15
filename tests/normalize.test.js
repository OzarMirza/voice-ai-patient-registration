/**
 * Unit tests for the speech-oriented normalizers. These are the cases that
 * actually show up in transcripts, which is why they are pinned here.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ageFromDob,
  formatPhone,
  isValidUsPhone,
  normalizeDob,
  normalizeEmail,
  normalizeLanguage,
  normalizeName,
  normalizePhone,
  normalizeSex,
  normalizeState,
  normalizeZip,
} from '../src/domain/normalize.js';

describe('phone numbers', () => {
  test('reduces every spoken/written form to 10 digits', () => {
    for (const input of [
      '+1 (212) 555-0142', '212-555-0142', '212.555.0142', '2125550142',
      '12125550142', ' (212) 555 0142 ',
    ]) {
      assert.equal(normalizePhone(input), '2125550142', `failed on ${input}`);
    }
  });

  test('enforces NANP rules', () => {
    assert.ok(isValidUsPhone('2125550142'));
    assert.ok(!isValidUsPhone('1125550142'), 'area code cannot start with 1');
    assert.ok(!isValidUsPhone('2121550142'), 'exchange cannot start with 1');
    assert.ok(!isValidUsPhone('212555014'), 'nine digits is not enough');
  });

  test('formats for read-back', () => {
    assert.equal(formatPhone('2125550142'), '(212) 555-0142');
  });
});

describe('dates of birth', () => {
  test('accepts the formats an agent or an API client will send', () => {
    assert.equal(normalizeDob('03/05/1985'), '1985-03-05');
    assert.equal(normalizeDob('3/5/1985'), '1985-03-05');
    assert.equal(normalizeDob('1985-03-05'), '1985-03-05');
    assert.equal(normalizeDob('March 5, 1985'), '1985-03-05');
    assert.equal(normalizeDob('5 March 1985'), '1985-03-05');
    assert.equal(normalizeDob('Mar 5 1985'), '1985-03-05');
  });

  test('rejects dates that do not exist', () => {
    assert.equal(normalizeDob('02/30/1990'), null);
    assert.equal(normalizeDob('13/01/1990'), null);
    assert.equal(normalizeDob('gibberish'), null);
    assert.equal(normalizeDob(''), null);
  });

  test('handles leap days correctly', () => {
    assert.equal(normalizeDob('02/29/2000'), '2000-02-29', '2000 was a leap year');
    assert.equal(normalizeDob('02/29/1900'), null, '1900 was not');
  });

  test('computes age across a birthday boundary', () => {
    assert.equal(ageFromDob('1985-03-05', new Date('2026-03-04T12:00:00Z')), 40);
    assert.equal(ageFromDob('1985-03-05', new Date('2026-03-05T12:00:00Z')), 41);
  });
});

describe('names', () => {
  test('title-cases lowercase transcripts but preserves deliberate casing', () => {
    assert.equal(normalizeName('maria'), 'Maria');
    assert.equal(normalizeName("o'brien"), "O'Brien");
    assert.equal(normalizeName('mary-anne'), 'Mary-Anne');
    assert.equal(normalizeName('McDonald'), 'McDonald');
    assert.equal(normalizeName('DeLuca'), 'DeLuca');
    assert.equal(normalizeName('  jane   doe  '), 'Jane Doe');
  });
});

describe('states, ZIPs, sex, language', () => {
  test('accepts full state names and abbreviations', () => {
    assert.equal(normalizeState('California'), 'CA');
    assert.equal(normalizeState('california'), 'CA');
    assert.equal(normalizeState('ca'), 'CA');
    assert.equal(normalizeState('New Hampshire'), 'NH');
    assert.equal(normalizeState('Puerto Rico'), 'PR');
  });

  test('normalizes ZIP and ZIP+4', () => {
    assert.equal(normalizeZip('10024'), '10024');
    assert.equal(normalizeZip('941101234'), '94110-1234');
    assert.equal(normalizeZip('94110-1234'), '94110-1234');
  });

  test('maps the many ways a caller states their sex', () => {
    assert.equal(normalizeSex('m'), 'Male');
    assert.equal(normalizeSex('FEMALE'), 'Female');
    assert.equal(normalizeSex('non-binary'), 'Other');
    assert.equal(normalizeSex('prefer not to say'), 'Decline to Answer');
  });

  test('recognizes languages by name and code', () => {
    assert.equal(normalizeLanguage('español'), 'Spanish');
    assert.equal(normalizeLanguage('es'), 'Spanish');
    assert.equal(normalizeLanguage('english'), 'English');
  });
});

describe('emails from speech', () => {
  test('reconstructs spoken addresses', () => {
    assert.equal(normalizeEmail('jane dot doe at gmail dot com'), 'jane.doe@gmail.com');
    assert.equal(normalizeEmail('J.Doe@Example.COM'), 'j.doe@example.com');
    assert.equal(normalizeEmail('jane underscore doe at mail dot co dot uk'), 'jane_doe@mail.co.uk');
  });
});
