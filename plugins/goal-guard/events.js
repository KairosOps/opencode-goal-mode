/**
 * State-mutation primitives shared by the plugin hooks and the custom tools, so
 * that an edit recorded via the `edit` tool, a bash mutation, a `file.edited`
 * event, and a `goal_evidence` tool call all advance the same monotonic seq and
 * dirty bookkeeping in exactly one place.
 */

import { CYCLE_CLOSING_AGENT } from "./agents.js";
import { gatePassedFresh, completionAllowed } from "./gates.js";

function trim(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

export function markEdit(store, state, reason) {
  const at = store.nowIso();
  state.active = true;
  state.dirty = true;
  state.lastEditAt = at;
  state.lastEditSeq = store.nextSeq();
  state.dirtyReasons.push(reason || `edit at ${at}`);
  trim(state.dirtyReasons, 50);
  state.updatedAt = at;
}

export function markVerification(store, state) {
  const at = store.nowIso();
  state.verificationSeen = true;
  state.lastVerificationAt = at;
  state.lastVerificationSeq = store.nextSeq();
  state.updatedAt = at;
}

export function markFileChanged(store, state, file) {
  const name = String(file || "").trim();
  if (!name) return;
  if (!state.changedFiles.includes(name)) state.changedFiles.push(name);
  trim(state.changedFiles, 200);
  markEdit(store, state, `file edited: ${name}`);
}

export function recordEvidence(store, state, command, result, criteria) {
  const at = store.nowIso();
  state.evidence.push({
    command: String(command || ""),
    result: String(result || ""),
    criteria: Array.isArray(criteria) ? criteria.slice(0, 50) : [],
    at,
  });
  trim(state.evidence, 100);
  markVerification(store, state);
  state.updatedAt = at;
}

/**
 * When the cycle-closing auditor passes and all gates are fresh, the candidate
 * is genuinely clean: clear the dirty flag so the next answer can complete.
 */
export function maybeClearDirtyOnFinalPass(state, config) {
  if (!gatePassedFresh(state, CYCLE_CLOSING_AGENT)) return false;
  if (!completionAllowed(state, config)) return false;
  state.dirty = false;
  state.dirtyReasons = [];
  return true;
}
