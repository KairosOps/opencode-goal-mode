import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("installer dry run does not write files", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-dry-"));
  execFileSync("node", [join(repoRoot, "scripts", "install.mjs"), "--dry-run"], { cwd: temp, stdio: "pipe" });
  assert.equal(existsSync(join(temp, ".opencode")), false);
});

test("installer refuses to overwrite changed destination files", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-conflict-"));
  mkdirSync(join(temp, ".opencode", "agents"), { recursive: true });
  writeFileSync(join(temp, ".opencode", "agents", "goal.md"), "local change\n");
  assert.throws(
    () => execFileSync("node", [join(repoRoot, "scripts", "install.mjs")], { cwd: temp, stdio: "pipe" }),
    /Refusing to overwrite changed OpenCode component files/
  );
});

test("installer force replaces changed destination files", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-force-"));
  mkdirSync(join(temp, ".opencode", "agents"), { recursive: true });
  const dest = join(temp, ".opencode", "agents", "goal.md");
  writeFileSync(dest, "local change\n");
  execFileSync("node", [join(repoRoot, "scripts", "install.mjs"), "--force"], { cwd: temp, stdio: "pipe" });
  assert.equal(readFileSync(dest, "utf8"), readFileSync(join(repoRoot, "agents", "goal.md"), "utf8"));
});

test("installer supports explicit target directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-target-"));
  const target = join(temp, "custom-opencode");
  execFileSync("node", [join(repoRoot, "scripts", "install.mjs"), "--target", target], { cwd: temp, stdio: "pipe" });
  assert.equal(existsSync(join(target, "agents", "goal.md")), true);
  assert.equal(existsSync(join(target, "plugins", "goal-guard.js")), true);
});
