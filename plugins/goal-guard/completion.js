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
  // final response begins with "Goal Completed"). Anchor to the first non-space of
  // any line — but the agent is taught to render the marker in a code span
  // (`Goal Completed`) and may prefix it with an emoji or an ordered-list marker,
  // so the leading-prefix class must tolerate backticks/tildes, an optional list
  // marker, and emoji. Still start-of-line anchored, so a mid-sentence mention is
  // never policed.
  // Any mix of leading whitespace, markdown punctuation, code-span backticks/tildes,
  // emoji (+ variation selectors), an ordered-list marker, a task-list checkbox
  // (`- [x]`), wrapping quotes/brackets/parens, and HTML tags (`<b>`, `<h2>`), in
  // ANY order. These are all natural ways a model ANNOUNCES completion, and each
  // must be policed — a premature claim wrapped in any of them previously leaked
  // through unrewritten. Still start-of-line anchored (a wrapper char must be
  // IMMEDIATELY followed by the marker), so a mid-sentence mention or a prose line
  // that merely opens with a quote is never policed.
  const PREFIX = "(?:<[^>]{0,24}>|\\[[ xX]?\\]|[\\s>*_#\\-`~\"'()\\[\\]]|\\p{Extended_Pictographic}|\\uFE0F|\\d+[.)])*";
  const markerRe = new RegExp(`^${PREFIX}${escaped}`, "imu");

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
  // Rewrite the SAME anchored line that triggered detection (preserving its
  // leading markdown prefix), not merely the first occurrence of the phrase —
  // otherwise an unrelated earlier mention would be mangled while the real
  // completion-claim heading stayed unflipped.
  const markerLineRe = new RegExp(`^(${PREFIX})${escaped}`, "imu");
  const replacement =
    text.replace(markerLineRe, (_m, prefix) => `${prefix}${blockedMarker}`) +
    `\n\nGoal Guard blocked completion: ${reason}. State: ${summary}`;
  return { blocked: true, reason, replacement, claimedCycles };
}
