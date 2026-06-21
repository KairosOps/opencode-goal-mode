import test from "node:test";
import assert from "node:assert/strict";
import { readRepo } from "./helpers.mjs";

test("architecture testing inventory avoids stale hardcoded test counts", () => {
  const architecture = readRepo("ARCHITECTURE.md");

  assert.doesNotMatch(architecture, /\d+\s+tests\s+across/i);
  assert.match(architecture, /tests\/logger\.test\.mjs/);
  assert.match(architecture, /tests\/deep-bughunt\.test\.mjs/);
});

test("architecture names all idle-review retry config options", () => {
  const architecture = readRepo("ARCHITECTURE.md");

  assert.match(architecture, /reviewIdleDeferMs/);
  assert.match(architecture, /reviewIdleRetryMs/);
  assert.match(architecture, /maxReviewIdleRetries/);
});

test("changelog avoids stale unit-test count in v0.6.8 entry", () => {
  const changelog = readRepo("CHANGELOG.md");
  const [, v068] = changelog.match(/## v0\.6\.8([\s\S]*?)\n## v0\.6\.7/) || [];

  assert.ok(v068, "missing v0.6.8 changelog section");
  assert.doesNotMatch(v068, /\d+\s+unit tests/i);
});
