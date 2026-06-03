import test from "node:test";
import assert from "node:assert/strict";
import { filesIn, readRepo, frontmatter, hasLine } from "./helpers.mjs";

const requiredAgents = [
  "goal.md",
  "goal-explorer.md",
  "goal-researcher.md",
  "goal-implementer.md",
  "goal-reviewer.md",
  "goal-prompt-auditor.md",
  "goal-diff-reviewer.md",
  "goal-verifier.md",
  "goal-test-reviewer.md",
  "goal-security-reviewer.md",
  "goal-ux-reviewer.md",
  "goal-ops-reviewer.md",
  "goal-doc-reviewer.md",
  "goal-final-auditor.md",
  "goal-deep-researcher.md",
  "goal-web-researcher.md",
  "goal-architect.md",
  "goal-mapper.md",
  "goal-planner.md",
  "goal-coordinator.md",
  "goal-doc-writer.md",
  "goal-commentator.md",
  "goal-api-reviewer.md",
  "goal-data-reviewer.md",
  "goal-perf-reviewer.md",
  "goal-quality-gate.md",
];

test("all required agents exist", () => {
  const files = filesIn("agents");
  for (const agent of requiredAgents) assert.ok(files.includes(agent), `${agent} missing`);
});

test("agents have required frontmatter", () => {
  for (const file of requiredAgents) {
    const fm = frontmatter(readRepo(`agents/${file}`));
    assert.ok(hasLine(fm, "description"), `${file} missing description`);
    assert.ok(hasLine(fm, "mode"), `${file} missing mode`);
    assert.ok(hasLine(fm, "permission"), `${file} missing permission`);
  }
});

test("primary goal enforces review artifacts and final contract", () => {
  const text = readRepo("agents/goal.md");
  for (const phrase of [
    "Goal Contract",
    "Verification Ledger",
    "Review Ledger",
    "Required review matrix",
    "Review handoff template",
    "Goal Completed",
    "Review cycles: N",
  ]) {
    assert.ok(text.includes(phrase), `goal.md missing ${phrase}`);
  }
});

test("reviewers are read-only", () => {
  for (const file of requiredAgents.filter((name) => name.includes("reviewer") || name.includes("auditor") || name.includes("verifier"))) {
    const fm = frontmatter(readRepo(`agents/${file}`));
    assert.match(fm, /edit:\s+deny/, `${file} must deny edit`);
    assert.match(fm, /task:\s+deny/, `${file} must deny task nesting`);
  }
});
