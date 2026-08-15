import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { call, teardown, validPatient } from './helpers.js';

after(teardown);

describe('REST API — response contract', () => {
  test('every response uses the { data, error } envelope', async () => {
    const ok = await call('GET', '/patients');
    assert.equal(ok.status, 200);
    assert.ok('data' in ok.body && 'error' in ok.body);
    assert.equal(ok.body.error, null);

    const missing = await call('GET', '/patients/00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.data, null);
    assert.equal(missing.body.error.code, 'not_found');
  });

  test('unknown routes return a 404 envelope, not an HTML error page', async () => {
    const res = await call('GET', '/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  test('malformed JSON returns 400, not 500', async () => {
    const res = await fetch(`${(await import('./helpers.js')).baseUrl}/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'invalid_json');
  });
});

describe('REST API — CRUD lifecycle', () => {
  test('create → read → update → soft delete', async () => {
    const created = await call('POST', '/patients', validPatient({ last_name: 'Lifecycle' }));
    assert.equal(created.status, 201);
    const id = created.body.data.patient_id;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(created.body.data.date_of_birth, '1986-04-12');
    assert.equal(created.body.data.preferred_language, 'English', 'defaults applied');
    assert.equal(created.body.data.deleted_at, null);

    const fetched = await call('GET', `/patients/${id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.data.full_name, 'Jane Lifecycle');

    const updated = await call('PUT', `/patients/${id}`, { city: 'Brooklyn' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.city, 'Brooklyn');
    assert.equal(updated.body.data.last_name, 'Lifecycle', 'partial update leaves other fields alone');
    assert.notEqual(updated.body.data.updated_at, updated.body.data.created_at);

    const deleted = await call('DELETE', `/patients/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.data.soft_deleted, true);

    // Soft delete: the row still exists, it is just filtered out of listings.
    const afterDelete = await call('GET', `/patients/${id}`);
    assert.equal(afterDelete.status, 200);
    assert.ok(afterDelete.body.data.deleted_at);

    const list = await call('GET', '/patients?last_name=Lifecycle');
    assert.equal(list.body.data.patients.length, 0);

    const withDeleted = await call('GET', '/patients?last_name=Lifecycle&include_deleted=true');
    assert.equal(withDeleted.body.data.patients.length, 1);
  });

  test('updating a deleted patient is rejected', async () => {
    const created = await call('POST', '/patients', validPatient({ last_name: 'Gone' }));
    const id = created.body.data.patient_id;
    await call('DELETE', `/patients/${id}`);

    const res = await call('PUT', `/patients/${id}`, { city: 'Nowhere' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'record_deleted');
  });

  test('deleting twice is idempotent', async () => {
    const created = await call('POST', '/patients', validPatient({ last_name: 'Twice' }));
    const id = created.body.data.patient_id;
    assert.equal((await call('DELETE', `/patients/${id}`)).status, 200);
    assert.equal((await call('DELETE', `/patients/${id}`)).status, 200);
  });

  test('a malformed UUID is a 400, an unknown UUID is a 404', async () => {
    assert.equal((await call('GET', '/patients/not-a-uuid')).status, 400);
    assert.equal((await call('GET', '/patients/00000000-0000-4000-8000-00000000ffff')).status, 404);
  });

  test('/api/patients is an alias for /patients', async () => {
    const res = await call('GET', '/api/patients');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data.patients));
  });
});

describe('REST API — filtering', () => {
  test('filters by last_name, date_of_birth and phone_number', async () => {
    await call('POST', '/patients', validPatient({
      first_name: 'Filter', last_name: 'Target', phone_number: '4155550188', date_of_birth: '01/02/1990',
    }));

    const byName = await call('GET', '/patients?last_name=Target');
    assert.equal(byName.body.data.patients.length, 1);

    // Accepts either input format and normalizes before matching.
    const byDob = await call('GET', '/patients?date_of_birth=01/02/1990');
    assert.ok(byDob.body.data.patients.some((p) => p.last_name === 'Target'));
    const byDobIso = await call('GET', '/patients?date_of_birth=1990-01-02');
    assert.ok(byDobIso.body.data.patients.some((p) => p.last_name === 'Target'));

    // Caller-ID formatting must still match the stored digits.
    const byPhone = await call('GET', '/patients?phone_number=%2B1%20(415)%20555-0188');
    assert.equal(byPhone.body.data.patients.length, 1);
    assert.equal(byPhone.body.data.patients[0].last_name, 'Target');
  });

  test('an unparseable date filter is a 422, not silently empty results', async () => {
    const res = await call('GET', '/patients?date_of_birth=whenever');
    assert.equal(res.status, 422);
  });

  test('pagination metadata is returned', async () => {
    const res = await call('GET', '/patients?limit=1');
    assert.equal(res.body.data.patients.length, 1);
    assert.ok(res.body.data.pagination.total >= 1);
    assert.equal(res.body.data.pagination.limit, 1);
  });
});

describe('REST API — server-side validation', () => {
  test('rejects a future date of birth with a field-specific message', async () => {
    const res = await call('POST', '/patients', validPatient({ date_of_birth: '01/01/2099' }));
    assert.equal(res.status, 422);
    const issue = res.body.error.details.find((d) => d.field === 'date_of_birth');
    assert.match(issue.message, /future/i);
  });

  test('rejects an impossible calendar date', async () => {
    const res = await call('POST', '/patients', validPatient({ date_of_birth: '02/30/1990' }));
    assert.equal(res.status, 422);
  });

  test('rejects a short phone number', async () => {
    const res = await call('POST', '/patients', validPatient({ phone_number: '555-1234' }));
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d) => d.field === 'phone_number'));
  });

  test('rejects a non-US state and a bad ZIP', async () => {
    const res = await call('POST', '/patients', validPatient({ state: 'ZZ', zip_code: '123' }));
    assert.equal(res.status, 422);
    const fields = res.body.error.details.map((d) => d.field);
    assert.ok(fields.includes('state'));
    assert.ok(fields.includes('zip_code'));
  });

  test('reports every missing required field at once', async () => {
    const res = await call('POST', '/patients', { first_name: 'Only' });
    assert.equal(res.status, 422);
    const fields = res.body.error.details.map((d) => d.field);
    for (const required of ['last_name', 'date_of_birth', 'sex', 'phone_number', 'city', 'state', 'zip_code']) {
      assert.ok(fields.includes(required), `expected ${required} to be reported`);
    }
  });

  test('does not trust the client for validation — server normalizes independently', async () => {
    const res = await call('POST', '/patients', validPatient({
      state: 'california', sex: 'f', phone_number: '+1 (415) 555-0143', zip_code: '941101234',
      email: 'MixedCase@Example.COM ',
    }));
    assert.equal(res.status, 201);
    assert.equal(res.body.data.state, 'CA');
    assert.equal(res.body.data.sex, 'Female');
    assert.equal(res.body.data.phone_number, '4155550143');
    assert.equal(res.body.data.zip_code, '94110-1234');
    assert.equal(res.body.data.email, 'mixedcase@example.com');
  });

  test('strips unknown fields rather than storing them', async () => {
    const res = await call('POST', '/patients', validPatient({
      last_name: 'Sanitized', is_admin: true, ssn: '123-45-6789',
    }));
    assert.equal(res.status, 201);
    assert.ok(!('is_admin' in res.body.data));
    assert.ok(!('ssn' in res.body.data));
  });

  test('an empty update is rejected', async () => {
    const created = await call('POST', '/patients', validPatient({ last_name: 'Empty' }));
    const res = await call('PUT', `/patients/${created.body.data.patient_id}`, {});
    assert.equal(res.status, 422);
  });
});

describe('health', () => {
  test('reports database connectivity', async () => {
    const res = await call('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'healthy');
    assert.equal(res.body.data.database, 'ok');
  });
});

describe('health reports storage durability', () => {
  test('names the active driver so a misconfigured deploy is visible', async () => {
    const res = await call('GET', '/health');
    assert.equal(res.body.data.storage, 'sqlite', 'tests run on the local driver');
    assert.equal(res.body.data.persistent, true, 'not production, so no warning');
  });
});
