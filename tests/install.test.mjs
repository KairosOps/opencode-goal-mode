import test from "node:test";
import assert from "node:assert/strict";
import { readRepo } from "./helpers.mjs";

test("installer copies only safe OpenCode component directories", () => {
  const text = readRepo("scripts/install.mjs");
  assert.match(text, /copyDirFiles\(join\(root, "agents"\)/);
  assert.match(text, /copyDirFiles\(join\(root, "commands"\)/);
  assert.match(text, /copyDirFiles\(join\(root, "plugins"\)/);
  assert.doesNotMatch(text, /auth|sessions|preauth|failures|hosts\.yml/);
});

test("gitignore excludes secrets and dependencies", () => {
  const text = readRepo(".gitignore");
  for (const pattern of ["node_modules/", ".env", ".env.*"]) assert.ok(text.includes(pattern));
});
