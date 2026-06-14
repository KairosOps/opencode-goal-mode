import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../plugins/goal-guard.js";

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
  await hooks["chat.params"]({ sessionID, agent }, {});
  await hooks["tool.execute.after"](
    { tool: "bash", sessionID, callID: agent, args: { command: "git status" } },
    { output: `Verdict: ${verdict}`, title: "", metadata: {} },
  );
}

test("a recorded review verdict toasts PASS as success and FAIL as warning", async () => {
  const { hooks, toasts } = makeGuard();
  await hooks["chat.params"]({ sessionID: "s", agent: "goal" }, {});
  await recordVerdict(hooks, "s", "goal-security-reviewer", "FAIL");
  await recordVerdict(hooks, "s", "goal-security-reviewer", "PASS");

  const fail = toasts.find((x) => /goal-security-reviewer → FAIL/.test(x.message));
  const pass = toasts.find((x) => /goal-security-reviewer → PASS/.test(x.message));
  assert.ok(fail && fail.variant === "warning", "FAIL toast is a warning");
  assert.ok(pass && pass.variant === "success", "PASS toast is a success");
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
