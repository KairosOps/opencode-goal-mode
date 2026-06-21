import test from "node:test";
import assert from "node:assert/strict";
import { readRepo } from "./helpers.mjs";

test("CI workflow cancels superseded runs on the same ref", () => {
  const ci = readRepo(".github/workflows/ci.yml");

  assert.match(ci, /concurrency:/);
  assert.match(ci, /group:\s*ci-\$\{\{ github\.ref \}\}/);
  assert.match(ci, /cancel-in-progress:\s*true/);
});

test("npm ignore defensively excludes non-package directories", () => {
  const npmignore = readRepo(".npmignore");

  for (const entry of ["tests/", "tools/", "benchmarks/", "research/", ".github/"]) {
    assert.match(npmignore, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  }
});

test("comparison research cites current Claude docs and plugin version", () => {
  const comparison = readRepo("research/goal-mode-comparison.md");

  assert.match(comparison, /docs\.anthropic\.com\/en\/docs\/claude-code/);
  assert.doesNotMatch(comparison, /code\.claude\.com/);
  assert.match(comparison, /@opencode-ai\/plugin@1\.17\.6/);
});
