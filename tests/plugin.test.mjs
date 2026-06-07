import test from "node:test";
import assert from "node:assert/strict";
import plugin, { __test } from "../plugins/goal-guard.js";

const noopPersistence = { load: () => null, save: () => {}, flush: () => false, file: "", isDegraded: () => false };

/** Build a guard with disk persistence disabled and a deterministic clock. */
function makeGuard(extra = {}) {
  let t = 1_000;
  const clock = () => (t += 1);
  return __test.createGuard(
    { client: { app: { log: async () => undefined }, tui: { showToast: async () => undefined } } },
    {},
    { persistence: noopPersistence, clock, ...extra },
  );
}

async function passAllBaseGates(hooks, store, sessionID) {
  for (const agent of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    await hooks["chat.params"]({ sessionID, agent }, {});
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID, callID: agent, args: { command: "git status" } },
      { output: "Verdict: PASS", title: "", metadata: {} },
    );
  }
}

// ---------------------------------------------------------------------------
// Destructive blocking
// ---------------------------------------------------------------------------

test("blocks destructive bash before execution and the model sees the reason", async () => {
  const { hooks } = makeGuard();
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "git clean -fd" } }),
    /blocked a destructive/i,
  );
});

test("blocks bypass attempts that evaded the old regexes", async () => {
  const { hooks } = makeGuard();
  for (const command of ["$(rm -rf /tmp/x)", "bash -c 'rm -rf /tmp/x'", "/bin/rm -rf /tmp/x", "git -C /r reset --hard"]) {
    await assert.rejects(
      () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command } }),
      /blocked/i,
      command,
    );
  }
});

test("does not block safe commands", async () => {
  const { hooks } = makeGuard();
  await assert.doesNotReject(() =>
    hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "git checkout -b feature" } }),
  );
});

test("blocking can be disabled via config", async () => {
  const guard = __test.createGuard({ client: {} }, { blockDestructive: false }, { persistence: noopPersistence });
  await assert.doesNotReject(() =>
    guard.hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "rm -rf /tmp/x" } }),
  );
});

// ---------------------------------------------------------------------------
// Dirty tracking
// ---------------------------------------------------------------------------

test("write/edit/apply_patch mark the session dirty", async () => {
  const { hooks, store } = makeGuard();
  for (const tool of ["write", "edit", "apply_patch"]) {
    const sessionID = `dirty-${tool}`;
    await hooks["tool.execute.after"]({ tool, sessionID, callID: "c", args: {} }, { output: "", title: "", metadata: {} });
    const st = store.stateFor(sessionID);
    assert.equal(st.dirty, true);
    assert.ok(st.lastEditSeq > 0);
  }
});

test("read-only bash does not mark the session dirty", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "ro", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ro", callID: "c", args: { command: "cat README.md" } }, { output: "", title: "", metadata: {} });
  const st = store.stateFor("ro");
  assert.equal(st.dirty, false);
  assert.equal(st.lastEditSeq, 0);
});

test("mutating bash marks the session dirty", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "mut", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "mut", callID: "c", args: { command: "npm install" } }, { output: "", title: "", metadata: {} });
  assert.equal(store.stateFor("mut").dirty, true);
});

test("a reviewer running a mutation does not dirty the session", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "rev", agent: "goal-reviewer" }, {});
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "rev", callID: "c", args: { command: "npm install" } }, { output: "", title: "", metadata: {} });
  assert.equal(store.stateFor("rev").dirty, false);
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

test("verification command sets verificationSeen", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "v", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: "v", callID: "c", args: { command: "npm test" } }, { output: "", title: "", metadata: {} });
  const st = store.stateFor("v");
  assert.equal(st.verificationSeen, true);
  assert.ok(st.lastVerificationSeq > 0);
});

// ---------------------------------------------------------------------------
// Verdict capture
// ---------------------------------------------------------------------------

test("task tool captures a subagent PASS verdict", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "t", agent: "goal" }, {});
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "t", callID: "c", args: { subagent_type: "goal-reviewer", prompt: "Review" } },
    { output: "<task><task_result>All good. Verdict: PASS</task_result></task>", title: "", metadata: {} },
  );
  assert.equal(store.stateFor("t").verdicts.some((v) => v.agent === "goal-reviewer" && v.verdict === "PASS"), true);
});

test("task tool captures a subagent FAIL verdict", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "tf", agent: "goal" }, {});
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "tf", callID: "c", args: { subagent_type: "goal-final-auditor", prompt: "Audit" } },
    { output: "Verdict: FAIL", title: "", metadata: {} },
  );
  assert.equal(store.stateFor("tf").verdicts.some((v) => v.agent === "goal-final-auditor" && v.verdict === "FAIL"), true);
});

test("last verdict wins (previously FAIL, now PASS records PASS)", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "lw", agent: "goal" }, {});
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "lw", callID: "c", args: { subagent_type: "goal-reviewer" } },
    { output: "Initial pass found issues. Verdict: FAIL\nAfter fixes confirmed. Verdict: PASS", title: "", metadata: {} },
  );
  assert.equal(store.stateFor("lw").latestVerdict["goal-reviewer"].verdict, "PASS");
});

test("final auditor verdict increments the review cycle count", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "fc", agent: "goal" }, {});
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "fc", callID: "c", args: { subagent_type: "goal-final-auditor" } },
    { output: "Verdict: PASS", title: "", metadata: {} },
  );
  assert.equal(store.stateFor("fc").reviewCycles, 1);
});

// ---------------------------------------------------------------------------
// Completion enforcement
// ---------------------------------------------------------------------------

test("completion blocked when Review cycles line is missing", async () => {
  const { hooks } = makeGuard();
  await hooks["chat.params"]({ sessionID: "m1", agent: "goal" }, {});
  const out = { text: "Goal Completed\n\nDone." };
  await hooks["experimental.text.complete"]({ sessionID: "m1", messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
  assert.match(out.text, /missing required Review cycles line/i);
});

test("completion blocked when zero cycles recorded", async () => {
  const { hooks } = makeGuard();
  await hooks["chat.params"]({ sessionID: "m2", agent: "goal" }, {});
  const out = { text: "Goal Completed\n\nReview cycles: 0" };
  await hooks["experimental.text.complete"]({ sessionID: "m2", messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
  assert.match(out.text, /no review cycles recorded/i);
});

test("completion blocked when claimed cycles do not match recorded", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "m3", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "m3", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await passAllBaseGates(hooks, store, "m3");
  const out = { text: "Goal Completed\n\nReview cycles: 2" };
  await hooks["experimental.text.complete"]({ sessionID: "m3", messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
  assert.match(out.text, /do not match recorded/i);
});

test("completion blocked when dirty with no reviews", async () => {
  const { hooks } = makeGuard();
  await hooks["chat.params"]({ sessionID: "m4", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "m4", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  const out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: "m4", messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
});

test("completion allowed only after all required gates pass after the edit", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "ok", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "ok", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await passAllBaseGates(hooks, store, "ok");
  const out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: "ok", messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Completed/);
  assert.doesNotMatch(out.text, /Goal Not Completed/);
});

test("a later edit makes prior reviews stale and re-blocks completion", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "stale", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "stale", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await passAllBaseGates(hooks, store, "stale");
  // A new edit after the reviews:
  await hooks["chat.params"]({ sessionID: "stale", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "stale", callID: "c2", args: {} }, { output: "", title: "", metadata: {} });
  const out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: "stale", messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
});

test("completion claim in a non-goal session is left untouched", async () => {
  const { hooks } = makeGuard();
  const out = { text: "Goal Completed by the previous engineer, per the ticket." };
  await hooks["experimental.text.complete"]({ sessionID: "non-goal", messageID: "m", partID: "p" }, out);
  assert.doesNotMatch(out.text, /Goal Not Completed/);
});

// ---------------------------------------------------------------------------
// Contextual gates (previously dead code)
// ---------------------------------------------------------------------------

test("a security goal requires the security reviewer before completion", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "sec", agent: "goal" }, {});
  await hooks["chat.message"]({ sessionID: "sec", agent: "goal" }, { parts: [{ type: "text", text: "rotate the auth token and fix the permission check" }] });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "sec", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await passAllBaseGates(hooks, store, "sec");
  const out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: "sec", messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
  assert.match(out.text, /goal-security-reviewer/);
});

test("whole-word gating: 'capital' does not pull in the api reviewer", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "cap", agent: "goal" }, {});
  await hooks["chat.message"]({ sessionID: "cap", agent: "goal" }, { parts: [{ type: "text", text: "capitalize the headings in the capital city report" }] });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "cap", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await passAllBaseGates(hooks, store, "cap");
  const out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: "cap", messageID: "m", partID: "p" }, out);
  assert.doesNotMatch(out.text, /Goal Not Completed/);
});

// ---------------------------------------------------------------------------
// System-prompt injection
// ---------------------------------------------------------------------------

test("system transform injects live state only for active goal sessions", async () => {
  const { hooks } = makeGuard();
  const inactive = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "x", model: {} }, inactive);
  assert.equal(inactive.system.length, 0);

  await hooks["chat.params"]({ sessionID: "y", agent: "goal" }, {});
  const active = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "y", model: {} }, active);
  assert.equal(active.system.length, 1);
  assert.match(active.system[0], /Goal Guard — live enforcement state/);
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

test("compaction preserves concrete live state values", async () => {
  const { hooks, store } = makeGuard();
  await hooks["chat.params"]({ sessionID: "comp", agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "comp", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await hooks["tool.execute.after"](
    { tool: "task", sessionID: "comp", callID: "c2", args: { subagent_type: "goal-final-auditor" } },
    { output: "Verdict: PASS", title: "", metadata: {} },
  );
  const out = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: "comp" }, out);
  const joined = out.context.join("\n");
  assert.match(joined, /Goal Guard state/);
  assert.match(joined, /reviewCycles=1/);
  assert.match(joined, /Review Ledger/);
  void store;
});

// ---------------------------------------------------------------------------
// Custom tools
// ---------------------------------------------------------------------------

test("default export registers the goal_* tools", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  assert.ok(hooks.tool);
  for (const name of ["goal_status", "goal_contract", "goal_evidence", "goal_reset"]) {
    assert.equal(typeof hooks.tool[name].execute, "function", `${name} missing`);
  }
});

test("goal_contract records a contract and activates enforcement", async () => {
  const guard = makeGuard();
  const { createGoalTools } = await import("../plugins/goal-guard/tools.js");
  const tools = createGoalTools({ store: guard.store, config: guard.config, persist: guard.persist });
  const res = await tools.goal_contract.execute(
    { original: "add an auth endpoint", acceptanceCriteria: ["login works", "tokens expire"] },
    { sessionID: "ct" },
  );
  assert.match(res.output, /goal-security-reviewer|goal-api-reviewer/);
  const st = guard.store.stateFor("ct");
  assert.equal(st.active, true);
  assert.equal(st.contract.acceptanceCriteria.length, 2);
});

test("goal_status returns structured status", async () => {
  const guard = makeGuard();
  const { createGoalTools } = await import("../plugins/goal-guard/tools.js");
  const tools = createGoalTools({ store: guard.store, config: guard.config, persist: guard.persist });
  await guard.hooks["chat.params"]({ sessionID: "stx", agent: "goal" }, {});
  const res = await tools.goal_status.execute({}, { sessionID: "stx" });
  const report = JSON.parse(res.output);
  assert.equal(report.active, true);
  assert.ok(Array.isArray(report.requiredGates));
});

// ---------------------------------------------------------------------------
// Store: eviction and isolation
// ---------------------------------------------------------------------------

test("eviction keeps the cache at the configured limit and prefers idle sessions", () => {
  const store = __test.createStore({ maxSessions: 10 });
  // Touch an active session first, then fill with idle ones.
  const keep = store.stateFor("active-keep");
  keep.active = true;
  for (let i = 0; i < 30; i += 1) store.stateFor(`idle-${i}`);
  assert.ok(store.size() <= 10);
  assert.ok(store.sessions.has("active-keep"), "active session must survive eviction");
});

test("two guard instances do not share state", () => {
  const a = makeGuard();
  const b = makeGuard();
  a.store.stateFor("shared").dirty = true;
  assert.equal(b.store.stateFor("shared").dirty, false);
});
