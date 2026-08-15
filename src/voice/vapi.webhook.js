/**
 * Vapi webhook.
 *
 * Single endpoint (POST /vapi/webhook) that handles every server message type
 * Vapi sends. The payload shape has changed across Vapi versions, so parsing
 * is deliberately tolerant: `toolCallList` (current), `toolWithToolCallList`,
 * and the legacy `functionCall` form are all accepted, and arguments may
 * arrive as either an object or a JSON string.
 *
 * Everything here returns 200 quickly. A webhook that errors or hangs turns
 * into dead air on a live phone call, so failures are converted into a spoken
 * recovery instruction for the agent rather than an HTTP error.
 */
import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { invokeTool } from './tools.js';
import { assistantConfigFromEnv } from './assistant.config.js';
import { normalizePhone } from '../domain/normalize.js';
import { findPatientsByPhone, upsertCall } from '../domain/patient.service.js';
import { forgetCall, recallCall, rememberCall } from './call-state.js';

export const vapiRouter = Router();

/**
 * Verify the shared secret Vapi attaches to every webhook.
 * No secret configured => open (useful for local ngrok testing), but the
 * README tells you to set one in production.
 */
function verifySecret(req) {
  if (!config.vapi.serverSecret) return true;
  const provided =
    req.get('x-vapi-secret') ||
    req.get('x-vapi-signature') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return provided === config.vapi.serverSecret;
}

/** Tool arguments arrive as an object or a JSON string depending on the model. */
function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn('could not parse tool arguments', { raw: String(raw).slice(0, 200) });
    return {};
  }
}

/** Normalize every known tool-call payload shape into `{ id, name, args }`. */
function extractToolCalls(message) {
  const calls = [];

  for (const entry of message.toolCallList ?? []) {
    calls.push({
      id: entry.id ?? entry.toolCallId,
      name: entry.name ?? entry.function?.name,
      args: parseArgs(entry.parameters ?? entry.arguments ?? entry.function?.arguments),
    });
  }

  if (calls.length === 0) {
    for (const entry of message.toolWithToolCallList ?? []) {
      const tc = entry.toolCall ?? {};
      calls.push({
        id: tc.id,
        name: entry.name ?? tc.name ?? tc.function?.name,
        args: parseArgs(tc.parameters ?? tc.arguments ?? tc.function?.arguments),
      });
    }
  }

  // Legacy single function-call shape.
  if (calls.length === 0 && message.functionCall) {
    calls.push({
      id: message.functionCall.id ?? 'function-call',
      name: message.functionCall.name,
      args: parseArgs(message.functionCall.parameters ?? message.functionCall.arguments),
    });
  }

  return calls.filter((c) => c.name);
}

const callerNumber = (call) =>
  normalizePhone(call?.customer?.number ?? call?.from ?? call?.phoneNumber?.number ?? null);

// ---------------------------------------------------------------------------

vapiRouter.post('/webhook', async (req, res) => {
  if (!verifySecret(req)) {
    logger.warn('rejected vapi webhook with bad secret', { ip: req.ip });
    return res.status(401).json({ error: 'invalid secret' });
  }

  const message = req.body?.message ?? req.body ?? {};
  const type = message.type ?? 'unknown';
  const call = message.call ?? {};
  const callId = call.id ?? message.callId ?? null;

  logger.debug('vapi webhook', { type, call_id: callId });

  try {
    switch (type) {
      // -------------------------------------------------------------------
      case 'tool-calls':
      case 'function-call': {
        const toolCalls = extractToolCalls(message);
        if (toolCalls.length === 0) {
          return res.json({ results: [] });
        }

        const results = await Promise.all(toolCalls.map(async ({ id, name, args }) => {
          let output;
          try {
            output = await invokeTool(name, args, { callId });
          } catch (err) {
            // A thrown handler must never become dead air.
            logger.error('tool handler threw', { tool: name, error: err.message });
            output = {
              ok: false,
              status: 'error',
              instruction:
                "Something went wrong on our end. Apologize briefly, tell the caller a staff member will call them back to finish, and close the call politely. Do not say they are registered.",
            };
          }

          if (output?.patient_id && output?.saved) {
            rememberCall(callId, { patientId: output.patient_id, outcome: 'registered' });
          }

          logger.info('tool invoked', {
            call_id: callId,
            tool: name,
            status: output?.status ?? 'ok',
          });

          return { name, toolCallId: id, result: JSON.stringify(output) };
        }));

        // Legacy shape expects a bare `result`; sending both keys is harmless.
        return res.json(
          type === 'function-call'
            ? { results, result: results[0].result }
            : { results },
        );
      }

      // -------------------------------------------------------------------
      // Lets a Vapi phone number be pointed straight at this server: the
      // assistant (prompt, tools, voice) is served from code at call time,
      // pre-seeded with the caller's number so the agent never asks a
      // returning patient to recite a number we already have.
      case 'assistant-request': {
        const phone = callerNumber(call);
        const known = phone ? await findPatientsByPhone(phone) : [];

        rememberCall(callId, { callerPhone: phone });

        const assistant = assistantConfigFromEnv({ callerPhone: phone });

        if (known.length === 1) {
          // Give the model the match up front so the very first turn can offer
          // an update instead of interviewing a patient we already have.
          assistant.model.messages.push({
            role: 'system',
            content: `Caller ID matches an existing patient: ${known[0].first_name} ${known[0].last_name} (patient_id ${known[0].patient_id}). Greet them by first name and ask whether they are calling to update their information. Do not run lookup_patient again.`,
          });
        }

        return res.json({ assistant });
      }

      // -------------------------------------------------------------------
      case 'end-of-call-report': {
        const state = recallCall(callId);
        const artifact = message.artifact ?? {};

        await upsertCall({
          providerCallId: callId,
          patientId: state?.patientId ?? null,
          callerPhone: state?.callerPhone ?? callerNumber(call),
          outcome: state?.patientId ? (state.outcome ?? 'registered') : 'abandoned',
          endedReason: message.endedReason ?? null,
          durationSeconds:
            message.durationSeconds ??
            (call.startedAt && call.endedAt
              ? Math.round((new Date(call.endedAt) - new Date(call.startedAt)) / 1000)
              : null),
          summary: message.analysis?.summary ?? message.summary ?? null,
          transcript: artifact.transcript ?? message.transcript ?? null,
          collectedPayload: message.analysis?.structuredData ?? null,
        });

        if (config.logTranscripts) {
          logger.info('call completed', {
            call_id: callId,
            patient_id: state?.patientId ?? null,
            ended_reason: message.endedReason,
            transcript: artifact.transcript ?? null,
          });
        }

        forgetCall(callId);
        return res.status(200).json({ received: true });
      }

      // -------------------------------------------------------------------
      case 'status-update': {
        if (message.status === 'in-progress' && !recallCall(callId)) {
          rememberCall(callId, { callerPhone: callerNumber(call) });
        }
        return res.status(200).json({ received: true });
      }

      default:
        return res.status(200).json({ received: true, ignored: type });
    }
  } catch (err) {
    logger.error('vapi webhook failed', { type, error: err.message, stack: err.stack });
    // Still 200: a 5xx here can drop the call.
    return res.status(200).json({
      results: [],
      error: 'internal error handled',
    });
  }
});

/**
 * Convenience endpoint: returns the exact assistant JSON this build would
 * deploy. Handy for diffing against what is live in Vapi.
 */
vapiRouter.get('/assistant', (req, res) => {
  res.ok(assistantConfigFromEnv());
});
