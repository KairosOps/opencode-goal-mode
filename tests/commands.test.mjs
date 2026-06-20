import test from "node:test";
import assert from "node:assert/strict";
import { filesIn, readRepo, frontmatter, hasLine } from "./helpers.mjs";

const requiredCommands = [
  "goal.md",
  "goal-contract.md",
  "goal-review.md",
  "goal-status.md",
  "goal-repair.md",
  "goal-final.md",
  "goal-evidence-map.md",
];

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

test("every command body forwards user input via $ARGUMENTS", () => {
  for (const file of requiredCommands) {
    assert.ok(readRepo(`commands/${file}`).includes("$ARGUMENTS"), `${file} must reference $ARGUMENTS`);
  }
});

test("commands bind to a goal agent", () => {
  for (const file of requiredCommands) {
    const fm = frontmatter(readRepo(`commands/${file}`));
    const agent = (fm.match(/^agent:\s*(\S+)/m) || [])[1];
    assert.ok(agent && agent.startsWith("goal"), `${file} must bind to a goal agent`);
  }
});

test("goal command does not instruct using the Questions tool", () => {
  const body = readRepo("commands/goal.md");
  assert.doesNotMatch(body, /clarifying questions/i, "goal command must not ask for clarifying questions");
  assert.match(body, /Questions tool.*disabled/i, "goal command must note question tool is disabled");
});

test("goal-contract command does not instruct using the Questions tool", () => {
  const body = readRepo("commands/goal-contract.md");
  assert.doesNotMatch(body, /clarifying questions/i, "goal-contract must not ask for clarifying questions");
  assert.match(body, /Questions tool/i, "goal-contract must note question tool is unavailable");
});

test("evidence map command stays read-only and criteria-focused", () => {
  const body = readRepo("commands/goal-evidence-map.md");
  assert.match(body, /Do not edit files/);
  assert.match(body, /Acceptance criterion/);
  assert.match(body, /Recorded evidence/);
  assert.match(body, /Reviewer status/);
  assert.match(body, /goal_evidence_map/);
  assert.match(body, /Verification command\/result summary/);
  assert.match(body, /covered, partially covered, missing, or stale/);
});
