import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../plugins/goal-guard/state.js";
import { DEFAULT_CONFIG } from "../plugins/goal-guard/config.js";
import { evaluateAutoContinue, NO_PROGRESS_LIMIT } from "../plugins/goal-guard/autocontinue.js";

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

test("disabled config and non-goal sessions never auto-continue", () => {
  assert.equal(evaluateAutoContinue(goalState({ goalText: "x" }), { ...DEFAULT_CONFIG, autoContinue: false }).continue, false);
  assert.equal(evaluateAutoContinue(Object.assign(createState(), { active: false }), DEFAULT_CONFIG).continue, false);
});
