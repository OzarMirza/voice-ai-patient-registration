/**
 * Short-lived, in-memory state for calls that are currently in progress.
 *
 * Its only job is to remember which patient a call produced, so the
 * end-of-call report (which arrives after hangup, as a separate request) can
 * be filed against the right record. Anything that must survive a restart is
 * already in SQLite — losing this map costs at most the patient link on a
 * transcript, never a patient record.
 */
const TTL_MS = 60 * 60 * 1000; // calls are capped at 15 minutes; 1h is generous
const calls = new Map();

function sweep() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of calls) {
    if (entry.updatedAt < cutoff) calls.delete(id);
  }
}

export function rememberCall(callId, patch) {
  if (!callId) return;
  const existing = calls.get(callId) ?? { callId, toolCalls: [] };
  calls.set(callId, { ...existing, ...patch, updatedAt: Date.now() });
  if (calls.size > 500) sweep();
}

export function recallCall(callId) {
  return callId ? (calls.get(callId) ?? null) : null;
}

export function forgetCall(callId) {
  calls.delete(callId);
}
