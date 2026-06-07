/**
 * Required-gate computation and freshness.
 *
 * Fixes versus the original:
 *  - Contextual gates actually fire. The previous code computed required gates
 *    from `dirtyReasons` only (which never contain meaningful keywords), so the
 *    specialist reviewers were dead code. Here gates are derived from the
 *    captured goal text, the recorded Goal Contract, and the set of changed
 *    files.
 *  - Keyword matching is whole-word (token set), so `api` no longer matches
 *    inside `capital` and a fingerprint hex can't accidentally pull in a gate.
 *  - Freshness uses the monotonic seq counter and is invalidated by EDITS only.
 *    Re-running verification after a clean review no longer re-opens the gates.
 */

import { BASE_GATES, CONTEXTUAL_GATES } from "./agents.js";

function contractText(contract) {
  if (!contract || typeof contract !== "object") return "";
  const parts = [contract.original];
  for (const field of ["requirements", "inferred", "nonGoals", "acceptanceCriteria"]) {
    if (Array.isArray(contract[field])) parts.push(contract[field].join(" "));
  }
  return parts.filter(Boolean).join(" ");
}

/** Tokenize text into a lowercase whole-word set. */
function wordSet(text) {
  const set = new Set();
  for (const w of String(text || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (w) set.add(w);
  }
  return set;
}

/** The reviewers that must PASS for this state, given config. */
export function requiredGates(state, config) {
  const gates = [...BASE_GATES];
  if (!config || config.contextualGates) {
    const text = [
      state.goalText,
      contractText(state.contract),
      (state.changedFiles || []).join(" "),
    ].join(" ");
    const words = wordSet(text);
    for (const [keyword, agent] of Object.entries(CONTEXTUAL_GATES)) {
      if (words.has(keyword) && !gates.includes(agent)) gates.push(agent);
    }
  }
  return gates;
}

/** A gate is satisfied when its latest verdict is PASS and newer than the last edit. */
export function gatePassedFresh(state, agent) {
  const v = state.latestVerdict[agent];
  if (!v || v.verdict !== "PASS") return false;
  return v.seq > (state.lastEditSeq || 0);
}

export function missingGates(state, config) {
  return requiredGates(state, config).filter((agent) => !gatePassedFresh(state, agent));
}

export function completionAllowed(state, config) {
  return Boolean(state.active) && missingGates(state, config).length === 0;
}
