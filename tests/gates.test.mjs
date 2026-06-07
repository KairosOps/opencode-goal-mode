import test from "node:test";
import assert from "node:assert/strict";
import { createState } from "../plugins/goal-guard/state.js";
import { requiredGates, gatePassedFresh, missingGates, completionAllowed } from "../plugins/goal-guard/gates.js";
import { BASE_GATES } from "../plugins/goal-guard/agents.js";

const cfg = { contextualGates: true };

function withVerdict(state, agent, verdict, seq) {
  state.latestVerdict[agent] = { verdict, at: "t", seq };
}

test("base gates are always required", () => {
  const st = createState();
  const gates = requiredGates(st, cfg);
  for (const g of BASE_GATES) assert.ok(gates.includes(g), g);
});

test("contextual gates derive from goal text", () => {
  const st = createState();
  st.goalText = "add an auth endpoint and a database migration";
  const gates = requiredGates(st, cfg);
  assert.ok(gates.includes("goal-security-reviewer"));
  assert.ok(gates.includes("goal-api-reviewer"));
  assert.ok(gates.includes("goal-data-reviewer"));
});

test("contextual gates derive from the contract and changed files", () => {
  const st = createState();
  st.contract = { original: "", acceptanceCriteria: ["the login flow must be secure"], requirements: [], inferred: [], nonGoals: [] };
  st.changedFiles = ["src/db/migrations/001_init.sql"];
  const gates = requiredGates(st, cfg);
  assert.ok(gates.includes("goal-security-reviewer"));
  assert.ok(gates.includes("goal-data-reviewer"));
});

test("whole-word matching avoids substring false positives", () => {
  const st = createState();
  st.goalText = "capitalize the capital city headings and improve readability";
  const gates = requiredGates(st, cfg);
  assert.equal(gates.includes("goal-api-reviewer"), false, "'capital' must not pull api");
});

test("contextual gating can be disabled", () => {
  const st = createState();
  st.goalText = "rotate the auth token";
  const gates = requiredGates(st, { contextualGates: false });
  assert.deepEqual(gates, [...BASE_GATES]);
});

test("a gate is fresh only with a PASS newer than the last edit", () => {
  const st = createState();
  st.lastEditSeq = 5;
  withVerdict(st, "goal-reviewer", "PASS", 4);
  assert.equal(gatePassedFresh(st, "goal-reviewer"), false, "older PASS is stale");
  withVerdict(st, "goal-reviewer", "PASS", 6);
  assert.equal(gatePassedFresh(st, "goal-reviewer"), true);
  withVerdict(st, "goal-reviewer", "FAIL", 7);
  assert.equal(gatePassedFresh(st, "goal-reviewer"), false, "FAIL is never fresh");
});

test("same-seq is not fresh (strict greater-than)", () => {
  const st = createState();
  st.lastEditSeq = 5;
  withVerdict(st, "goal-reviewer", "PASS", 5);
  assert.equal(gatePassedFresh(st, "goal-reviewer"), false);
});

test("missingGates lists exactly the unmet gates", () => {
  const st = createState();
  st.active = true;
  st.lastEditSeq = 1;
  for (const g of BASE_GATES) withVerdict(st, g, "PASS", 2);
  assert.deepEqual(missingGates(st, cfg), []);
  // Knock one out.
  withVerdict(st, "goal-verifier", "FAIL", 3);
  assert.deepEqual(missingGates(st, cfg), ["goal-verifier"]);
});

test("completionAllowed requires active and no missing gates", () => {
  const st = createState();
  st.lastEditSeq = 1;
  for (const g of BASE_GATES) withVerdict(st, g, "PASS", 2);
  assert.equal(completionAllowed(st, cfg), false, "inactive blocks completion");
  st.active = true;
  assert.equal(completionAllowed(st, cfg), true);
});
