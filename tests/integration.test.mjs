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
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid, callID: agent, args: { subagent_type: agent } }, { output: "Verdict: PASS", title: "", metadata: {} });
  }
  out = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: sid, messageID: "m", partID: "p" }, out);
  assert.match(out.text, /Goal Not Completed/, "contextual gates still missing");

  // 5. Run the contextual gates too.
  for (const agent of ["goal-security-reviewer", "goal-api-reviewer", "goal-data-reviewer"]) {
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

function makeContinueGuard(opts = {}) {
  const prompts = [];
  let t = 0;
  const guard = createGuard(
    {
      client: {
        app: { log: async () => undefined },
        tui: { showToast: async () => undefined },
        session: { promptAsync: async (a) => { prompts.push(a); } },
      },
    },
    { abortGraceMs: 60, ...opts },
    { persistence: noopPersistence, clock: () => (t += 1) },
  );
  return { ...guard, prompts };
}
async function startGoal(hooks, sid) {
  await hooks["chat.params"]({ sessionID: sid, agent: "goal" }, {});
  await hooks["chat.message"]({ sessionID: sid, agent: "goal" }, { parts: [{ type: "text", text: "Add a feature and prove it works." }] });
}
const idleEv = (sid) => ({ event: { type: "session.idle", properties: { sessionID: sid } } });
const abortEv = (sid) => ({ event: { type: "session.error", properties: { sessionID: sid, error: { name: "MessageAbortedError", data: { message: "Aborted" } } } } });

test("integration: an incomplete idle auto-continues (baseline)", async () => {
  const { hooks, prompts } = makeContinueGuard();
  const sid = "baseline";
  await startGoal(hooks, sid);
  await hooks.event(idleEv(sid));
  assert.equal(prompts.length, 1, "an incomplete goal that idles is sent onward");
});

test("integration: cancel BEFORE idle (error-first) suppresses auto-continue", async () => {
  const { hooks, store, prompts } = makeContinueGuard();
  const sid = "error-first";
  await startGoal(hooks, sid);
  await hooks.event(abortEv(sid));
  assert.equal(store.stateFor(sid).abortedAt > 0, true, "abort flagged programmatically");
  await hooks.event(idleEv(sid));
  assert.equal(prompts.length, 0, "a cancelled turn must NOT send a continuation prompt");
  assert.equal(store.stateFor(sid).abortedAt > 0, true, "the flag is NOT consumed — later idles stay suppressed too");
});

test("integration: ONE cancel suppresses MULTIPLE idles (a cancel emits >1 session.idle)", async () => {
  // Regression: live OpenCode emits two session.idle events per abort. Consuming the
  // flag on the first left the second free to auto-continue — the actual bug.
  const { hooks, prompts } = makeContinueGuard();
  const sid = "double-idle";
  await startGoal(hooks, sid);
  await hooks.event(abortEv(sid));
  await hooks.event(idleEv(sid)); // idle #1
  await hooks.event(idleEv(sid)); // idle #2 (the one that used to slip through)
  await hooks.event(idleEv(sid)); // and any further idles
  assert.equal(prompts.length, 0, "every idle after a single cancel must stay suppressed");
});

test("integration: cancel arriving DURING the idle grace (idle-first) still suppresses", async () => {
  // The real live ordering: session.idle reaches the plugin first, and the cancel's
  // session.error lands a few ms later. The grace window must catch it.
  const { hooks, prompts } = makeContinueGuard({ abortGraceMs: 200 });
  const sid = "idle-first";
  await startGoal(hooks, sid);
  const idleP = hooks.event(idleEv(sid)); // starts the grace; do NOT await yet
  await new Promise((r) => setTimeout(r, 40));
  await hooks.event(abortEv(sid)); // cancel lands during the grace
  await idleP;
  assert.equal(prompts.length, 0, "a cancel during the grace window must suppress the continuation");
});

test("integration: a user RESUME (new turn) clears the cancel and auto-continue returns", async () => {
  const { hooks, store, prompts } = makeContinueGuard();
  const sid = "resume";
  await startGoal(hooks, sid);
  await hooks.event(abortEv(sid));
  await hooks.event(idleEv(sid)); // suppressed
  await hooks.event(idleEv(sid)); // still suppressed
  assert.equal(prompts.length, 0);

  // The user resumes by sending a new message — the cancel is cleared.
  await hooks["chat.message"]({ sessionID: sid, agent: "goal" }, { parts: [{ type: "text", text: "keep going" }] });
  assert.equal(store.stateFor(sid).abortedAt, 0, "a new user turn clears the pending cancel");
  await hooks.event(idleEv(sid)); // goal still incomplete → resumes
  assert.equal(prompts.length, 1, "normal 'never stop incomplete' behaviour returns after a real resume");
});

test("integration: overlapping idles (no abort) are coalesced — exactly ONE continuation", async () => {
  // The grace sleep made the idle handler re-entrant; two idles arriving within the
  // grace must NOT each fire a continuation or double-advance the backstop counters.
  const { hooks, store, prompts } = makeContinueGuard({ abortGraceMs: 80 });
  const sid = "coalesce";
  await startGoal(hooks, sid);
  const a = hooks.event(idleEv(sid)); // enters the grace, holds the decision
  const b = hooks.event(idleEv(sid)); // arrives during the grace → coalesced
  await Promise.all([a, b]);
  assert.equal(prompts.length, 1, "overlapping idles must produce exactly one continuation");
  assert.equal(store.stateFor(sid).autoContinueCount, 1, "the cap/no-progress counter advances once, not twice");
});

test("integration: a user turn started DURING the grace supersedes a stale continuation", async () => {
  const { hooks, prompts } = makeContinueGuard({ abortGraceMs: 120 });
  const sid = "resume-mid-grace";
  await startGoal(hooks, sid);
  const idleP = hooks.event(idleEv(sid)); // starts the grace
  await new Promise((r) => setTimeout(r, 30));
  // The user sends a new message mid-grace — their turn owns the session now.
  await hooks["chat.message"]({ sessionID: sid, agent: "goal" }, { parts: [{ type: "text", text: "actually do this instead" }] });
  await idleP;
  assert.equal(prompts.length, 0, "no stale 'keep going' may be injected over the user's new turn");
});

test("integration: chat.params does NOT clear a pending cancel (only a real user message does)", async () => {
  const { hooks, store, prompts } = makeContinueGuard();
  const sid = "params-no-clear";
  await startGoal(hooks, sid);
  await hooks.event(abortEv(sid));
  // chat.params fires on every LLM call, not just new user turns — it must not drop the cancel.
  await hooks["chat.params"]({ sessionID: sid, agent: "goal" }, {});
  assert.equal(store.stateFor(sid).abortedAt > 0, true, "chat.params must leave the pending cancel intact");
  await hooks.event(idleEv(sid));
  assert.equal(prompts.length, 0, "still suppressed after chat.params");
});

test("integration: an abort for an UNTRACKED session is a harmless no-op", async () => {
  const { hooks, store } = makeGuard();
  await assert.doesNotReject(() =>
    hooks.event({ event: { type: "session.error", properties: { sessionID: "never-seen", error: { name: "MessageAbortedError" } } } }),
  );
  assert.equal(store.size(), 0, "a stray abort must not create a spurious session entry");
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
