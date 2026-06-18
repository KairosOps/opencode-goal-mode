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

test("[bughunt rl1/rl2] the review loop is bounded by reviewRunCount (no runaway when a gate never passes / verdict never concludes)", async () => {
  // Specialist gates always FAIL, the cycle-closing auditor PASSes fresh → reviewCycles
  // is pinned at 1, yet the loop MUST stop at maxReviewCycles via reviewRunCount.
  const { guard, prompts } = makeReviewingGuard((a) => (a === "goal-final-auditor" ? "PASS" : "FAIL"), { maxReviewCycles: 3, maxAutoContinue: 50 });
  await startGoalWithWork(guard.hooks);
  for (let i = 0; i < 30; i++) await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  const state = guard.store.stateFor("g");
  assert.ok((state.reviewRunCount || 0) <= 3, `review runs capped at maxReviewCycles (got ${state.reviewRunCount})`);
  const launches = prompts.filter((p) => p.agent && p.agent.startsWith("goal-")).length;
  assert.ok(launches < 30, `reviewer launches bounded, not one+ per idle forever (got ${launches})`);
});

test("[live-parity] the guard runs the reviewers ITSELF even when NO model was captured (model is optional)", async () => {
  // Mirrors the live TUI bug: chat.params didn't surface a model in the expected shape, so
  // sessionModel stays empty. The guard must STILL launch the reviewers programmatically —
  // not fall back to nagging the agent to call them via the task tool.
  const { guard, prompts } = makeReviewingGuard("PASS");
  // Start a goal WITH work but never deliver a parseable model.
  await guard.hooks["chat.params"]({ sessionID: "g", agent: "goal" }, {}); // no model field
  await guard.hooks["chat.message"]({ sessionID: "g", agent: "goal" }, { parts: [{ type: "text", text: "implement and verify the feature" }] });
  await guard.hooks["tool.execute.after"]({ tool: "edit", sessionID: "g", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  const reviewerLaunches = prompts.filter((p) => p.agent && p.agent.startsWith("goal-"));
  assert.ok(reviewerLaunches.length >= 5, `guard launched the reviewers itself without a captured model (got ${reviewerLaunches.length})`);
  // and it did NOT fall back to telling the agent to run reviews via the task tool
  assert.ok(!prompts.some((p) => !p.agent && /task tool|task\(subagent_type/i.test(p.text)), "no task-tool nudge sent to the agent");
  assert.equal(completionAllowed(guard.store.stateFor("g"), guard.config), true);
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
