import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../plugins/goal-guard/guard.js";
import { prettyAgentName } from "../plugins/goal-guard/agents.js";

test("prettyAgentName de-hyphenates, drops the goal- prefix, and keeps acronyms", () => {
  assert.equal(prettyAgentName("goal-security-reviewer"), "Security Reviewer");
  assert.equal(prettyAgentName("goal-final-auditor"), "Final Auditor");
  assert.equal(prettyAgentName("goal-api-reviewer"), "API Reviewer");
  assert.equal(prettyAgentName("goal-ux-reviewer"), "UX Reviewer");
  assert.equal(prettyAgentName("goal-diff-reviewer"), "Diff Reviewer");
  assert.equal(prettyAgentName(""), "");
});

const noopPersistence = { load: () => null, save: () => {}, flush: () => false, file: "", isDegraded: () => false };

/** Build a guard whose client captures every toast that fires. */
function makeGuard(extra = {}) {
  const toasts = [];
  let t = 1_000;
  const clock = () => (t += 1);
  const client = {
    app: { log: async () => undefined },
    tui: { showToast: async (req) => toasts.push(req?.body || req) },
  };
  const guard = __test.createGuard({ client }, extra.options || {}, { persistence: noopPersistence, clock });
  return { ...guard, toasts };
}

async function recordVerdict(hooks, sessionID, agent, verdict) {
  // Reviewers report via the task tool against the (goal) parent session — recording
  // a verdict must not switch the parent's agent, which would deactivate the goal.
  await hooks["tool.execute.after"](
    { tool: "task", sessionID, callID: agent, args: { subagent_type: agent } },
    { output: `Verdict: ${verdict}`, title: "", metadata: {} },
  );
}

test("a recorded review verdict toasts PASS as success and FAIL as warning, with a pretty name", async () => {
  const { hooks, toasts } = makeGuard();
  await hooks["chat.params"]({ sessionID: "s", agent: "goal" }, {});
  await recordVerdict(hooks, "s", "goal-security-reviewer", "FAIL");
  await recordVerdict(hooks, "s", "goal-security-reviewer", "PASS");

  const fail = toasts.find((x) => x.message === "Security Reviewer → FAIL");
  const pass = toasts.find((x) => x.message === "Security Reviewer → PASS");
  assert.ok(fail && fail.variant === "warning", "FAIL toast is a warning with the pretty name");
  assert.ok(pass && pass.variant === "success", "PASS toast is a success with the pretty name");
  // No raw hyphenated id leaks into the toast.
  assert.ok(!toasts.some((x) => /goal-security-reviewer/.test(x.message)), "no raw agent id in toasts");
});

test("completion-unlocked toast fires once when the last required gate clears", async () => {
  const { hooks, toasts } = makeGuard();
  await hooks["chat.params"]({ sessionID: "s", agent: "goal" }, {});
  const gates = ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"];
  for (const g of gates) await recordVerdict(hooks, "s", g, "PASS");

  const unlocked = toasts.filter((x) => /completion unlocked/.test(x.message));
  assert.equal(unlocked.length, 1, "unlocked toast fires exactly once");
  assert.equal(unlocked[0].variant, "success");
});

test("toastOnReview=false suppresses review toasts", async () => {
  const { hooks, toasts } = makeGuard({ options: { toastOnReview: false } });
  await hooks["chat.params"]({ sessionID: "s", agent: "goal" }, {});
  await recordVerdict(hooks, "s", "goal-verifier", "PASS");
  assert.equal(toasts.filter((x) => /goal-verifier/.test(x.message)).length, 0);
});
