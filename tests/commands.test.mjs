import test from "node:test";
import assert from "node:assert/strict";
import { filesIn, readRepo, frontmatter, hasLine } from "./helpers.mjs";

const requiredCommands = ["goal.md", "goal-contract.md", "goal-review.md", "goal-status.md", "goal-repair.md", "goal-final.md"];

test("all required commands exist", () => {
  const files = filesIn("commands");
  for (const command of requiredCommands) assert.ok(files.includes(command), `${command} missing`);
});

test("commands have descriptions and agent bindings", () => {
  for (const file of requiredCommands) {
    const fm = frontmatter(readRepo(`commands/${file}`));
    assert.ok(hasLine(fm, "description"), `${file} missing description`);
    assert.ok(hasLine(fm, "agent"), `${file} missing agent`);
  }
});

test("review and final commands run as subtasks", () => {
  assert.match(frontmatter(readRepo("commands/goal-review.md")), /subtask:\s+true/);
  assert.match(frontmatter(readRepo("commands/goal-final.md")), /subtask:\s+true/);
});
