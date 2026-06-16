/**
 * Auto-continue: keep an active goal session working until the goal is actually
 * complete, so it never stops early.
 *
 * When an active goal session goes idle but completion is NOT yet allowed (missing
 * or stale review gates, unreviewed changes, etc.), the guard sends the agent a
 * "do not stop — continue" message (via client.session.promptAsync) to start the
 * next turn automatically. Two backstops keep this from ever running away:
 *
 *  - a hard per-session cap (`maxAutoContinue`);
 *  - a no-progress circuit breaker: if the goal state has not changed across
 *    `NO_PROGRESS_LIMIT` consecutive idle ticks, auto-continue pauses (the agent is
 *    stuck and the human should step in) instead of looping forever.
 *
 * The decision function is pure except that it advances the per-session counters on
 * `state`, so it is fully unit-testable.
 */

import { completionAllowed, missingGates } from "./gates.js";

/** Consecutive no-change idle ticks after which auto-continue pauses for the human. */
export const NO_PROGRESS_LIMIT = 4;

/** A fingerprint of goal PROGRESS — changes whenever the agent did something useful. */
export function progressSignature(state) {
  return [
    Number(state?.reviewCycles) || 0,
    Number(state?.lastEditSeq) || 0,
    Number(state?.lastReviewSeq) || 0,
    Number(state?.lastVerificationSeq) || 0,
    Array.isArray(state?.evidence) ? state.evidence.length : 0,
    missingGates(state, undefined).length,
    state?.dirty ? 1 : 0,
  ].join(":");
}

/** Build the "keep going" message the agent receives, naming what is still owed. */
export function continuationMessage(state, config) {
  const missing = missingGates(state, config);
  const lines = ["The goal is NOT complete yet — do not stop. Continue working now."];
  if (state?.dirty) {
    lines.push("There are changes that are not yet reviewed/verified: re-run verification and the required reviews after your latest edits.");
  }
  if (missing.length) {
    lines.push(`Required review gates still missing or stale: ${missing.join(", ")}. Run those reviewers and fix every blocking finding, then re-review.`);
  }
  lines.push(
    "Use the goal_status tool to see exactly what is required. Only finish with `Goal Completed` (and an accurate `Review cycles: N`) once goal_status reports completion is allowed.",
  );
  return lines.join(" ");
}

/**
 * Decide whether to auto-continue an idle goal session. ADVANCES the per-session
 * auto-continue counters on `state`.
 *
 * @returns {{ continue: boolean, message?: string, stopReason?: string }}
 *   - `continue:true` with a `message` to send the agent;
 *   - `continue:false` with a `stopReason` when a backstop tripped (surface it);
 *   - `continue:false` with no `stopReason` when there is simply nothing to do
 *     (disabled, not a goal session, or the goal is already complete).
 */
export function evaluateAutoContinue(state, config) {
  if (!config?.autoContinue) return { continue: false };
  if (!state || !state.active) return { continue: false };

  if (completionAllowed(state, config)) {
    // Goal is complete — let it stop, and reset the counters for the next goal.
    state.autoContinueCount = 0;
    state.autoContinueNoProgress = 0;
    state.lastAutoContinueSig = "";
    return { continue: false };
  }

  // Incomplete: decide whether to nudge the agent onward.
  const sig = progressSignature(state);
  if (sig === state.lastAutoContinueSig) {
    state.autoContinueNoProgress = (Number(state.autoContinueNoProgress) || 0) + 1;
  } else {
    state.autoContinueNoProgress = 0;
  }
  state.lastAutoContinueSig = sig;

  const cap = Number(config.maxAutoContinue) || 0;
  if (cap > 0 && (Number(state.autoContinueCount) || 0) >= cap) {
    return { continue: false, stopReason: `auto-continue cap of ${cap} reached` };
  }
  if (state.autoContinueNoProgress >= NO_PROGRESS_LIMIT) {
    return { continue: false, stopReason: `no progress after ${NO_PROGRESS_LIMIT} auto-continue attempts` };
  }

  state.autoContinueCount = (Number(state.autoContinueCount) || 0) + 1;
  return { continue: true, message: continuationMessage(state, config) };
}
