/**
 * Vapi assistant configuration, generated from code.
 *
 * Keeping this in the repo rather than clicking it together in a dashboard
 * means the prompt, the tool schemas and the turn-taking settings are all
 * version-controlled and reviewable. `npm run provision:vapi` pushes this to
 * Vapi; the `assistant-request` webhook can also serve it inline at call time.
 */
import { config } from '../config.js';
import { buildSystemPrompt, FIRST_MESSAGE } from './prompt.js';
import { toolDefinitions } from './tools.js';

export function buildAssistantConfig({
  serverUrl = null,
  callerPhone = null,
  secret = null,
} = {}) {
  const toolServerUrl = serverUrl ? `${serverUrl.replace(/\/$/, '')}/vapi/webhook` : null;

  return {
    name: 'Riverside Family Health — Patient Intake',

    // --- Speech in -------------------------------------------------------
    transcriber: {
      provider: 'deepgram',
      // nova-3 + "multi" enables mid-call code-switching, which is what makes
      // the Spanish bonus work without the caller restarting.
      model: process.env.TRANSCRIBER_MODEL || 'nova-3',
      language: process.env.TRANSCRIBER_LANGUAGE || 'multi',
      smartFormat: true,
    },

    // --- Reasoning -------------------------------------------------------
    model: {
      // Claude Sonnet 5 via Vapi's built-in Anthropic integration — no
      // separate Anthropic key needed. Override with LLM_PROVIDER/LLM_MODEL.
      provider: process.env.LLM_PROVIDER || 'anthropic',
      model: process.env.LLM_MODEL || 'claude-sonnet-5',
      // Low but non-zero: enough variation that acknowledgements don't repeat
      // word for word, not so much that it improvises around the script.
      temperature: Number(process.env.LLM_TEMPERATURE || 0.4),
      maxTokens: 300,
      messages: [{ role: 'system', content: buildSystemPrompt({ callerPhone }) }],
      tools: toolDefinitions(toolServerUrl, secret),
    },

    // --- Speech out ------------------------------------------------------
    voice: {
      // Vapi's bundled voices need no third-party key. Swap to 11labs/cartesia
      // by setting VOICE_PROVIDER + VOICE_ID.
      provider: process.env.VOICE_PROVIDER || 'vapi',
      voiceId: process.env.VOICE_ID || 'Savannah',
      // Emit audio as soon as a clause is ready instead of waiting for the
      // whole sentence — the single biggest perceived-latency win.
      chunkPlan: { enabled: true, minCharacters: 30 },
    },

    firstMessage: FIRST_MESSAGE,
    firstMessageMode: 'assistant-speaks-first',

    // --- Turn taking -----------------------------------------------------
    startSpeakingPlan: {
      // Callers reciting an address pause mid-thought; waiting a beat stops
      // the agent from talking over them.
      waitSeconds: 0.6,
    },
    stopSpeakingPlan: {
      // Barge-in: stop talking once the caller has clearly started.
      numWords: 2,
      voiceSeconds: 0.25,
      backoffSeconds: 1.2,
    },

    // --- Call lifecycle --------------------------------------------------
    silenceTimeoutSeconds: 30,
    maxDurationSeconds: 900,
    backgroundSound: 'office',
    endCallFunctionEnabled: true,
    endCallMessage: 'Thanks for calling Riverside Family Health. Take care!',
    endCallPhrases: ['goodbye', 'bye bye', 'have a good day', 'talk to you later'],

    // Nudge, rather than sit in silence, if the caller goes quiet.
    messagePlan: {
      idleMessages: [
        'Are you still there?',
        "I'm still here whenever you're ready.",
      ],
      idleTimeoutSeconds: 12,
      idleMessageMaxSpokenCount: 2,
    },

    // --- Post-call -------------------------------------------------------
    // Vapi runs these after hangup and posts them to our end-of-call webhook,
    // where they are archived against the patient record.
    analysisPlan: {
      summaryPlan: {
        enabled: true,
        messages: [
          {
            role: 'system',
            content:
              'Summarize this patient intake call in 2-3 sentences: who called, what was collected, and whether registration completed.',
          },
        ],
      },
      structuredDataPlan: {
        enabled: true,
        schema: {
          type: 'object',
          properties: {
            registration_completed: { type: 'boolean' },
            patient_name: { type: 'string' },
            fields_corrected: { type: 'array', items: { type: 'string' } },
            caller_sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
          },
        },
      },
    },

    server: toolServerUrl
      ? { url: toolServerUrl, timeoutSeconds: 20, ...(secret ? { secret } : {}) }
      : undefined,

    serverMessages: ['tool-calls', 'end-of-call-report', 'status-update'],
  };
}

/** Convenience wrapper used by the provisioning script and the webhook. */
export function assistantConfigFromEnv(overrides = {}) {
  return buildAssistantConfig({
    serverUrl: config.publicBaseUrl,
    secret: config.vapi.serverSecret,
    ...overrides,
  });
}
