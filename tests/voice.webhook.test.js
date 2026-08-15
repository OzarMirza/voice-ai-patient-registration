/**
 * Voice-layer tests. These drive the real Vapi webhook with the payload shapes
 * Vapi actually sends, so a change that would break a live call fails here.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { call, teardown, toolCall, validPatient } from './helpers.js';

after(teardown);

describe('two-phase save', () => {
  test('dry run validates without writing, then commit persists', async () => {
    const args = {
      first_name: 'maria', last_name: "o'brien", date_of_birth: 'March 5, 1985',
      sex: 'f', phone_number: '(217) 555-0148', address_line_1: '42 Oak Street',
      address_line_2: 'Apt 3B', city: 'Springfield', state: 'Illinois', zip_code: '62704',
      email: 'maria dot obrien at gmail dot com',
    };

    const dry = await toolCall('save_patient', { ...args, confirmed: false });
    assert.equal(dry.result.status, 'validated');
    assert.equal(dry.result.saved, false);
    // The read-back is built from normalized values, so the caller hears
    // exactly what will be stored.
    assert.match(dry.result.readback, /Maria O'Brien/);
    assert.match(dry.result.readback, /March 5, 1985/);
    assert.match(dry.result.readback, /\(217\) 555-0148/);
    assert.match(dry.result.readback, /IL 62704/);

    const beforeCommit = await call('GET', '/patients?last_name=brien');
    assert.equal(beforeCommit.body.data.patients.length, 0, 'dry run must not persist');

    const commit = await toolCall('save_patient', { ...args, confirmed: true });
    assert.equal(commit.result.status, 'saved');
    assert.equal(commit.result.saved, true);

    const stored = await call('GET', `/patients/${commit.result.patient_id}`);
    assert.equal(stored.status, 200);
    assert.equal(stored.body.data.last_name, "O'Brien");
    assert.equal(stored.body.data.state, 'IL');
    assert.equal(stored.body.data.email, 'maria.obrien@gmail.com');
  });

  test('invalid input returns per-field guidance instead of saving', async () => {
    const res = await toolCall('save_patient', {
      ...validPatient({ date_of_birth: '01/01/2099', phone_number: '5551234' }),
      confirmed: true,
    });
    assert.equal(res.result.ok, false);
    assert.equal(res.result.status, 'invalid');

    const fields = res.result.errors.map((e) => e.field);
    assert.ok(fields.includes('date_of_birth'));
    assert.ok(fields.includes('phone_number'));
    // The instruction must tell the model to re-ask only the broken fields.
    assert.match(res.result.instruction, /ONLY those items/);
  });

  test('a save failure never tells the caller they are registered', async () => {
    const res = await toolCall('save_patient', { confirmed: true, first_name: 'X' });
    assert.equal(res.result.ok, false);
    assert.ok(!res.result.saved);
  });
});

describe('duplicate detection', () => {
  test('lookup_patient finds a returning caller by any phone format', async () => {
    await call('POST', '/patients', validPatient({
      first_name: 'Returning', last_name: 'Caller', phone_number: '5035550171',
    }));

    const res = await toolCall('lookup_patient', { phone_number: '+1 (503) 555-0171' });
    assert.equal(res.result.found, true);
    assert.equal(res.result.matches[0].first_name, 'Returning');
    assert.match(res.result.instruction, /update your information instead/);
  });

  test('an unknown number tells the agent to continue silently', async () => {
    const res = await toolCall('lookup_patient', { phone_number: '9995550100' });
    assert.equal(res.result.found, false);
    assert.match(res.result.instruction, /brand new patient/);
  });

  test('the dry run flags a possible duplicate without blocking registration', async () => {
    await call('POST', '/patients', validPatient({
      first_name: 'Household', last_name: 'Head', phone_number: '6175550133',
    }));

    const res = await toolCall('save_patient', {
      ...validPatient({ first_name: 'Second', last_name: 'Member', phone_number: '6175550133' }),
      confirmed: false,
    });
    assert.equal(res.result.status, 'validated');
    assert.match(res.result.possible_duplicate, /Household Head/);
  });
});

describe('update flow', () => {
  test('updates only the fields provided, after a dry run', async () => {
    const created = await call('POST', '/patients', validPatient({ last_name: 'Mover' }));
    const id = created.body.data.patient_id;

    const dry = await toolCall('update_patient', {
      patient_id: id, confirmed: false, address_line_1: '9 Elm Street', city: 'Austin', state: 'TX',
    });
    assert.equal(dry.result.saved, false);
    assert.deepEqual(dry.result.changed_fields.sort(), ['address_line_1', 'city', 'state']);

    const commit = await toolCall('update_patient', {
      patient_id: id, confirmed: true, address_line_1: '9 Elm Street', city: 'Austin', state: 'TX',
    });
    assert.equal(commit.result.status, 'saved');

    const after = await call('GET', `/patients/${id}`);
    assert.equal(after.body.data.city, 'Austin');
    assert.equal(after.body.data.last_name, 'Mover', 'untouched fields are preserved');
  });

  test('an unknown patient_id degrades gracefully', async () => {
    const res = await toolCall('update_patient', {
      patient_id: '00000000-0000-4000-8000-000000000000', confirmed: true, city: 'Nowhere',
    });
    assert.equal(res.result.status, 'not_found');
    assert.match(res.result.instruction, /register them as a new patient/);
  });
});

describe('appointments', () => {
  test('books a slot for a saved patient', async () => {
    const created = await call('POST', '/patients', validPatient({ last_name: 'Booker' }));
    const res = await toolCall('schedule_appointment', {
      patient_id: created.body.data.patient_id, time_preference: 'morning', reason: 'New patient visit',
    });
    assert.equal(res.result.status, 'scheduled');
    assert.ok(res.result.scheduled_for);

    const list = await call('GET', `/patients/${created.body.data.patient_id}/appointments`);
    assert.equal(list.body.data.appointments.length, 1);
  });
});

describe('webhook robustness', () => {
  test('accepts the legacy function-call payload shape', async () => {
    const res = await call('POST', '/vapi/webhook', {
      message: {
        type: 'function-call',
        call: { id: 'legacy-1' },
        functionCall: { name: 'lookup_patient', parameters: { phone_number: '9995550100' } },
      },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.result, 'legacy shape expects a bare `result`');
  });

  test('accepts arguments delivered as a JSON string', async () => {
    const res = await call('POST', '/vapi/webhook', {
      message: {
        type: 'tool-calls',
        call: { id: 'str-args' },
        toolCallList: [{
          id: 'tc', name: 'lookup_patient',
          arguments: JSON.stringify({ phone_number: '9995550100' }),
        }],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body.results[0].result).found, false);
  });

  test('an unknown tool name does not crash the call', async () => {
    const res = await toolCall('does_not_exist', {});
    assert.equal(res.status, 200);
    assert.equal(res.result.status, 'unknown_tool');
  });

  test('unrecognized message types are acknowledged with 200', async () => {
    const res = await call('POST', '/vapi/webhook', { message: { type: 'speech-update' } });
    assert.equal(res.status, 200);
  });

  test('assistant-request returns a fully-formed inline assistant', async () => {
    const res = await call('POST', '/vapi/webhook', {
      message: { type: 'assistant-request', call: { id: 'ar-1', customer: { number: '+19995550100' } } },
    });
    assert.equal(res.status, 200);
    const { assistant } = res.body;
    assert.ok(assistant.firstMessage);
    assert.ok(assistant.model.messages[0].content.includes('Avery'));
    assert.equal(assistant.model.tools.length, 4);
    assert.deepEqual(
      assistant.model.tools.map((t) => t.function.name).sort(),
      ['lookup_patient', 'save_patient', 'schedule_appointment', 'update_patient'],
    );
  });

  test('end-of-call-report archives the transcript against the patient', async () => {
    const callId = 'transcript-call';
    const saved = await toolCall(
      'save_patient',
      { ...validPatient({ last_name: 'Transcribed', phone_number: '7025550155' }), confirmed: true },
      callId,
    );

    const report = await call('POST', '/vapi/webhook', {
      message: {
        type: 'end-of-call-report',
        endedReason: 'customer-ended-call',
        call: { id: callId, customer: { number: '+17025550155' } },
        artifact: { transcript: 'AI: Thanks for calling.\nUser: Hi, I need to register.' },
        analysis: { summary: 'Caller registered successfully.' },
      },
    });
    assert.equal(report.status, 200);

    const calls = await call('GET', `/patients/${saved.result.patient_id}/calls`);
    assert.equal(calls.body.data.calls.length, 1);
    assert.equal(calls.body.data.calls[0].outcome, 'registered');
    assert.match(calls.body.data.calls[0].transcript, /I need to register/);
    assert.equal(calls.body.data.calls[0].summary, 'Caller registered successfully.');
  });
});
