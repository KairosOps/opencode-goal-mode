/**
 * State-mutation primitives shared by the plugin hooks and the custom tools, so
 * that an edit recorded via the `edit` tool, a bash mutation, a `file.edited`
 * event, and a `goal_evidence` tool call all advance the same monotonic seq and
 * dirty bookkeeping in exactly one place.
 */

import { CYCLE_CLOSING_AGENT } from "./agents.js";
import { gatePassedFresh, completionAllowed, refreshStickyGates } from "./gates.js";

function trim(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

/**
 * Anchor a minimal Goal Contract for an ACTIVE goal session that has captured a
 * goal but whose model never called `goal_contract` (common with weak models).
 *
 * Without this, a low-capability model that skips the tool leaves the session
 * with no contract: the TUI sidebar shows nothing and the model has no recorded
 * objective to steer by. Enforcement (base + contextual gates) already engages
 * from `active`, so this is purely additive — it gives the goal a baseline
 * contract derived from the user's own request. `acceptanceCriteria` is left
 * empty on purpose so the system-prompt keeps nudging the model to enrich it via
 * `goal_contract` (which UPGRADES the auto contract in place, see tools.js).
 *
 * It is a strict no-op unless the session is an active goal with goal text and no
 * existing contract, so it can never seed a Build/Plan/non-goal session.
 *
 * @returns {boolean} true if a contract was seeded.
 */
export function maybeAutoSeedContract(store, state) {
  if (!state || !state.active || state.contract) return false;
  const goal = String(state.goalText || "").replace(/\s+/g, " ").trim();
  if (!goal) return false;
  const title = goal.split(" ").slice(0, 8).join(" ").replace(/[.?!,;:]+$/, "");
  state.contract = {
    title,
    original: goal.slice(0, 4000),
    requirements: [],
    inferred: [],
    nonGoals: [],
    acceptanceCriteria: [],
    auto: true,
    at: store.nowIso(),
  };
  refreshStickyGates(state);
  state.updatedAt = store.nowIso();
  return true;
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
  return state.lastVerificationSeq;
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
  const entry = {
    command: String(command || ""),
    result: String(result || ""),
    criteria: Array.isArray(criteria) ? criteria.slice(0, 50) : [],
    at,
    seq: 0,
  };
  state.evidence.push(entry);
  trim(state.evidence, 100);
  entry.seq = markVerification(store, state);
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
