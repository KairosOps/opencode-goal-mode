import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readRepo } from "./helpers.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const installer = join(repoRoot, "scripts", "install.mjs");

function run(args, opts = {}) {
  return execFileSync("node", [installer, ...args], { stdio: "pipe", encoding: "utf8", ...opts });
}

test("installer source only references safe component directories", () => {
  const text = readRepo("scripts/install.mjs");
  assert.match(text, /COMPONENT_DIRS = \["agents", "commands", "plugins"\]/);
  assert.doesNotMatch(text, /auth|sessions|preauth|hosts\.yml/);
});

test("gitignore excludes secrets, dependencies, and local runtime data", () => {
  const text = readRepo(".gitignore");
  for (const pattern of [
    "node_modules/",
    ".env",
    ".env.*",
    "tools/lab/data/",
    "RELEASE_NOTES.md",
    "NOTES.md",
  ]) {
    assert.ok(text.includes(pattern), `.gitignore must include ${pattern}`);
  }
});

test("installer copies components, including the nested plugin module directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-"));
  run(["--target", join(temp, "cfg")]);
  const cfg = join(temp, "cfg");
  assert.equal(existsSync(join(cfg, "agents", "goal.md")), true);
  assert.equal(existsSync(join(cfg, "commands", "goal.md")), true);
  assert.equal(existsSync(join(cfg, "plugins", "goal-guard.js")), true);
  // The multi-file plugin's modules must be copied too, or imports break.
  assert.equal(existsSync(join(cfg, "plugins", "goal-guard", "shell.js")), true);
  assert.equal(existsSync(join(cfg, "plugins", "goal-guard", "state.js")), true);
  assert.equal(existsSync(join(cfg, ".goal-mode-manifest.json")), true);
});

test("installer help shows the public one-command install flow", () => {
  const out = run(["--help"]);
  assert.match(out, /npx opencode-goal-mode --global/);
  assert.match(out, /opencode-goal-mode-install --global/);
  assert.match(out, /--uninstall removes that entry/);
});

test("installed plugin actually loads from its target location", async () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-load-"));
  const cfg = join(temp, "cfg");
  run(["--target", cfg]);
  const mod = await import(join(cfg, "plugins", "goal-guard.js"));
  const hooks = await mod.default({ client: { app: { log: async () => undefined } } });
  for (const hook of ["tool.execute.before", "tool.execute.after", "experimental.text.complete"]) {
    assert.equal(typeof hooks[hook], "function", `${hook} missing in installed plugin`);
  }
});

test("installer dry run does not write files", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-dry-"));
  run(["--target", join(temp, "cfg"), "--dry-run"]);
  assert.equal(existsSync(join(temp, "cfg")), false);
});

test("installer is idempotent (second run reports all unchanged)", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-idem-"));
  const cfg = join(temp, "cfg");
  run(["--target", cfg]);
  const out = run(["--target", cfg]);
  assert.match(out, /Files copied: 0/);
});

test("installer refuses to overwrite a locally-modified file", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-conflict-"));
  const cfg = join(temp, "cfg");
  mkdirSync(join(cfg, "agents"), { recursive: true });
  writeFileSync(join(cfg, "agents", "goal.md"), "local change\n");
  assert.throws(() => run(["--target", cfg], { stdio: "pipe" }), /Refusing to overwrite/);
});

test("installer force replaces a locally-modified file", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-force-"));
  const cfg = join(temp, "cfg");
  mkdirSync(join(cfg, "agents"), { recursive: true });
  const dest = join(cfg, "agents", "goal.md");
  writeFileSync(dest, "local change\n");
  run(["--target", cfg, "--force"]);
  assert.equal(readFileSync(dest, "utf8"), readFileSync(join(repoRoot, "agents", "goal.md"), "utf8"));
});

test("installer can upgrade a file it owns without --force", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-upgrade-"));
  const cfg = join(temp, "cfg");
  run(["--target", cfg]);
  // Simulate a previously-shipped version: dest matches a stale manifest hash.
  const dest = join(cfg, "plugins", "goal-guard.js");
  const manifestPath = join(cfg, ".goal-mode-manifest.json");
  writeFileSync(dest, "// previous shipped version\n");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files["plugins/goal-guard.js"] = createHash("sha256")
    .update("// previous shipped version\n")
    .digest("hex")
    .slice(0, 16);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const out = run(["--target", cfg]);
  assert.match(out, /Files copied: 1/);
  assert.equal(readFileSync(dest, "utf8"), readFileSync(join(repoRoot, "plugins", "goal-guard.js"), "utf8"));
});

test("installer supports an explicit target directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-install-target-"));
  const target = join(temp, "custom-opencode");
  run(["--target", target]);
  assert.equal(existsSync(join(target, "agents", "goal.md")), true);
  assert.equal(existsSync(join(target, "plugins", "goal-guard", "gates.js")), true);
});

test("uninstall removes installed files but keeps locally-modified ones", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-uninstall-"));
  const cfg = join(temp, "cfg");
  run(["--target", cfg]);
  const modified = join(cfg, "agents", "goal.md");
  writeFileSync(modified, "my local edits\n");
  const out = run(["--target", cfg, "--uninstall"]);
  assert.match(out, /Left 1 locally-modified file/);
  assert.equal(existsSync(modified), true, "user-modified file must be preserved");
  assert.equal(existsSync(join(cfg, "plugins", "goal-guard", "shell.js")), false, "owned files removed");
});

test("installer refuses invalid tui.json unless --force backs it up", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-invalid-tui-"));
  const cfg = join(temp, "cfg");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "tui.json"), "{bad json\n");
  assert.throws(() => run(["--target", cfg], { stdio: "pipe" }), /Refusing to .*invalid.*tui\.json/i);
  run(["--target", cfg, "--force"]);
  assert.equal(existsSync(join(cfg, "tui.json.goal-mode-backup")), true);
});

test("REGRESSION: a non-object tui.json (JSON array) is refused, not silently corrupted", () => {
  // A JSON array is typeof "object", so the old `typeof existing === "object"`
  // check adopted it, set .plugin on the array (which JSON.stringify drops), and
  // reported success while the sidebar entry was silently lost. Refuse non-objects.
  const temp = mkdtempSync(join(tmpdir(), "goal-array-tui-"));
  const cfg = join(temp, "cfg");
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "tui.json"), "[]\n");
  assert.throws(() => run(["--target", cfg], { stdio: "pipe" }), /Refusing/i);
  // After --force, the array is backed up and a clean object tui.json is written.
  run(["--target", cfg, "--force"]);
  assert.equal(existsSync(join(cfg, "tui.json.goal-mode-backup")), true);
  const after = JSON.parse(readFileSync(join(cfg, "tui.json"), "utf8"));
  assert.equal(Array.isArray(after), false, "tui.json is now a clean object, not the adopted array");
  assert.ok(Array.isArray(after.plugin) && after.plugin.includes("opencode-goal-mode"), "sidebar entry registered");
});

test("REGRESSION: uninstall cleans tui.json before removing the manifest (orphan-safe)", () => {
  // If tui.json is invalid, uninstall must throw BEFORE deleting the manifest, so a
  // re-run can still reach the manifest and complete. Previously the manifest was
  // removed first, leaving a stuck sidebar reference that --uninstall could no
  // longer touch (the manifest was already gone).
  const temp = mkdtempSync(join(tmpdir(), "goal-uninstall-order-"));
  const cfg = join(temp, "cfg");
  run(["--target", cfg]); // normal install
  const manifestPath = join(cfg, ".goal-mode-manifest.json");
  assert.equal(existsSync(manifestPath), true);
  // Corrupt tui.json so removal would throw without --force.
  writeFileSync(join(cfg, "tui.json"), "{broken\n");
  assert.throws(() => run(["--target", cfg, "--uninstall"], { stdio: "pipe" }), /Refusing/i);
  // The manifest is STILL present (removal happens only after tui.json succeeds),
  // so a retry with --force can complete a full uninstall.
  assert.equal(existsSync(manifestPath), true, "manifest preserved so a retry can still uninstall");
  run(["--target", cfg, "--uninstall", "--force"]);
  assert.equal(existsSync(manifestPath), false, "manifest removed after --force completes");
});

test("REGRESSION: --target '~' is expanded to the home directory", () => {
  // A quoted/programmatic `--target '~/x'` previously created a literal '~' dir.
  const home = homedir();
  if (!home) return; // nothing to expand against in this environment
  const rel = join(".goal-install-tilde-test-" + process.pid);
  try {
    const out = run(["--target", join("~", rel), "--dry-run"]);
    assert.match(out, /Would (install|copy|register)/i);
    // A literal '~' directory must NOT be created under CWD.
    assert.equal(existsSync(join(process.cwd(), "~")), false);
  } finally {
    rmSync(join(home, rel), { recursive: true, force: true });
  }
});

test("uninstall ignores tampered manifest paths outside the target", () => {
  const temp = mkdtempSync(join(tmpdir(), "goal-manifest-safe-"));
  const cfg = join(temp, "cfg");
  run(["--target", cfg]);
  const manifest = JSON.parse(readFileSync(join(cfg, ".goal-mode-manifest.json"), "utf8"));
  manifest.files["../outside.txt"] = "0000000000000000";
  writeFileSync(join(cfg, ".goal-mode-manifest.json"), JSON.stringify(manifest));
  assert.throws(() => run(["--target", cfg, "--uninstall"], { stdio: "pipe" }), /outside target/);
});
