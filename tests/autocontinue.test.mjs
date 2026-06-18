import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../plugins/goal-guard/state.js";
import { DEFAULT_CONFIG } from "../plugins/goal-guard/config.js";
import { evaluateAutoContinue, continuationMessage, NO_PROGRESS_LIMIT, ABORT_SUPPRESS_MS } from "../plugins/goal-guard/autocontinue.js";

const BASE = ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"];

function goalState(over = {}) {
  return Object.assign(createState("2026-01-01T00:00:00.000Z"), { active: true }, over);
}
function allBaseGatesPassing(seq = 10) {
  const v = {};
  for (const g of BASE) v[g] = { verdict: "PASS", seq };
  return v;
}

test("an active incomplete goal that goes idle → continue with a FORCING review directive", () => {
  const st = goalState({ goalText: "ship the feature" });
  const d = evaluateAutoContinue(st, DEFAULT_CONFIG);
  assert.equal(d.continue, true);
  assert.match(d.message, /not complete/i);
  assert.match(d.message, /goal_status/);
  // Reviews are programmatically forced: the message names the outstanding reviewers,
  // commands invoking them via the task tool, and states they cannot be skipped.
  assert.match(d.message, /task tool/i);
  assert.match(d.message, /cannot be skipped/i);
  assert.match(d.message, /goal-reviewer/);
  assert.equal(st.autoContinueCount, 1);
});

test("continuation message gives the exact task invocation for the first missing gate", () => {
  const st = goalState({ goalText: "ship the feature", contract: { acceptanceCriteria: ["x"], original: "ship the feature" } });
  const msg = continuationMessage(st, DEFAULT_CONFIG);
  // A copyable, concrete next action — not just "reviews are required".
  assert.match(msg, /task\(subagent_type:\s*"goal-prompt-auditor"/);
  assert.match(msg, /Verdict: PASS/);
});

test("continuation message tells the model to record a Goal Contract when none exists", () => {
  const st = goalState({ goalText: "ship the feature", contract: null });
  const msg = continuationMessage(st, DEFAULT_CONFIG);
  assert.match(msg, /goal_contract/);
});

test("a COMPLETE goal does not auto-continue and resets the counters", () => {
  const st = goalState({
    contract: { acceptanceCriteria: ["done"] },
    latestVerdict: allBaseGatesPassing(),
    lastEditSeq: 1,
    reviewCycles: 1,
    autoContinueCount: 7,
    autoContinueNoProgress: 3,
  });
  const d = evaluateAutoContinue(st, DEFAULT_CONFIG);
  assert.equal(d.continue, false);
  assert.equal(d.stopReason, undefined);
  assert.equal(st.autoContinueCount, 0);
  assert.equal(st.autoContinueNoProgress, 0);
});

test("the no-progress circuit breaker pauses after consecutive no-change ticks", () => {
  const st = goalState({ goalText: "auth security work" }); // stuck: state never changes
  let last;
  for (let i = 0; i < NO_PROGRESS_LIMIT + 1; i++) last = evaluateAutoContinue(st, DEFAULT_CONFIG);
  assert.equal(last.continue, false);
  assert.match(last.stopReason, /no progress/i);
});

test("real progress between idle ticks keeps it continuing (breaker never trips)", () => {
  const st = goalState({ goalText: "ship" });
  let last;
  for (let i = 0; i < NO_PROGRESS_LIMIT + 3; i++) {
    st.lastEditSeq = i + 1; // the agent did something each turn
    last = evaluateAutoContinue(st, DEFAULT_CONFIG);
  }
  assert.equal(last.continue, true, "as long as the goal keeps progressing, it keeps going");
});

test("the hard cap pauses auto-continue even while progressing", () => {
  const st = goalState({ goalText: "ship" });
  const cfg = { ...DEFAULT_CONFIG, maxAutoContinue: 3 };
  let last;
  for (let i = 0; i < 5; i++) {
    st.lastEditSeq = i + 1;
    last = evaluateAutoContinue(st, cfg);
  }
  assert.equal(last.continue, false);
  assert.match(last.stopReason, /cap of 3/);
  assert.equal(st.autoContinueCount, 3);
});

test("a user cancel (abortedAt) suppresses auto-continue — sends NO prompt", () => {
  const st = goalState({ goalText: "ship the feature", abortedAt: 1_000 });
  const d = evaluateAutoContinue(st, DEFAULT_CONFIG, 1_000 + 50); // idle 50ms after the abort
  assert.equal(d.continue, false, "must not continue a turn the user cancelled");
  assert.equal(d.cancelled, true);
  assert.equal(d.message, undefined, "no continuation message may be produced on cancel");
  assert.equal(st.abortedAt, 1_000, "the flag is NOT consumed — a single cancel emits multiple idles");
  assert.equal(st.autoContinueCount, 0, "a cancel must not advance the auto-continue counter");
});

test("a cancel suppresses EVERY idle in the window; only a resume (clearing the flag) continues", () => {
  const st = goalState({ goalText: "ship the feature", abortedAt: 1_000 });
  // Multiple idles after one cancel — all suppressed (live OpenCode emits >1 idle per abort).
  assert.equal(evaluateAutoContinue(st, DEFAULT_CONFIG, 1_050).cancelled, true);
  assert.equal(evaluateAutoContinue(st, DEFAULT_CONFIG, 1_120).cancelled, true);
  assert.equal(evaluateAutoContinue(st, DEFAULT_CONFIG, 1_300).cancelled, true);
  // A real resume clears the flag (the guard does this on chat.message/chat.params).
  st.abortedAt = 0;
  const next = evaluateAutoContinue(st, DEFAULT_CONFIG, 5_000);
  assert.equal(next.continue, true, "after a resume clears the cancel, the guard keeps the goal going");
  assert.equal(st.autoContinueCount, 1);
});

test("a STALE abort flag (outside the window) does not wrongly suppress", () => {
  const st = goalState({ goalText: "ship", abortedAt: 1_000 });
  const d = evaluateAutoContinue(st, DEFAULT_CONFIG, 1_000 + ABORT_SUPPRESS_MS + 1);
  assert.equal(d.continue, true, "an old abort timestamp must not block a much later idle");
  assert.equal(st.abortedAt, 0, "stale flag is still cleared");
});

test("a future-dated abort flag (clock skew) is treated as fresh, never dropped", () => {
  // Wall clock moved backward, or a future-dated abortedAt was restored — the cancel
  // must still be honored, not silently cleared.
  const st = goalState({ goalText: "ship", abortedAt: 10_000 });
  const d = evaluateAutoContinue(st, DEFAULT_CONFIG, 9_000); // now is BEFORE abortedAt
  assert.equal(d.cancelled, true, "a negative elapsed must suppress, not continue");
  assert.equal(st.abortedAt, 10_000, "a future-dated flag must not be cleared");
});

test("disabled config and non-goal sessions never auto-continue", () => {
  assert.equal(evaluateAutoContinue(goalState({ goalText: "x" }), { ...DEFAULT_CONFIG, autoContinue: false }).continue, false);
  assert.equal(evaluateAutoContinue(Object.assign(createState(), { active: false }), DEFAULT_CONFIG).continue, false);
});
