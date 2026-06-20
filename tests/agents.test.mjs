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
  "goal-completion-guard.md",
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

test("all review gates are read-only and cannot nest tasks", () => {
  const reviewers = requiredAgents.filter((name) =>
    /(reviewer|auditor|verifier|quality-gate|completion-guard)/.test(name),
  );
  assert.ok(reviewers.length >= 10, "expected the full reviewer matrix");
  for (const file of reviewers) {
    const fm = frontmatter(readRepo(`agents/${file}`));
    assert.match(fm, /edit:\s+deny/, `${file} must deny edit`);
    assert.match(fm, /task:\s+deny/, `${file} must deny task nesting`);
  }
});

test("exactly one primary agent exists", () => {
  let primaries = 0;
  for (const file of filesIn("agents")) {
    if (/^mode:\s+primary\s*$/m.test(frontmatter(readRepo(`agents/${file}`)))) primaries += 1;
  }
  assert.equal(primaries, 1);
});

test("agents do not pin a non-portable provider model", () => {
  for (const file of filesIn("agents")) {
    const text = readRepo(`agents/${file}`);
    assert.doesNotMatch(text, /^model:\s*ordis\//m, `${file} pins a non-portable model`);
  }
});

test("agent bodies are free of leaked frontmatter or reasoning", () => {
  for (const file of filesIn("agents")) {
    const text = readRepo(`agents/${file}`);
    const body = text.replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.doesNotMatch(body, /<\/?think>/, `${file} body leaks a reasoning tag`);
    assert.doesNotMatch(body, /^ext_mcp_server_trust:/m, `${file} leaks ext_mcp_server_trust`);
  }
});

test("reviewers require an explicit PASS/FAIL verdict in their output contract", () => {
  const reviewers = requiredAgents.filter((name) =>
    /(reviewer|auditor|verifier|quality-gate|completion-guard)/.test(name),
  );
  for (const file of reviewers) {
    const body = readRepo(`agents/${file}`).replace(/^---\n[\s\S]*?\n---\n/, "");
    assert.match(body, /Verdict/, `${file} must define a Verdict in its output`);
    assert.match(body, /PASS/, `${file} must mention PASS`);
    assert.match(body, /FAIL/, `${file} must mention FAIL`);
  }
});

test("primary goal denies the question tool (autonomous loop)", () => {
  const fm = frontmatter(readRepo("agents/goal.md"));
  assert.match(fm, /question:\s+deny/, "goal.md must deny the question tool");
});

test("goal-explorer allows common read-only bash", () => {
  const fm = frontmatter(readRepo("agents/goal-explorer.md"));
  for (const pattern of ["grep *", "cat *", "rg *", "git diff *"]) {
    assert.ok(fm.includes(`"${pattern}": allow`), `goal-explorer.md must allow "${pattern}"`);
  }
  assert.match(fm, /edit:\s+deny/, "goal-explorer must stay read-only");
});
