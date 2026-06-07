/**
 * Completion-claim enforcement.
 *
 * Evaluates a finished assistant message that claims `Goal Completed` and
 * decides whether the claim is allowed. The rewrite is only applied to ACTIVE
 * goal sessions, so an unrelated assistant turn that merely quotes the phrase
 * in a non-goal session is never corrupted (a bug in the original).
 *
 * A claim is rejected when any of the following hold:
 *  - the required `Review cycles: N` line is missing;
 *  - no review cycle has been recorded (N must be > 0);
 *  - the claimed N does not match the recorded review-cycle count;
 *  - required review gates are missing or stale for the current state.
 */

import { missingGates, completionAllowed } from "./gates.js";
import { summarizeState } from "./summary.js";

const CYCLES_RE = /Review cycles:\s*(\d+)/i;

/**
 * @returns {{ blocked: boolean, reason?: string, replacement?: string, claimedCycles?: number }}
 */
export function evaluateCompletionClaim(state, config, text) {
  const marker = config.completionMarker || "Goal Completed";
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The completion contract requires the message to START with the marker (the
  // final response begins with "Goal Completed"). Anchor to the first non-space
  // of the message or of any line, so a mid-sentence mention is not policed.
  const markerRe = new RegExp(`^[\\s>*_#-]*${escaped}`, "im");

  if (!text || !markerRe.test(text)) return { blocked: false };
  // Only police active goal sessions.
  if (!state.active) return { blocked: false };

  const match = text.match(CYCLES_RE);
  const claimedCycles = match ? Number.parseInt(match[1], 10) : -1;
  const summary = summarizeState(state, config);

  let reason = null;
  if (claimedCycles < 0) {
    reason = "missing required Review cycles line";
  } else if (state.reviewCycles === 0) {
    reason = "no review cycles recorded";
  } else if (claimedCycles !== state.reviewCycles) {
    reason = `claimed review cycles (${claimedCycles}) do not match recorded review cycles (${state.reviewCycles})`;
  } else if (!completionAllowed(state, config)) {
    const missing = missingGates(state, config).join(", ");
    reason = `required review gates are missing or stale (${missing || "goal session not active"})`;
  }

  if (!reason) return { blocked: false, claimedCycles };

  const blockedMarker = config.blockedMarker || "Goal Not Completed";
  // Replace only the marker word itself, preserving any leading markdown/prefix.
  const markerWordRe = new RegExp(escaped, "i");
  const replacement =
    text.replace(markerWordRe, blockedMarker) +
    `\n\nGoal Guard blocked completion: ${reason}. State: ${summary}`;
  return { blocked: true, reason, replacement, claimedCycles };
}
