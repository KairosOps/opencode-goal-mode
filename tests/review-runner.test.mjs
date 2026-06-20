import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../plugins/goal-guard/state.js";
import { markEdit } from "../plugins/goal-guard/events.js";
import { DEFAULT_CONFIG } from "../plugins/goal-guard/config.js";
import { completionAllowed } from "../plugins/goal-guard/gates.js";
import { runReviewCycle, clientCanReview, ensureReviewClient, reviewerPrompt } from "../plugins/goal-guard/review-runner.js";
import { parseVerdict } from "../plugins/goal-guard/verdicts.js";

/** Mock client: subtasks on the goal session surface as completed `task` tool parts. */
function mockReviewClient(verdictFor, sessionID = "goal-session") {
  const launched = [];
  let currentAgent = null;
  const polls = new Map();
  return {
    launched,
    sessionID,
    session: {
      promptAsync: async ({ path, body }) => {
        assert.equal(path.id, sessionID, "review subtasks run on the parent goal session");
        for (const part of body?.parts || []) {
          if (part.type === "subtask") {
            currentAgent = part.agent;
            launched.push(part.agent);
          }
        }
      },
      messages: async () => {
        const agent = currentAgent;
        const p = polls.get(agent) || 0;
        polls.set(agent, p + 1);
        const v = typeof verdictFor === "function" ? verdictFor(agent) : verdictFor;
        const text = v ? `Reviewed the changes.\n\nVerdict: ${v}` : "I could not reach a conclusion.";
        const parts = launched.map((a) => {
          const verdict = typeof verdictFor === "function" ? verdictFor(a) : verdictFor;
          const out = verdict ? `Reviewed the changes.\n\nVerdict: ${verdict}` : "I could not reach a conclusion.";
          return {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: a, agent: a },
              output: a === agent ? text : out,
            },
          };
        });
        return { data: [{ info: { role: "assistant" }, parts }] };
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

const fastOpts = (sessionID) => ({ sessionID, sleep: async () => {}, pollMs: 1, timeoutMs: 500 });

test("ensureReviewClient adds HTTP promptAsync when the plugin client is trimmed", () => {
  const client = ensureReviewClient({ app: {} }, "http://127.0.0.1:4096");
  assert.equal(clientCanReview(client), true);
  assert.equal(typeof client.session.promptAsync, "function");
});

test("clientCanReview detects the required client surface", () => {
  assert.equal(clientCanReview({ session: { promptAsync() {} } }), true);
  assert.equal(clientCanReview({ session: { promptAsync() {}, messages() {} } }), true);
  assert.equal(clientCanReview({ app: {}, tui: {} }), false);
  assert.equal(clientCanReview(null), false);
});

test("runReviewCycle programmatically launches ALL required reviewers as subtasks and records PASS → completion allowed", async () => {
  const store = createStore();
  const sid = "g1";
  const state = goalState(store, sid);
  const client = mockReviewClient("PASS", sid);
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, fastOpts(sid));
  // every BASE gate was launched by the CODE (not the agent)
  for (const gate of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    assert.ok(client.launched.includes(gate), `${gate} was launched programmatically as a subtask`);
  }
  assert.equal(res.completionAllowed, true);
  assert.equal(completionAllowed(state, DEFAULT_CONFIG), true);
  assert.ok(res.reviewCycles >= 1, "the cycle-closing auditor counted a review cycle");
  assert.deepEqual(res.failed, []);
});

test("a clean programmatic cycle clears the dirty flag (parity with the agent-driven path); a FAIL leaves it dirty", async () => {
  const clean = createStore();
  const sid = "dc-pass";
  const sClean = goalState(clean, sid);
  assert.equal(sClean.dirty, true, "work made the goal dirty");
  await runReviewCycle(mockReviewClient("PASS", sid), clean, sClean, DEFAULT_CONFIG, fastOpts(sid));
  assert.equal(sClean.dirty, false, "a clean final pass clears dirty");
  const dirty = createStore();
  const sidFail = "dc-fail";
  const sDirty = goalState(dirty, sidFail);
  await runReviewCycle(mockReviewClient((a) => (a === "goal-verifier" ? "FAIL" : "PASS"), sidFail), dirty, sDirty, DEFAULT_CONFIG, fastOpts(sidFail));
  assert.equal(sDirty.dirty, true, "a failing cycle leaves the goal dirty");
});

test("a FAILING reviewer keeps completion BLOCKED and is reported (the cycle's Not-Done)", async () => {
  const store = createStore();
  const sid = "g2";
  const state = goalState(store, sid);
  const client = mockReviewClient((agent) => (agent === "goal-verifier" ? "FAIL" : "PASS"), sid);
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, fastOpts(sid));
  assert.equal(res.completionAllowed, false);
  assert.ok(res.failed.includes("goal-verifier"));
  assert.equal(completionAllowed(state, DEFAULT_CONFIG), false);
});

test("the cycle: FAIL → fix(edit) → re-review PASS counts 2 review cycles", async () => {
  const store = createStore();
  const sid = "g3";
  const state = goalState(store, sid);
  let r1 = await runReviewCycle(mockReviewClient((a) => (a === "goal-final-auditor" ? "FAIL" : "PASS"), sid), store, state, DEFAULT_CONFIG, fastOpts(sid));
  assert.equal(r1.completionAllowed, false);
  assert.equal(state.reviewCycles, 1);
  markEdit(store, state, "fix after review");
  assert.equal(completionAllowed(state, DEFAULT_CONFIG), false);
  const r2 = await runReviewCycle(mockReviewClient("PASS", sid), store, state, DEFAULT_CONFIG, fastOpts(sid));
  assert.equal(r2.completionAllowed, true);
  assert.equal(state.reviewCycles, 2);
});

test("a reviewer that never renders a verdict fails closed (gate stays open)", async () => {
  const store = createStore();
  const sid = "g4";
  const state = goalState(store, sid);
  const client = mockReviewClient(null, sid);
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, { sessionID: sid, sleep: async () => {}, pollMs: 1, timeoutMs: 20 });
  assert.equal(res.completionAllowed, false);
  assert.ok(res.failed.length >= 5, "unconcluded reviewers are treated as not-passed");
});

test("[bughunt rl3] parseVerdict ignores a quoted/example verdict and uses the real conclusion", () => {
  assert.equal(parseVerdict('Findings: plaintext password.\n\nVerdict: FAIL\n\n(a clean run ends with "> Verdict: PASS".)'), "FAIL");
  assert.equal(parseVerdict("Verdict: FAIL\nFor reference, end with `Verdict: PASS`."), "FAIL");
  assert.equal(parseVerdict("First pass: Verdict: FAIL\nAfter fixes confirmed: Verdict: PASS"), "PASS");
});

test("[bughunt rl5] a failed subtask launch is handled without aborting the goal session", async () => {
  const sid = "leak";
  const client = {
    session: {
      promptAsync: async () => {
        throw new Error("boom");
      },
      messages: async () => ({ data: [] }),
    },
  };
  const store = createStore();
  const state = goalState(store, sid);
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, fastOpts(sid));
  assert.equal(res.completionAllowed, false);
  assert.ok(res.failed.length >= 1, "prompt failure fails closed for that reviewer");
});

test("promptSubtaskWithRetry tolerates SessionBusy then succeeds", async () => {
  const sid = "busy";
  let attempts = 0;
  let currentAgent = null;
  const client = {
    session: {
      promptAsync: async ({ body }) => {
        attempts += 1;
        if (attempts < 3) {
          const err = new Error("SessionBusyError");
          err.name = "SessionBusyError";
          throw err;
        }
        for (const part of body?.parts || []) {
          if (part.type === "subtask") currentAgent = part.agent;
        }
      },
      messages: async () => ({
        data: [
          {
            info: { role: "assistant", agent: currentAgent },
            parts: [{ type: "tool", tool: "task", state: { status: "completed", input: { subagent_type: currentAgent }, output: "Verdict: PASS" } }],
          },
        ],
      }),
    },
  };
  const store = createStore();
  const state = goalState(store, sid);
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, { ...fastOpts(sid), sleep: async () => {} });
  assert.ok(attempts >= 3, "retried SessionBusy before launching reviewer");
  assert.ok(res.passed.length >= 1, "review succeeded after SessionBusy cleared");
});

test("[bughunt rl4] runReviewer waits for the reviewer to finish — an interim PASS is not latched over the final FAIL", async () => {
  const sid = "stream";
  const seq = [
    "Analyzing… Verdict: PASS (tentative)",
    "Analyzing… Verdict: PASS (tentative). Wait—",
    "Found a blocker.\nVerdict: FAIL",
    "Found a blocker.\nVerdict: FAIL",
  ];
  let currentAgent = null;
  const polls = new Map();
  const client = {
    session: {
      promptAsync: async ({ body }) => {
        for (const part of body?.parts || []) {
          if (part.type === "subtask") currentAgent = part.agent;
        }
      },
      messages: async () => {
        const p = polls.get(currentAgent) || 0;
        polls.set(currentAgent, p + 1);
        const text = seq[Math.min(p, seq.length - 1)];
        return {
          data: [
            {
              parts: [
                {
                  type: "tool",
                  tool: "task",
                  state: {
                    status: "completed",
                    input: { subagent_type: currentAgent },
                    output: text,
                  },
                },
              ],
            },
          ],
        };
      },
    },
  };
  const store = createStore();
  const state = goalState(store, sid);
  const res = await runReviewCycle(client, store, state, DEFAULT_CONFIG, { sessionID: sid, sleep: async () => {}, pollMs: 1, timeoutMs: 1000 });
  assert.equal(res.completionAllowed, false, "the final FAIL wins; the mid-stream PASS must not be latched");
  assert.equal(state.latestVerdict["goal-final-auditor"].verdict, "FAIL");
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
