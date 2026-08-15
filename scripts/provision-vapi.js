#!/usr/bin/env node
/**
 * Push the assistant defined in `src/voice/assistant.config.js` to Vapi, and
 * (optionally) attach it to a phone number.
 *
 *   VAPI_API_KEY=... PUBLIC_BASE_URL=https://your-app.up.railway.app \
 *     npm run provision:vapi
 *
 * Re-running is safe: if VAPI_ASSISTANT_ID is set the existing assistant is
 * updated in place rather than a duplicate being created. Keeping this in a
 * script (instead of clicking through the dashboard) means the deployed
 * assistant always matches what is in git.
 */
import { config } from '../src/config.js';
import { assistantConfigFromEnv } from '../src/voice/assistant.config.js';

const API = 'https://api.vapi.ai';

function die(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

async function vapi(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${config.vapi.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    // Vapi's validation errors are the single most useful thing to surface
    // here — print them verbatim rather than a generic failure.
    console.error(`\n✖ Vapi ${method} ${path} → ${res.status}`);
    console.error(JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  return parsed;
}

if (!config.vapi.apiKey) die('VAPI_API_KEY is not set. Get it from Vapi → Settings → API Keys.');
if (!config.publicBaseUrl) {
  die('PUBLIC_BASE_URL is not set. It must be the public https URL of this service (Railway domain or ngrok URL).');
}
if (!config.publicBaseUrl.startsWith('https://')) {
  die(`PUBLIC_BASE_URL must be https (got "${config.publicBaseUrl}"). Vapi will not call an http webhook.`);
}

const assistant = assistantConfigFromEnv();

console.log('Webhook URL :', `${config.publicBaseUrl.replace(/\/$/, '')}/vapi/webhook`);
console.log('Model       :', `${assistant.model.provider} / ${assistant.model.model}`);
console.log('Voice       :', `${assistant.voice.provider} / ${assistant.voice.voiceId}`);
console.log('Tools       :', assistant.model.tools.map((t) => t.function.name).join(', '));
console.log('Secret set  :', config.vapi.serverSecret ? 'yes' : 'NO — set VAPI_SERVER_SECRET');
console.log('');

const existingId = config.vapi.assistantId;
const saved = existingId
  ? await vapi('PATCH', `/assistant/${existingId}`, assistant)
  : await vapi('POST', '/assistant', assistant);

console.log(`✔ Assistant ${existingId ? 'updated' : 'created'}: ${saved.id}`);

// Attach to a phone number so inbound calls route to this assistant.
if (config.vapi.phoneNumberId) {
  const number = await vapi('PATCH', `/phone-number/${config.vapi.phoneNumberId}`, {
    assistantId: saved.id,
  });
  console.log(`✔ Phone number ${number.number ?? config.vapi.phoneNumberId} now answers with this assistant`);
} else {
  const numbers = await vapi('GET', '/phone-number');
  if (!Array.isArray(numbers) || numbers.length === 0) {
    console.log(
      '\n! No phone numbers found on this Vapi account.\n' +
      '  Buy one in the Vapi dashboard (Phone Numbers → Buy Number), then re-run with\n' +
      `  VAPI_PHONE_NUMBER_ID=<id>, or assign assistant ${saved.id} to it in the dashboard.`,
    );
  } else {
    console.log('\n! Found these phone numbers but none was specified:');
    for (const n of numbers) console.log(`    ${n.number}  id=${n.id}`);
    console.log(`  Re-run with VAPI_PHONE_NUMBER_ID=<id> to attach assistant ${saved.id}.`);
  }
}

if (!existingId) {
  console.log(`\n→ Add this to your environment so future runs update in place:\n  VAPI_ASSISTANT_ID=${saved.id}\n`);
}
