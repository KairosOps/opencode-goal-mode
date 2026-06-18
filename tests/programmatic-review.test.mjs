import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../plugins/goal-guard/guard.js";
import { completionAllowed } from "../plugins/goal-guard/gates.js";

const noopPersistence = { load: () => null, save: () => {}, flush: () => false, file: "", isDegraded: () => false };

/** Build a guard whose client CAN review (session.create/promptAsync/messages),
 * with reviewer sessions returning a Verdict per agent. Captures every prompt. */
function makeReviewingGuard(verdictFor, opts = {}) {
  let t = 1000;
  let n = 0;
  const agentOf = new Map();
  const prompts = [];
  const client = {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      create: async () => ({ data: { id: `rs${++n}` } }),
      promptAsync: async ({ path, body }) => {
        if (body?.agent) agentOf.set(path.id, body.agent);
        prompts.push({ id: path.id, agent: body?.agent, text: body?.parts?.[0]?.text || "" });
      },
      messages: async ({ path }) => {
        const agent = agentOf.get(path.id);
        const v = typeof verdictFor === "function" ? verdictFor(agent) : verdictFor;
        return { data: [{ info: { role: "assistant", agent }, parts: [{ type: "text", text: `Reviewed.\nVerdict: ${v}` }] }] };
      },
      abort: async () => {},
    },
  };
  const guard = __test.createGuard(
    { client },
    { abortGraceMs: 0, reviewPollMs: 2, reviewTimeoutMs: 1000, ...opts },
    { persistence: noopPersistence, clock: () => (t += 1) },
  );
  return { guard, prompts, client };
}

const MODEL = { providerID: "opencode", modelID: "deepseek-v4-flash-free" };

async function startGoalWithWork(hooks) {
  await hooks["chat.params"]({ sessionID: "g", agent: "goal", model: MODEL }, {});
  await hooks["chat.message"]({ sessionID: "g", agent: "goal", model: MODEL }, { parts: [{ type: "text", text: "implement and verify the feature" }] });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "g", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
}

test("on idle, the GUARD CODE launches the required reviewers itself (not the agent) and completion opens when all PASS", async () => {
  const { guard, prompts } = makeReviewingGuard("PASS");
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  const reviewerLaunches = prompts.filter((p) => p.agent && /^goal-.*(reviewer|auditor|verifier|guard)/.test(p.agent));
  for (const gate of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    assert.ok(reviewerLaunches.some((p) => p.agent === gate), `guard programmatically launched ${gate}`);
  }
  const state = guard.store.stateFor("g");
  assert.equal(completionAllowed(state, guard.config), true, "all gates passed → completion allowed");
  assert.ok(state.reviewCycles >= 1, "a review cycle was counted");
  // and the agent is told it may finish, with the accurate cycle count
  assert.ok(prompts.some((p) => !p.agent || p.agent === undefined ? /Review cycles: \d+/.test(p.text) : false) || prompts.some((p) => /All required reviews PASSED/.test(p.text)));
});

test("on idle with a FAILING reviewer, the guard keeps completion blocked and feeds findings back (the cycle's Not-Done)", async () => {
  const { guard, prompts } = makeReviewingGuard((a) => (a === "goal-verifier" ? "FAIL" : "PASS"));
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  const state = guard.store.stateFor("g");
  assert.equal(completionAllowed(state, guard.config), false, "a failing reviewer blocks completion");
  // the agent is handed the failure to fix (not told it's complete)
  assert.ok(prompts.some((p) => /blocking issues|must fix|Failing reviewers/i.test(p.text)), "guard fed the blocking findings back to the agent");
});

test("the model is captured from chat.params so the reviewers can be launched", async () => {
  // Without a captured model the guard can't launch reviewers — prove capture works.
  const { guard, prompts } = makeReviewingGuard("PASS");
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  const launched = prompts.filter((p) => p.agent && p.agent.startsWith("goal-"));
  assert.ok(launched.length > 0, "reviewers launched → model was captured & used");
  assert.equal(launched[0].agent && true, true);
});
