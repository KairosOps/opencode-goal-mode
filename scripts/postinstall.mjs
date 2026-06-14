#!/usr/bin/env node
/**
 * Auto-setup on a GLOBAL install.
 *
 * When a user runs `npm install -g opencode-goal-mode` (a fresh install OR an
 * upgrade), this runs the installer for them so that, with a single command, the
 * package's components are (re)copied into `~/.config/opencode`, the Goal sidebar
 * is registered in `tui.json`, and OpenCode's stale plugin cache is cleared so the
 * just-installed version actually loads. That makes `npm install -g` "really
 * update" — no separate `opencode-goal-mode --global` step required.
 *
 * Safety:
 *  - Runs ONLY for global installs (npm sets `npm_config_global`). Repo development
 *    (`npm ci` / `npm install`) and installs as a project dependency are no-ops, so
 *    this never writes to a user's config when it shouldn't.
 *  - Best-effort: it NEVER fails the npm install. Any problem prints a one-line
 *    hint to run `opencode-goal-mode --global` manually and exits 0.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

function isGlobalInstall() {
  const g = process.env.npm_config_global;
  return g === "true" || g === "1" || g === true;
}

if (!isGlobalInstall()) {
  // Local/dev/dependency install — do not touch the user's OpenCode config.
  process.exit(0);
}

try {
  const installer = join(dirname(fileURLToPath(import.meta.url)), "install.mjs");
  console.log("opencode-goal-mode: global install detected — updating ~/.config/opencode…");
  const res = spawnSync(process.execPath, [installer, "--global"], { stdio: "inherit" });
  // spawnSync does not throw on a non-zero exit (e.g. the installer refused to
  // overwrite a file you edited). Surface a clear, actionable hint instead of
  // leaving only the child's raw error.
  if (res.error || res.status !== 0) {
    console.warn(
      "opencode-goal-mode: auto-setup didn't fully complete. " +
        "Run `opencode-goal-mode --global` manually (add --force to replace files you've edited), then restart OpenCode.",
    );
  }
} catch (err) {
  console.warn(
    `opencode-goal-mode: auto-setup skipped (${(err && err.message) || err}). ` +
      "Run `opencode-goal-mode --global` to finish, then restart OpenCode.",
  );
}
// Never fail `npm install`, regardless of the installer's outcome.
process.exit(0);
