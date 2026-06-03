import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { readRepo } from "./helpers.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

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

test("installer functionally copies components to project .opencode", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-"));
  execFileSync("node", [join(repoRoot, "scripts", "install.mjs")], { cwd: temp, stdio: "pipe" });
  assert.equal(existsSync(join(temp, ".opencode", "agents", "goal.md")), true);
  assert.equal(existsSync(join(temp, ".opencode", "commands", "goal.md")), true);
  assert.equal(existsSync(join(temp, ".opencode", "plugins", "goal-guard.js")), true);
});
