import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGuardPromptBody,
  isSyntheticUserTurn,
  GUARD_PREFIX,
  GUARD_SYNTHETIC_TRIGGER,
  createLogger,
} from "../plugins/goal-guard/logger.js";

test("buildGuardPromptBody uses system directive + synthetic text (never a user bubble)", () => {
  const body = buildGuardPromptBody("Fix the failing test.", { providerID: "p", modelID: "m" });
  assert.equal(body.agent, "goal");
  assert.ok(body.system.includes(`${GUARD_PREFIX}\nFix the failing test.`));
  assert.equal(body.parts.length, 1);
  assert.equal(body.parts[0].type, "text");
  assert.equal(body.parts[0].synthetic, true);
  assert.equal(body.parts[0].text, GUARD_SYNTHETIC_TRIGGER);
  assert.doesNotMatch(body.parts[0].text, /Fix the failing test/);
});

test("isSyntheticUserTurn detects harness synthetic turns", () => {
  assert.equal(isSyntheticUserTurn([{ type: "text", text: "hi", synthetic: true }]), true);
  assert.equal(isSyntheticUserTurn([{ type: "text", text: "hi" }]), false);
  assert.equal(isSyntheticUserTurn([{ type: "file", mime: "x", url: "u" }]), true);
  assert.equal(isSyntheticUserTurn([]), false);
});

test("guardPrompt sends synthetic body via promptAsync", async () => {
  const sent = [];
  const logger = createLogger({
    session: {
      promptAsync: async (opts) => {
        sent.push(opts);
      },
    },
  });
  await logger.guardPrompt("s1", "Keep going.", null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path.id, "s1");
  assert.equal(sent[0].body.parts[0].synthetic, true);
  assert.match(sent[0].body.system, /Keep going\./);
});
