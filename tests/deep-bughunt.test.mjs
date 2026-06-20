/**
 * Regression tests for the deep cross-cutting bug hunt (dl1–dl8).
 *
 * Each test pins a confirmed, separately-reproduced defect so it cannot silently
 * return. dl3 is additionally covered as a unit in verdicts.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateCompletionClaim } from "../plugins/goal-guard/completion.js";
import { analyzeCommand } from "../plugins/goal-guard/shell.js";
import { goalSimilarity, SAME_GOAL_THRESHOLD, createGoalTools } from "../plugins/goal-guard/tools.js";
import { createStore, createState } from "../plugins/goal-guard/state.js";
import { markEdit } from "../plugins/goal-guard/events.js";
import { runReviewCycle } from "../plugins/goal-guard/review-runner.js";
import { DEFAULT_CONFIG } from "../plugins/goal-guard/config.js";
import { completionAllowed } from "../plugins/goal-guard/gates.js";
import { __test } from "../plugins/goal-guard/guard.js";

const noopPersistence = { load: () => null, save: () => {}, flush: () => false, file: "", isDegraded: () => false };
const MODEL = { providerID: "opencode", modelID: "m" };

function mockReviewClient(verdictFor, sessionID = "goal-session") {
  let currentAgent = null;
  const launched = [];
  return {
    session: {
      promptAsync: async ({ body }) => {
        for (const part of body?.parts || []) {
          if (part.type === "subtask") {
            currentAgent = part.agent;
            launched.push(part.agent);
          }
        }
      },
      messages: async () => {
        const parts = launched.map((agent) => {
          const v = typeof verdictFor === "function" ? verdictFor(agent) : verdictFor;
          return {
            type: "tool",
            tool: "task",
            state: {
              status: "completed",
              input: { subagent_type: agent },
              output: v ? `Verdict: ${v}` : "No verdict",
            },
          };
        });
        return { data: [{ info: { role: "assistant", agent: currentAgent }, parts }] };
      },
    },
  };
}

/** A goal state with work to review and a completed review (all PASS, reviewCycles=1). */
async function allowedState(id) {
  const store = createStore();
  const state = store.stateFor(id);
  state.active = true;
  state.contract = { title: "Do x", original: "do x", acceptanceCriteria: ["x works"] };
  markEdit(store, state, "edit");
  await runReviewCycle(mockReviewClient("PASS", id), store, state, DEFAULT_CONFIG, { sessionID: id, sleep: async () => {}, pollMs: 1, timeoutMs: 500 });
  return state;
}

// ── dl4: invisible leading characters must not bypass the completion marker ──────
test("[dl4] a zero-width / bidi prefixed 'Goal Completed' is still policed", () => {
  for (const cp of ["​", "‌", "‍", "‎", "‏", "⁠", "﻿", "­"]) {
    const state = createState();
    state.active = true; // blocked: reviewCycles = 0
    const res = evaluateCompletionClaim(state, DEFAULT_CONFIG, `${cp}Goal Completed\n\nReview cycles: 0`);
    assert.equal(res.blocked, true, `U+${cp.codePointAt(0).toString(16)} prefix must be blocked`);
    assert.match(res.replacement, /Goal Not Completed/);
  }
});

// ── dl5: the LAST "Review cycles: N" is the claim, not an earlier mention ─────────
test("[dl5] an earlier 'Review cycles' mention does not wrongly reject a valid completion", async () => {
  const state = await allowedState("dl5");
  assert.equal(state.reviewCycles, 1);
  const text = 'Recap: my first attempt logged "Review cycles: 0" before I finished.\n\nGoal Completed\n\nReview cycles: 1';
  const res = evaluateCompletionClaim(state, DEFAULT_CONFIG, text);
  assert.equal(res.claimedCycles, 1, "the conclusion line (1) is read, not the earlier 0");
  assert.equal(res.blocked, false, "a valid completion is allowed");
});

// ── dl6: applet multiplexers don't hide destructive commands ─────────────────────
test("[dl6] busybox/toybox-wrapped destructive applets are classified destructive", () => {
  assert.equal(analyzeCommand("busybox rm -rf /tmp/p/important").destructive, true);
  assert.equal(analyzeCommand("toybox find . -delete").destructive, true);
  assert.equal(analyzeCommand("busybox sh -c 'rm -rf /tmp/x'").destructive, true);
  // benign applets stay benign
  assert.equal(analyzeCommand("busybox ls -la").destructive, false);
  assert.equal(analyzeCommand("busybox ls -la").mutating, false);
});

// ── dl7: rsync --delete is a destination wipe, not merely mutating ───────────────
test("[dl7] rsync --delete is destructive; plain rsync is mutating", () => {
  assert.equal(analyzeCommand("rsync -a --delete /tmp/empty/ /tmp/p/build/").destructive, true);
  assert.equal(analyzeCommand("rsync --delete-after a/ b/").destructive, true);
  assert.equal(analyzeCommand("rsync --del a/ b/").destructive, true);
  const plain = analyzeCommand("rsync -a a/ b/");
  assert.equal(plain.destructive, false);
  assert.equal(plain.mutating, true);
});

// ── dl8: re-recording a reworded SAME goal preserves accrued review progress ─────
test("[dl8] goalSimilarity separates a reworded same-goal from a different goal", () => {
  const same = goalSimilarity(
    "Add a rate limiter to the login endpoint. Use a token bucket and make it configurable.",
    "Add a configurable token-bucket rate limiter to the login endpoint.",
  );
  assert.ok(same >= SAME_GOAL_THRESHOLD, `same goal scores high (${same})`);
  const diff = goalSimilarity("Add a rate limiter to the login endpoint", "Migrate the database to PostgreSQL and update the ORM");
  assert.ok(diff < SAME_GOAL_THRESHOLD, `different goal scores low (${diff})`);
});

test("[dl8] formalizing an auto-seeded goal preserves reviewCycles; a different goal resets", async () => {
  const store = createStore();
  const tools = createGoalTools({ store, config: DEFAULT_CONFIG, persist: () => {} });
  const state = store.stateFor("S");
  state.active = true;
  state.contract = { auto: true, title: "", original: "Add a rate limiter to the login endpoint. Use a token bucket and make it configurable.", acceptanceCriteria: [] };
  markEdit(store, state, "edit");
  state.reviewCycles = 1;

  // reworded SAME goal → progress preserved
  await tools.goal_contract.execute(
    { title: "Rate-limit login", original: "Add a configurable token-bucket rate limiter to the login endpoint.", acceptanceCriteria: ["limiter works"] },
    { sessionID: "S" },
  );
  assert.equal(state.reviewCycles, 1, "reworded same goal preserves the review cycle");
  assert.ok((state.lastEditSeq || 0) > 0, "work is still recognized (review will run)");

  // genuinely DIFFERENT goal → reset (no leaked passes)
  await tools.goal_contract.execute(
    { title: "DB migration", original: "Migrate the database to PostgreSQL and update the ORM mappings.", acceptanceCriteria: ["migrated"] },
    { sessionID: "S" },
  );
  assert.equal(state.reviewCycles, 0, "a different goal resets accrued progress");
});

// ── dl1 / dl2: lifecycle during a programmatic review run ────────────────────────
/** Build a reviewing guard whose first reviewer subtask fires a side-effect mid-review. */
function makeReviewingGuard(onFirstReview) {
  let t = 1000;
  const sessionID = "g";
  const launched = [];
  const prompts = [];
  let fired = false;
  const client = {
    app: { log: async () => {} },
    tui: { showToast: async () => {} },
    session: {
      promptAsync: async ({ path, body }) => {
        for (const part of body?.parts || []) {
          if (part.type === "subtask") {
            launched.push(part.agent);
            if (!fired && onFirstReview) {
              fired = true;
              await onFirstReview();
            }
            prompts.push({ id: path.id, agent: part.agent, kind: "subtask", text: part.prompt || "" });
          } else if (part.type === "text") {
            prompts.push({ id: path.id, agent: body?.agent, kind: "guard", text: part.text || "" });
          }
        }
      },
      messages: async () => ({
        data: [
          {
            parts: launched.map((agent) => ({
              type: "tool",
              tool: "task",
              state: { status: "completed", input: { subagent_type: agent }, output: "Verdict: PASS" },
            })),
          },
        ],
      }),
    },
  };
  const guard = __test.createGuard({ client }, { abortGraceMs: 0, reviewPollMs: 2, reviewTimeoutMs: 1000, reviewIdleDeferMs: 0 }, { persistence: noopPersistence, clock: () => (t += 1), syncIdle: true });
  return { guard, prompts, sessionID };
}

async function startGoalWithWork(hooks) {
  await hooks["chat.params"]({ sessionID: "g", agent: "goal", model: MODEL }, {});
  await hooks["chat.message"]({ sessionID: "g", agent: "goal", model: MODEL }, { parts: [{ type: "text", text: "implement and verify the feature" }] });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "g", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
}

test("[dl1] a project file.edited DURING the review run does not stale the fresh passes", async () => {
  let guardRef;
  const { guard, prompts } = makeReviewingGuard(async () => {
    // A background edit lands mid-review (the agent is idle; this is noise).
    await guardRef.hooks.event({ event: { type: "file.edited", properties: { file: "/proj/src/app.js" } } });
  });
  guardRef = guard;
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  const state = guard.store.stateFor("g");
  // The mid-review edit must NOT bump lastEditSeq into the verdict sequence and stale
  // the fresh PASSes — completion opens and every recorded verdict stays fresh.
  assert.equal(completionAllowed(state, guard.config), true, "fresh passes survive a mid-review background edit");
  assert.ok(Object.values(state.latestVerdict).every((v) => v.seq > state.lastEditSeq), "all verdicts remain fresh (none staled)");
  // The agent is told it's done — never handed an empty 'Failing reviewers:' directive.
  assert.ok(prompts.some((p) => p.kind === "guard" && /All required reviews PASSED/.test(p.text)), "completion opens after a clean review");
  assert.ok(!prompts.some((p) => /Failing reviewers:\s*\.?\s*$/m.test(p.text)), "no contradictory empty failing-reviewers directive");
});

test("[dl2] a user cancel DURING the review run suppresses the continuation", async () => {
  let guardRef;
  const { guard, prompts } = makeReviewingGuard(async () => {
    // The user presses stop mid-review: session.error(MessageAbortedError) sets abortedAt.
    await guardRef.hooks.event({ event: { type: "session.error", properties: { sessionID: "g", error: { name: "MessageAbortedError" } } } });
  });
  guardRef = guard;
  await startGoalWithWork(guard.hooks);
  await guard.hooks.event({ event: { type: "session.idle", properties: { sessionID: "g" } } });

  // No guard continuation to the goal agent after the cancel (reviewer subtasks are separate).
  const goalContinuations = prompts.filter((p) => p.kind === "guard" && p.agent === "goal");
  assert.equal(goalContinuations.length, 0, "no continuation is sent after a mid-review cancel");
  assert.ok(guard.store.stateFor("g").abortedAt > 0, "the cancel was recorded");
});
