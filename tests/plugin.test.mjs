import test from "node:test";
import assert from "node:assert/strict";
import plugin, { __test } from "../plugins/goal-guard.js";

test("detects destructive bash commands", () => {
  assert.equal(__test.looksLikeDestructiveBash("rm -rf /tmp/x"), true);
  assert.equal(__test.looksLikeDestructiveBash("git reset --hard"), true);
  assert.equal(__test.looksLikeDestructiveBash("npm test"), false);
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

test("final completion is rewritten when dirty", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  await hooks["tool.execute.after"]({ tool: "edit", sessionID: "complete-test", callID: "c", args: {} }, { output: "", title: "", metadata: {} });
  const output = { text: "Goal Completed\n\nReview cycles: 1" };
  await hooks["experimental.text.complete"]({ sessionID: "complete-test", messageID: "m", partID: "p" }, output);
  assert.match(output.text, /Goal Not Completed/);
  assert.match(output.text, /blocked completion/i);
});

test("compaction preserves goal guard state", async () => {
  const hooks = await plugin({ client: { app: { log: async () => undefined } } });
  const output = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: "compact-test" }, output);
  assert.match(output.context.join("\n"), /Goal Guard state/);
  assert.match(output.context.join("\n"), /Review Ledger/);
});
