import test from "node:test";
import assert from "node:assert/strict";
import { textOf, parseVerdict, hasVerdict, recordVerdict, latestVerdictFor } from "../plugins/goal-guard/verdicts.js";
import { createStore, createState } from "../plugins/goal-guard/state.js";

test("parseVerdict reads a simple verdict", () => {
  assert.equal(parseVerdict("Verdict: PASS"), "PASS");
  assert.equal(parseVerdict("Verdict: FAIL"), "FAIL");
  assert.equal(parseVerdict("no verdict here"), null);
});

test("parseVerdict is last-wins", () => {
  assert.equal(parseVerdict("Verdict: FAIL\n...fixed...\nVerdict: PASS"), "PASS");
  assert.equal(parseVerdict("Verdict: PASS then regressed\nVerdict: FAIL"), "FAIL");
});

test("parseVerdict prefers line-anchored conclusions over inline mentions", () => {
  const text = "The author wrote 'Verdict: PASS' in a comment but I disagree.\nVerdict: FAIL";
  assert.equal(parseVerdict(text), "FAIL");
});

test("parseVerdict tolerates markdown emphasis and leading markers", () => {
  assert.equal(parseVerdict("- **Verdict:** PASS"), "PASS");
  assert.equal(parseVerdict("> Verdict: FAIL"), "FAIL");
});

test("parseVerdict is case-insensitive on the keyword", () => {
  assert.equal(parseVerdict("verdict: pass"), "PASS");
});

test("textOf unwraps the task_result envelope", () => {
  const wrapped = '<task id="abc" state="completed"><task_result>Looks good. Verdict: PASS</task_result></task>';
  assert.match(textOf({ output: wrapped }), /Verdict: PASS/);
  assert.equal(parseVerdict(textOf({ output: wrapped })), "PASS");
});

test("textOf handles string, nested, and object outputs", () => {
  assert.equal(textOf("hello"), "hello");
  assert.equal(textOf({ output: "x" }), "x");
  assert.equal(textOf({ text: "y" }), "y");
  assert.match(textOf({ output: { output: "z" } }), /z/);
  assert.equal(textOf(null), "");
});

test("hasVerdict mirrors parseVerdict", () => {
  assert.equal(hasVerdict("Verdict: PASS"), true);
  assert.equal(hasVerdict("nope"), false);
});

test("recordVerdict stamps seq and updates latestVerdict", () => {
  const store = createStore();
  const st = createState();
  const a = recordVerdict(store, st, "goal-reviewer", "PASS");
  const b = recordVerdict(store, st, "goal-reviewer", "FAIL");
  assert.ok(b.seq > a.seq);
  assert.equal(latestVerdictFor(st, "goal-reviewer").verdict, "FAIL");
  assert.equal(st.verdicts.length, 2);
});

test("recordVerdict increments review cycles only for the final auditor", () => {
  const store = createStore();
  const st = createState();
  recordVerdict(store, st, "goal-reviewer", "PASS");
  assert.equal(st.reviewCycles, 0);
  recordVerdict(store, st, "goal-final-auditor", "PASS");
  assert.equal(st.reviewCycles, 1);
  recordVerdict(store, st, "goal-final-auditor", "FAIL");
  assert.equal(st.reviewCycles, 2);
});

test("verdict log is bounded", () => {
  const store = createStore();
  const st = createState();
  for (let i = 0; i < 250; i += 1) recordVerdict(store, st, "goal-reviewer", "PASS");
  assert.ok(st.verdicts.length <= 200);
  // latestVerdict still tracks the newest.
  assert.equal(latestVerdictFor(st, "goal-reviewer").verdict, "PASS");
});
