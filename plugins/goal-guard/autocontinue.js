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

/** How long after a user cancel (MessageAbortedError) an idle is treated as the
 * cancel's own idle and the auto-continue is suppressed. The real gap between the
 * abort and its idle is ~milliseconds; this window only guards against a stale flag
 * wrongly suppressing a much later, legitimate idle. */
export const ABORT_SUPPRESS_MS = 2 * 60 * 1000;

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

/** Build the "keep going" message the agent receives, naming what is still owed.
 *
 * When `programmaticReview` is on (the default) the reviews are run BY THE GUARD ITSELF
 * the moment the agent stops — so the message explicitly tells the agent NOT to call any
 * reviewer; its job is only to implement and verify. Only when programmatic review is
 * disabled (or unavailable) does the message fall back to directing the agent to run the
 * exact reviewer gates via the task tool. */
export function continuationMessage(state, config) {
  const missing = missingGates(state, config);
  const lines = ["The goal is NOT complete — do not stop. Continue working now."];
  if (!state?.contract) {
    lines.push("First, record the Goal Contract with the `goal_contract` tool (title, the original request, and concrete acceptance criteria) so the objective is anchored.");
  }
  if (state?.dirty) {
    lines.push("There are changes that are not yet reviewed/verified after your latest edits — actually run the code/tests and record it with `goal_evidence`.");
  }
  if (missing.length) {
    if (config?.programmaticReview) {
      lines.push(
        `The Goal Guard runs the required reviews itself, automatically, the moment you stop — ` +
          `do NOT call any reviewer yourself (no \`task\` calls to goal-* reviewers). ` +
          `Keep implementing and verifying; when you believe the goal is done, just stop. ` +
          `The guard will then run the outstanding gates (${missing.join(", ")}) in one pass, ` +
          `and either re-prompt you with the exact blocking findings to fix or open completion. ` +
          `Never claim completion yourself until the guard confirms every review passed.`,
      );
    } else {
      const next = missing[0];
      lines.push(
        `REQUIRED REVIEWS ARE NOT DONE and cannot be skipped. For EACH of these, make one ` +
          `task tool call whose subagent_type is that exact reviewer id, fix every blocking finding, and ` +
          `re-run until it returns "Verdict: PASS": ${missing.join(", ")}. ` +
          `Start now with: task(subagent_type: "${next}", description: "${next} review", ` +
          `prompt: "Review the latest changes against the goal and end with a \\"Verdict: PASS\\" or \\"Verdict: FAIL\\" line."). ` +
          `Do not write a summary, ask the user anything, or claim completion until they all pass.`,
      );
    }
  }
  lines.push(
    "Call goal_status if unsure what is required. Only finish with `Goal Completed` (and an accurate `Review cycles: N`) once goal_status reports completion is allowed.",
  );
  return lines.join(" ");
}

/**
 * Decide whether to auto-continue an idle goal session. ADVANCES the per-session
 * auto-continue counters on `state`.
 *
 * @returns {{ continue: boolean, message?: string, stopReason?: string, cancelled?: boolean }}
 *   - `continue:true` with a `message` to send the agent;
 *   - `continue:false, cancelled:true` when the user cancelled this turn — honor it,
 *     send NOTHING (no prompt);
 *   - `continue:false` with a `stopReason` when a backstop tripped (surface it);
 *   - `continue:false` with no `stopReason` when there is simply nothing to do
 *     (disabled, not a goal session, or the goal is already complete).
 *
 * @param {object} state
 * @param {object} config
 * @param {number} [now]  Wall clock (injectable for tests).
 */
export function evaluateAutoContinue(state, config, now = Date.now()) {
  if (!config?.autoContinue) return { continue: false };
  if (!state || !state.active) return { continue: false };

  // Honor a user cancel: a MessageAbortedError sets `state.abortedAt`. Never
  // re-prompt a turn the user explicitly stopped. A single cancel emits MORE THAN
  // ONE session.idle, so the flag is NOT consumed here — every idle inside the
  // window is suppressed. It is cleared only when the user actually resumes (a new
  // turn clears it in chat.message/chat.params). A stale flag outside the window is
  // cleared defensively.
  if (state.abortedAt) {
    const sinceAbort = now - Number(state.abortedAt);
    // Suppress while within the window. A NEGATIVE elapsed (wall clock moved
    // backwards, or a future-dated/persisted abortedAt) is treated as still-fresh —
    // never as "stale" — so a genuine cancel is never dropped by clock skew. The flag
    // is cleared only once the window has genuinely elapsed.
    if (sinceAbort < ABORT_SUPPRESS_MS) {
      return { continue: false, cancelled: true };
    }
    state.abortedAt = 0; // genuinely past the window — clear and fall through
  }

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
