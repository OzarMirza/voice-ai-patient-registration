/**
 * Test harness.
 *
 * Each test file runs in its own process (node --test), so pointing
 * DATABASE_PATH at a fresh temp file before importing the app gives every file
 * a clean, isolated database that still exercises the real SQLite code path
 * rather than a mock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dbFile = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'patients-test-')),
  'test.sqlite',
);
process.env.DATABASE_PATH = dbFile;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
delete process.env.API_KEY;
delete process.env.VAPI_SERVER_SECRET;

const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
export const baseUrl = `http://127.0.0.1:${server.address().port}`;

/** fetch wrapper returning `{ status, body }`. */
export async function call(method, urlPath, body) {
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

/** Invoke a voice tool through the real Vapi webhook and return its result. */
export async function toolCall(name, parameters, callId = 'test-call') {
  const { status, body } = await call('POST', '/vapi/webhook', {
    message: {
      type: 'tool-calls',
      call: { id: callId },
      toolCallList: [{ id: `tc-${Math.random().toString(36).slice(2)}`, name, parameters }],
    },
  });
  return { status, result: JSON.parse(body.results[0].result) };
}

export const validPatient = (overrides = {}) => ({
  first_name: 'Jane',
  last_name: 'Doe',
  date_of_birth: '04/12/1986',
  sex: 'Female',
  phone_number: '2125550142',
  address_line_1: '118 Riverside Drive',
  city: 'New York',
  state: 'NY',
  zip_code: '10024',
  ...overrides,
});

export function teardown() {
  server.close();
}
