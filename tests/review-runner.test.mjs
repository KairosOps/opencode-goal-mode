import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../plugins/goal-guard/state.js";
import { markEdit } from "../plugins/goal-guard/events.js";
import { DEFAULT_CONFIG } from "../plugins/goal-guard/config.js";
import { completionAllowed } from "../plugins/goal-guard/gates.js";
import { runReviewCycle, clientCanReview, reviewerPrompt } from "../plugins/goal-guard/review-runner.js";

/** A mock OpenCode client whose "reviewer" sessions return a Verdict line per agent. */
function mockReviewClient(verdictFor) {
  let n = 0;
  const agentOf = new Map();
  const created = [];
  const aborted = [];
  return {
    created,
    aborted,
    session: {
      create: async () => ({ data: { id: `rs${++n}` } }),
      promptAsync: async ({ path, body }) => {
        agentOf.set(path.id, body.agent);
        created.push(body.agent);
      },
      messages: async ({ path }) => {
        const agent = agentOf.get(path.id);
        const v = typeof verdictFor === "function" ? verdictFor(agent) : verdictFor;
        const text = v ? `Reviewed the changes.\n\nVerdict: ${v}` : "I could not reach a conclusion.";
        return { data: [{ info: { role: "assistant", agent }, parts: [{ type: "text", text }] }] };
      },
      abort: async ({ path }) => {
        aborted.push(path.id);
      },
    },
  };
}

function goalState(store, id) {
  const state = store.stateFor(id);
  state.active = true;
  state.contract = { title: "Do x", original: "do x", acceptanceCriteria: ["x works"] };
  markEdit(store, state, "edit"); // there is work to review
  return state;
}

const fastOpts = { sleep: async () => {}, pollMs: 1, timeoutMs: 500 };

test("clientCanReview detects the required client surface", () => {
  assert.equal(clientCanReview({ session: { create() {}, promptAsync() {}, messages() {} } }), true);
  assert.equal(clientCanReview({ app: {}, tui: {} }), false);
  assert.equal(clientCanReview(null), false);
});

test("runReviewCycle programmatically launches ALL required reviewers and records PASS → completion allowed", async () => {
  const store = createStore();
  const state = goalState(store, "g1");
  const client = mockReviewClient("PASS");
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, fastOpts);
  // every BASE gate was launched by the CODE (not the agent)
  for (const gate of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    assert.ok(client.created.includes(gate), `${gate} was launched programmatically`);
  }
  assert.equal(res.completionAllowed, true);
  assert.equal(completionAllowed(state, DEFAULT_CONFIG), true);
  assert.ok(res.reviewCycles >= 1, "the cycle-closing auditor counted a review cycle");
  assert.deepEqual(res.failed, []);
  // reviewer sessions are cleaned up
  assert.ok(client.aborted.length >= 5);
});

test("a FAILING reviewer keeps completion BLOCKED and is reported (the cycle's Not-Done)", async () => {
  const store = createStore();
  const state = goalState(store, "g2");
  const client = mockReviewClient((agent) => (agent === "goal-verifier" ? "FAIL" : "PASS"));
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, fastOpts);
  assert.equal(res.completionAllowed, false);
  assert.ok(res.failed.includes("goal-verifier"));
  assert.equal(completionAllowed(state, DEFAULT_CONFIG), false);
});

test("the cycle: FAIL → fix(edit) → re-review PASS counts 2 review cycles", async () => {
  const store = createStore();
  const state = goalState(store, "g3");
  // cycle 1: final-auditor FAILs (everything else passes) → blocked, reviewCycles=1
  let r1 = await runReviewCycle(store && mockReviewClient((a) => (a === "goal-final-auditor" ? "FAIL" : "PASS")), store, state, DEFAULT_CONFIG, fastOpts);
  assert.equal(r1.completionAllowed, false);
  assert.equal(state.reviewCycles, 1);
  // the agent "fixes" — a new edit invalidates the prior passes (freshness)
  markEdit(store, state, "fix after review");
  assert.equal(completionAllowed(state, DEFAULT_CONFIG), false);
  // cycle 2: all PASS → allowed, reviewCycles=2
  const r2 = await runReviewCycle(mockReviewClient("PASS"), store, state, DEFAULT_CONFIG, fastOpts);
  assert.equal(r2.completionAllowed, true);
  assert.equal(state.reviewCycles, 2);
});

test("a reviewer that never renders a verdict fails closed (gate stays open)", async () => {
  const store = createStore();
  const state = goalState(store, "g4");
  const client = mockReviewClient(null); // no verdict ever
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, { sleep: async () => {}, pollMs: 1, timeoutMs: 20 });
  assert.equal(res.completionAllowed, false);
  assert.ok(res.failed.length >= 5, "unconcluded reviewers are treated as not-passed");
});

test("reviewerPrompt includes the goal, the verdict instruction, and the reviewer name", () => {
  const store = createStore();
  const state = goalState(store, "g5");
  const p = reviewerPrompt("goal-security-reviewer", state);
  assert.match(p, /Security Reviewer/);
  assert.match(p, /Do x|do x/);
  assert.match(p, /Verdict: PASS/);
  assert.match(p, /Verdict: FAIL/);
});
