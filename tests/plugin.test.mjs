import test from "node:test";
import assert from "node:assert/strict";
import plugin, { __test } from "../plugins/goal-guard.js";

test("detects destructive bash commands", () => {
  assert.equal(__test.looksLikeDestructiveBash("rm -rf /tmp/x"), true);
  assert.equal(__test.looksLikeDestructiveBash("sudo rm -fr /tmp/x"), true);
  assert.equal(__test.looksLikeDestructiveBash("rm --recursive --force /tmp/x"), true);
  assert.equal(__test.looksLikeDestructiveBash("git reset --hard"), true);
  assert.equal(__test.looksLikeDestructiveBash("git push --force"), true);
  assert.equal(__test.looksLikeDestructiveBash("find . -delete"), true);
  assert.equal(__test.looksLikeDestructiveBash("find . -exec rm -f {} +"), true);
  assert.equal(__test.looksLikeDestructiveBash("dd if=/tmp/x of=/dev/sda"), true);
  assert.equal(__test.looksLikeDestructiveBash("npm test"), false);
  assert.equal(__test.looksLikeDestructiveBash("ls -la"), false);
});

test("distinguishes read-only and mutating bash commands", () => {
  assert.equal(__test.looksLikeMutatingBash("cat README.md"), false);
  assert.equal(__test.looksLikeMutatingBash("rg goal agents"), false);
  assert.equal(__test.looksLikeMutatingBash("node -e \"console.log('ok')\""), false);
  assert.equal(__test.looksLikeMutatingBash("cat README.md > /tmp/goal-output.txt"), true);
  assert.equal(__test.looksLikeMutatingBash("npm install"), true);
  assert.equal(__test.looksLikeMutatingBash("npx prettier --write README.md"), true);
});

test("detects verification commands without generic test false positives", () => {
  assert.equal(__test.isVerification("npm test"), true);
  assert.equal(__test.isVerification("npm run validate"), true);
  assert.equal(__test.isVerification("rg test README.md"), false);
  assert.equal(__test.isVerification("node tests/plugin.test.mjs"), false);
});

test("state cache evicts at the configured session limit", () => {
  __test.sessions.clear();
  for (let i = 0; i < 205; i += 1) __test.stateFor(`session-${i}`);
  assert.equal(__test.sessions.size, 200);
});

test("plugin blocks destructive bash before tool execution", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  await assert.rejects(
    () => hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "git clean -fd" } }),
    /blocked/i,
  );
});

test("write tool marks session dirty", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "dirty-test", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  const state = __test.stateFor("dirty-test");
  assert.equal(state.dirty, true);
  assert.equal(Boolean(state.lastEditAt), true);
});

test("read-only bash does not mark session dirty", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "read-only-bash-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "c", args: { command: "cat README.md" } }, { output: "", title: "", metadata: {} });
  const state = __test.stateFor(sessionID);
  assert.equal(state.dirty, false);
  assert.equal(state.lastEditAt, null);
});

test("mutating bash marks session dirty", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "mutating-bash-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "c", args: { command: "cat README.md > /tmp/goal-output.txt" } }, { output: "", title: "", metadata: {} });
  const state = __test.stateFor(sessionID);
  assert.equal(state.dirty, true);
  assert.equal(Boolean(state.lastEditAt), true);
});

test("task tool captures review verdict from subagent", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "task-review-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "task", sessionID, callID: "c", args: { subagent_type: "goal-reviewer", prompt: "Review this." } }, { output: "Verdict: PASS", title: "", metadata: {} });
  const state = __test.stateFor(sessionID);
  assert.equal(state.verdicts.some((v) => v.agent === "goal-reviewer" && v.verdict === "PASS"), true);
});

test("task tool captures review failure from subagent", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "task-review-fail-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "task", sessionID, callID: "c", args: { subagent_type: "goal-final-auditor", prompt: "Audit this." } }, { output: "Verdict: FAIL", title: "", metadata: {} });
  const state = __test.stateFor(sessionID);
  assert.equal(state.verdicts.some((v) => v.agent === "goal-final-auditor" && v.verdict === "FAIL"), true);
});

test("verification command updates lastVerificationAt", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "verify-time-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  const before = new Date().toISOString();
  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "c", args: { command: "npm test" } }, { output: "", title: "", metadata: {} });
  const state = __test.stateFor(sessionID);
  assert.equal(state.verificationSeen, true);
  assert.ok(state.lastVerificationAt >= before);
});

test("task-based final auditor records one review cycle", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "task-final-cycle-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "task", sessionID, callID: "c", args: { subagent_type: "goal-final-auditor", prompt: "Audit this." } }, { output: "Verdict: PASS", title: "", metadata: {} });
  const state = __test.stateFor(sessionID);
  assert.equal(state.reviewCycles, 1);
});

test("final completion blocks claimed review cycles that do not match recorded", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "cycles-block-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID, callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  // separate verification so review timestamps stay after it
  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "v", args: { command: "npm test" } }, { output: "", title: "", metadata: {} });

  for (const agent of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    await hooks["chat.params"]({ sessionID, agent }, {});
    await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: agent, args: { command: "npm test" } }, { output: "Verdict: PASS", title: "", metadata: {} });
  }

  const output = { text: "Goal Completed\n\nReview cycles: 2" };
  await hooks["experimental.text.complete"]({ sessionID, messageID: "m", partID: "p" }, output);
  assert.match(output.text, /Goal Not Completed/);
  assert.match(output.text, /do not match recorded/i);
});

test("final completion blocks missing review cycles entirely", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "zero-cycles-block-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID, callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: "v", args: { command: "npm test" } }, { output: "", title: "", metadata: {} });
  const output = { text: "Goal Completed\n\nReview cycles: 0" };
  await hooks["experimental.text.complete"]({ sessionID, messageID: "m", partID: "p" }, output);
  assert.match(output.text, /Goal Not Completed/);
  assert.match(output.text, /no review cycles recorded/i);
});

test("final completion blocks missing review cycles line", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  await hooks["chat.params"]({ sessionID: "missing-cycle-line-test", agent: "goal" }, {});
  const output = { text: "Goal Completed\n\nDone." };
  await hooks["experimental.text.complete"]({ sessionID: "missing-cycle-line-test", messageID: "m", partID: "p" }, output);
  assert.match(output.text, /Goal Not Completed/);
  assert.match(output.text, /missing required Review cycles line/i);
});

test("final completion is rewritten when dirty", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "complete-test", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  const output = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: "complete-test", messageID: "m", partID: "p" }, output);
  assert.match(output.text, /Goal Not Completed/);
  assert.match(output.text, /blocked completion/i);
});

test("final completion is rewritten when required reviews never ran", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  await hooks["chat.params"]({ sessionID: "no-review-test", agent: "goal" }, {});
  const output = { text: "Goal Completed\n\nReview cycles: 0" };
  await hooks["experimental.text.complete"]({ sessionID: "no-review-test", messageID: "m", partID: "p" }, output);
  assert.match(output.text, /Goal Not Completed/);
  assert.match(output.text, /no review cycles recorded/i);
});

test("completion is allowed only after all required gates pass after edit", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const sessionID = "gate-pass-test";
  await hooks["chat.params"]({ sessionID, agent: "goal" }, {});
  await hooks["tool.execute.after"]({ tool: "edit", sessionID, callID: "c", args: {} }, { output: "", title: "", metadata: {} });

  for (const agent of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) {
    await hooks["chat.params"]({ sessionID, agent }, {});
    await hooks["tool.execute.after"]({ tool: "bash", sessionID, callID: agent, args: { command: "npm test" } }, { output: "Verdict: PASS", title: "", metadata: {} });
  }

  const output = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID, messageID: "m", partID: "p" }, output);
  assert.match(output.text, /Goal Completed/);
  assert.doesNotMatch(output.text, /Goal Not Completed/);
});

test("compaction preserves goal guard state", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const output = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: "compact-test" }, output);
  assert.match(output.context.join("\n"), /Goal Guard state/);
  assert.match(output.context.join("\n"), /Review Ledger/);
});
