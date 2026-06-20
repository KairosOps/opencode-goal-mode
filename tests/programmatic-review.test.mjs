import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "../plugins/goal-guard/guard.js";
import { completionAllowed } from "../plugins/goal-guard/gates.js";
import { progressSignature } from "../plugins/goal-guard/autocontinue.js";
import { createGoalTools } from "../plugins/goal-guard/tools.js";

const noopPersistence = { load: () => null, save: () => {}, flush: () => false, file: "", isDegraded: () => false };

/** Build a guard whose client CAN review via subtasks on the goal session. */
function makeReviewingGuard(verdictFor, opts = {}) {
  let t = 1000;
  const sessionID = "g";
  const launched = [];
  let currentAgent = null;
  const prompts = [];
  const client = {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      promptAsync: async ({ path, body }) => {
        assert.equal(path.id, sessionID, "programmatic reviews stay on the goal session");
        for (const part of body?.parts || []) {
          if (part.type === "subtask") {
            currentAgent = part.agent;
            launched.push(part.agent);
            prompts.push({ id: path.id, agent: part.agent, text: part.prompt || "", kind: "subtask" });
          } else if (part.type === "text" && !part.synthetic) {
            prompts.push({ id: path.id, agent: body?.agent, text: part.text || "", kind: "text" });
          }
        }
        if (body?.agent && !(body.parts || []).some((p) => p.type === "subtask")) {
          prompts.push({
            id: path.id,
            agent: body.agent,
            text: body.system || "",
            kind: "guard",
            synthetic: (body.parts || []).every((p) => p.type !== "text" || p.synthetic === true),
          });
        }
      },
      messages: async () => {
        const v = typeof verdictFor === "function" ? verdictFor(currentAgent) : verdictFor;
        const parts = launched.map((agent) => {
          const verdict = typeof verdictFor === "function" ? verdictFor(agent) : verdictFor;
          return {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: agent, agent },
              output: verdict ? `Reviewed.\nVerdict: ${verdict}` : "No conclusion.",
            },
          };
        });
        return { data: [{ info: { role: "assistant", agent: currentAgent }, parts }] };
      },
    },
  };
  const guard = __test.createGuard(
    { client },
    { abortGraceMs: 0, reviewPollMs: 2, reviewTimeoutMs: 1000, reviewIdleDeferMs: 0, ...opts },
    { persistence: noopPersistence, clock: () => (t += 1), syncIdle: true },
  );
  return { guard, prompts, client, launched, sessionID };
}

const MODEL = { providerID: "opencode", modelID: "deepseek-v4-flash-free" };

async function startGoalWithWork(hooks) {
  await hooks["chat.params"]({ sessionID: "g", agent: "goal", model: MODEL }, {});
  await hooks["chat.message"]({ sessionID: "g", agent: "goal", model: MODEL }, { parts: [{ type: "text", text: "implement and verify the feature" }] });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "g", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
}

test("on idle, the GUARD CODE launches the required reviewers as subtasks (not the agent) and completion opens when all PASS", async () => {
  const { guard, prompts, launched } = makeReviewingGuard("PASS");
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  for (const gate of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    assert.ok(launched.includes(gate), `guard programmatically launched ${gate} as a subtask`);
  }
  const state = guard.store.stateFor("g");
  assert.equal(completionAllowed(state, guard.config), true, "all gates passed → completion allowed");
  assert.ok(state.reviewCycles >= 1, "a review cycle was counted");
  const goalPrompts = prompts.filter((p) => p.agent === "goal" || (p.kind === "guard" && p.agent === "goal"));
  assert.ok(goalPrompts.length >= 1, "after reviews pass the guard emits the final completion turn");
  assert.ok(
    goalPrompts.some((p) => /Goal Completed|All required reviews PASSED programmatically/i.test(p.text || "")),
    "final turn asks for Goal Completed after programmatic review",
  );
  assert.ok(
    goalPrompts.every((p) => p.synthetic !== false),
    "guard continuations must use synthetic parts, never user-shaped messages",
  );
  const firstGoalIdx = prompts.findIndex((p) => p.agent === "goal");
  const firstReviewerIdx = prompts.findIndex((p) => p.kind === "subtask" && p.agent?.startsWith("goal-"));
  if (firstGoalIdx >= 0 && firstReviewerIdx >= 0) {
    assert.ok(firstReviewerIdx < firstGoalIdx, "reviewer subtasks launch before any guard continuation to the goal agent");
  }
});

test("on idle with a FAILING reviewer, the guard keeps completion blocked and feeds findings back (the cycle's Not-Done)", async () => {
  const { guard, prompts } = makeReviewingGuard((a) => (a === "goal-verifier" ? "FAIL" : "PASS"));
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  const state = guard.store.stateFor("g");
  assert.equal(completionAllowed(state, guard.config), false, "a failing reviewer blocks completion");
  assert.ok(prompts.some((p) => /blocking issues|must fix|Failing reviewers/i.test(p.text)), "guard fed the blocking findings back to the agent");
});

test("[bughunt rl1/rl2] the review loop is bounded by reviewRunCount (no runaway when a gate never passes / verdict never concludes)", async () => {
  const { guard, prompts, launched } = makeReviewingGuard((a) => (a === "goal-final-auditor" ? "PASS" : "FAIL"), { maxReviewCycles: 3, maxAutoContinue: 50 });
  await startGoalWithWork(guard.hooks);
  for (let i = 0; i < 30; i++) await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  const state = guard.store.stateFor("g");
  assert.ok((state.reviewRunCount || 0) <= 3, `review runs capped at maxReviewCycles (got ${state.reviewRunCount})`);
  assert.ok(launched.length < 30, `reviewer subtask launches bounded, not one+ per idle forever (got ${launched.length})`);
  assert.ok(!prompts.some((p) => p.kind === "text" && /task tool|task\(subagent_type/i.test(p.text)), "no task-tool nudge sent to the agent");
});

test("[live-parity] the guard runs the reviewers ITSELF even when NO model was captured (model is optional)", async () => {
  const { guard, prompts, launched } = makeReviewingGuard("PASS");
  await guard.hooks["chat.params"]({ sessionID: "g", agent: "goal" }, {});
  await guard.hooks["chat.message"]({ sessionID: "g", agent: "goal" }, { parts: [{ type: "text", text: "implement and verify the feature" }] });
  await guard.hooks["tool.execute.after"]({ tool: "edit", sessionID: "g", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  assert.ok(launched.length >= 5, `guard launched the reviewers itself without a captured model (got ${launched.length})`);
  assert.ok(!prompts.some((p) => p.kind === "text" && /task tool|task\(subagent_type/i.test(p.text)), "no task-tool nudge sent to the agent");
  assert.equal(completionAllowed(guard.store.stateFor("g"), guard.config), true);
});

test("[live-parity] the guard runs programmatic reviews when only goal_evidence marks verification (no file edits)", async () => {
  const { guard, launched } = makeReviewingGuard("PASS");
  const tools = createGoalTools({ store: guard.store, config: guard.config, persist: () => {} });
  await guard.hooks["chat.params"]({ sessionID: "g", agent: "goal", model: MODEL }, {});
  await guard.hooks["chat.message"]({ sessionID: "g", agent: "goal", model: MODEL }, { parts: [{ type: "text", text: "verify remote server setup" }] });
  await tools.goal_contract.execute({ title: "Remote verify", original: "verify remote server setup", acceptanceCriteria: ["server reachable"] }, { sessionID: "g" });
  await tools.goal_evidence.execute({ command: "curl -fsS https://example.com", result: "PASS" }, { sessionID: "g" });
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  assert.ok(launched.length >= 5, `evidence-only work still triggers programmatic review (got ${launched.length})`);
  assert.equal(completionAllowed(guard.store.stateFor("g"), guard.config), true);
});

test("[session-busy] first idle retries programmatic review when the host is still busy (no user continue needed)", async () => {
  let t = 1000;
  let ready = false;
  const launched = [];
  const client = {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      promptAsync: async ({ body }) => {
        if (!ready) {
          const err = new Error("SessionBusyError");
          err.name = "SessionBusyError";
          throw err;
        }
        for (const part of body?.parts || []) {
          if (part.type === "subtask") launched.push(part.agent);
        }
      },
      messages: async () => ({
        data: [{
          parts: launched.map((agent) => ({
            type: "tool",
            tool: "task",
            state: { status: "completed", input: { subagent_type: agent }, output: "Verdict: PASS" },
          })),
        }],
      }),
    },
  };
  const guard = __test.createGuard(
    { client },
    { abortGraceMs: 0, reviewPollMs: 2, reviewTimeoutMs: 1000, reviewIdleDeferMs: 0, reviewIdleRetryMs: 10, maxReviewIdleRetries: 5 },
    {
      persistence: noopPersistence,
      clock: () => (t += 1),
      syncIdle: true,
      reviewSleep: async () => {},
      setTimer: (fn) => {
        queueMicrotask(() => {
          ready = true;
          fn();
        });
        return 1;
      },
    },
  );
  await guard.hooks["chat.params"]({ sessionID: "g", agent: "goal", model: MODEL }, {});
  await guard.hooks["chat.message"]({ sessionID: "g", agent: "goal", model: MODEL }, { parts: [{ type: "text", text: "build it" }] });
  await guard.hooks["tool.execute.after"]({ tool: "edit", sessionID: "g", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  await new Promise((r) => setImmediate(r));
  assert.ok(launched.length >= 1, "review subtasks launch after SessionBusy retry without a user continue");
});

test("the model is captured from chat.params so the reviewers can be launched", async () => {
  const { guard, launched } = makeReviewingGuard("PASS");
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  assert.ok(launched.length > 0, "reviewers launched → model was captured & used");
});

test("programmatic review runs even when auto-continue no-progress circuit breaker tripped", async () => {
  const { guard, launched } = makeReviewingGuard("PASS", { maxAutoContinue: 50 });
  await startGoalWithWork(guard.hooks);
  const state = guard.store.stateFor("g");
  state.autoContinueNoProgress = 999;
  state.lastAutoContinueSig = progressSignature(state);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  assert.ok(launched.length >= 5, `reviews must run before stopReason blocks (got ${launched.length})`);
  assert.ok(state.reviewCycles >= 1, "review cycle counted");
});

test("programmatic review runs when a goal worker subagent was the last agent on the session", async () => {
  const { guard, launched } = makeReviewingGuard("PASS");
  await startGoalWithWork(guard.hooks);
  await guard.hooks["chat.params"]({ sessionID: "g", agent: "goal-implementer" }, {});
  assert.equal(guard.store.stateFor("g").active, true, "goal worker keeps parent session active once work is anchored");
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  assert.ok(launched.length >= 5, `goal worker handoff must not block programmatic review (got ${launched.length})`);
});

test("patch/str_replace edits count as work for programmatic review", async () => {
  const { guard, launched } = makeReviewingGuard("PASS");
  await guard.hooks["chat.params"]({ sessionID: "g", agent: "goal", model: MODEL }, {});
  await guard.hooks["chat.message"]({ sessionID: "g", agent: "goal", model: MODEL }, { parts: [{ type: "text", text: "implement subtract" }] });
  await guard.hooks["tool.execute.after"]({ tool: "patch", sessionID: "g", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });
  assert.ok(launched.length >= 5, `patch tool must mark work and trigger review (got ${launched.length})`);
});
