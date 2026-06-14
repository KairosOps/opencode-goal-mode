import test from "node:test";
import assert from "node:assert/strict";
import { createGuard } from "../plugins/goal-guard/guard.js";

const noopPersistence = { load: () => null, save: () => {}, flush: () => false, file: "", isDegraded: () => false };

function makeGuard(options = {}) {
  let t = 0;
  return createGuard(
    { client: { app: { log: async () => undefined }, tui: { showToast: async () => undefined } } },
    options,
    { persistence: noopPersistence, clock: () => (t += 1) },
  );
}

/**
 * End-to-end simulation of a realistic goal lifecycle driven entirely through
 * the plugin hooks, asserting the guard blocks completion until the full
 * required-gate matrix passes after the final edit.
 */
test("integration: a security goal cannot complete until every required gate passes", async () => {
  const { hooks, store } = makeGuard();
  const sid = "lifecycle";

  // 1. The user states a security-flavored goal.
  await hooks["chat.params"]({ sessionID: sid, agent: "goal" }, {});
  await hooks["chat.message"](
    { sessionID: sid, agent: "goal" },
    { parts: [{ type: "text", text: "Add token-based auth to the API and migrate the user table." }] },
  );

  // 2. The agent implements (edits + a mutating bash + a verification run).
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: sid, callID: "e1", args: {} }, { output: "", title: "", metadata: {} });
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: sid, callID: "b1", args: { command: "npm install jsonwebtoken" } }, { output: "", title: "", metadata: {} });
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: sid, callID: "b2", args: { command: "npm test" } }, { output: "ok", title: "", metadata: {} });

  const st = store.stateFor(sid);
  assert.equal(st.dirty, true);
  assert.equal(st.verificationSeen, true);

  // 3. Premature completion is blocked, naming the security/api/data gates.
  let out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: sid, messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
  assert.match(out.text, /goal-security-reviewer/);

  // 4. Run base gates only — still blocked because contextual gates are missing.
  for (const agent of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    await hooks["chat.params"]({ sessionID: sid, agent }, {});
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: agent, args: { subagent_type: agent } }, { output: "Verdict: PASS", title: "", metadata: {} });
  }
  out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: sid, messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/, "contextual gates still missing");

  // 5. Run the contextual gates too.
  for (const agent of ["goal-security-reviewer", "goal-api-reviewer", "goal-data-reviewer"]) {
    await hooks["chat.params"]({ sessionID: sid, agent }, {});
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: agent, args: { subagent_type: agent } }, { output: "Verdict: PASS", title: "", metadata: {} });
  }

  // 6. reviewCycles is 1 (final auditor ran once); completion is now allowed.
  out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: sid, messageID: "m", partID: "p" }, out);
  assert.doesNotMatch(out.text, /Goal Not Completed/);
});

test("integration: a fresh edit after a clean review re-blocks completion (stale review)", async () => {
  const { hooks } = makeGuard({ contextualGates: false });
  const sid = "stale-flow";
  await hooks["chat.params"]({ sessionID: sid, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: sid, callID: "e1", args: {} }, { output: "", title: "", metadata: {} });
  for (const agent of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    await hooks["chat.params"]({ sessionID: sid, agent }, {});
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: agent, args: { subagent_type: agent } }, { output: "Verdict: PASS", title: "", metadata: {} });
  }
  // Sneak in a final edit.
  await hooks["chat.params"]({ sessionID: sid, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "write", sessionID: sid, callID: "e2", args: {} }, { output: "", title: "", metadata: {} });

  const out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: sid, messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/);
});

test("integration: file.edited from a subagent child session dirties the active goal", async () => {
  const { hooks, store } = makeGuard({ contextualGates: false });
  const sid = "subagent-edit";
  await hooks["chat.params"]({ sessionID: sid, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: sid, callID: "e1", args: {} }, { output: "", title: "", metadata: {} });
  for (const agent of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    await hooks["chat.params"]({ sessionID: sid, agent }, {});
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: agent, args: { subagent_type: agent } }, { output: "Verdict: PASS", title: "", metadata: {} });
  }
  // A subagent (different session) edits a file — surfaced via the event bus.
  await hooks.event({ event: { type: "file.edited", properties: { file: "src/app.js" } } });

  assert.ok(store.stateFor(sid).changedFiles.includes("src/app.js"));
  const out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: sid, messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/, "the subagent edit must re-open the gates");
});

test("integration: destructive block is recorded and surfaced to the model", async () => {
  const { hooks, store } = makeGuard();
  const sid = "blockflow";
  await hooks["chat.params"]({ sessionID: sid, agent: "goal" }, {});
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: sid, callID: "c" }, { args: { command: "rm -rf node_modules && rm -rf /tmp/$(whoami)" } }),
    /blocked a destructive/i,
  );
  assert.ok(store.stateFor(sid).dirtyReasons.some((r) => r.includes("blocked risky bash")));
});

test("integration: completion enforcement can be turned off", async () => {
  const { hooks } = makeGuard({ enforceCompletion: false });
  await hooks["chat.params"]({ sessionID: "off", agent: "goal" }, {});
  const out = { text: "Goal Completed\n\nReview cycles: 0" };
  await hooks["experimental.text.complete"]({ sessionID: "off", messageID: "m", partID: "p" }, out);
  assert.doesNotMatch(out.text, /Goal Not Completed/);
});

test("integration: hooks never throw on malformed input", async () => {
  const { hooks } = makeGuard();
  await assert.doesNotReject(async () => {
    await hooks["chat.message"]({}, {});
    await hooks["chat.params"]({}, {});
    await hooks["experimental.chat.system.transform"]({}, {});
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "z" }, {});
    await hooks["experimental.text.complete"]({ sessionID: "z" }, {});
    await hooks["experimental.session.compacting"]({ sessionID: "z" }, { context: [] });
    await hooks.event({});
    await hooks.event({ event: { type: "unknown" } });
    await hooks.dispose();
  });
});
