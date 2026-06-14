import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shortGoalLabel, sidebarView } from "../plugins/goal-guard/summary.js";
import { createState } from "../plugins/goal-guard/state.js";
import { DEFAULT_CONFIG, resolveConfig } from "../plugins/goal-guard/config.js";
import { analyzeCommand } from "../plugins/goal-guard/shell.js";
import { readSidebarModel, pickSession, sidebarStateFile } from "../plugins/goal-guard/sidebar-data.js";

function activeState(over = {}) {
  return Object.assign(createState("2026-01-01T00:00:00.000Z"), { active: true }, over);
}

// ---------------------------------------------------------------------------
// shortGoalLabel
// ---------------------------------------------------------------------------

test("shortGoalLabel prefers the contract original, collapsing whitespace", () => {
  const st = activeState({ contract: { original: "  Add   OAuth\n token refresh " }, goalText: "ignored" });
  assert.equal(shortGoalLabel(st), "Add OAuth token refresh");
});

test("shortGoalLabel falls back to goalText and truncates long goals", () => {
  const st = activeState({ goalText: "x".repeat(200) });
  const label = shortGoalLabel(st, 40);
  assert.ok(label.length <= 40, label);
  assert.ok(label.endsWith("…"));
});

test("shortGoalLabel returns empty when nothing is recorded", () => {
  assert.equal(shortGoalLabel(activeState()), "");
});

// ---------------------------------------------------------------------------
// sidebarView
// ---------------------------------------------------------------------------

test("sidebarView is null for an inactive or goal-less session", () => {
  assert.equal(sidebarView(createState(), DEFAULT_CONFIG), null);
  assert.equal(sidebarView(activeState(), DEFAULT_CONFIG), null);
});

test("sidebarView surfaces gates, dirty flag, and readiness", () => {
  const st = activeState({ goalText: "Fix the parser", dirty: true });
  const v = sidebarView(st, DEFAULT_CONFIG);
  assert.equal(v.goal, "Fix the parser");
  assert.equal(v.required, 5); // BASE_GATES
  assert.equal(v.passing, 0);
  assert.equal(v.allowed, false);
  assert.match(v.status, /0\/5 gates · dirty/);
});

// ---------------------------------------------------------------------------
// sidebar-data: pickSession + readSidebarModel
// ---------------------------------------------------------------------------

test("pickSession returns the most-recently-touched active session", () => {
  const snapshot = {
    sessions: [
      ["old", activeState({ goalText: "old goal", touchedAt: 1 })],
      ["new", activeState({ goalText: "new goal", touchedAt: 9 })],
      ["idle", Object.assign(createState(), { goalText: "inactive", touchedAt: 99 })],
    ],
  };
  assert.equal(pickSession(snapshot, undefined).goalText, "new goal");
  assert.equal(pickSession(snapshot, "old").goalText, "old goal");
  // An explicit but inactive id falls back to the active pick.
  assert.equal(pickSession(snapshot, "idle").goalText, "new goal");
});

test("readSidebarModel reads the guard's persisted snapshot for a worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-sidebar-"));
  try {
    const env = { XDG_STATE_HOME: dir };
    const worktree = "/some/project";
    const file = sidebarStateFile(worktree, env);
    mkdirSync(join(file, ".."), { recursive: true });
    const snapshot = {
      version: 1,
      seq: 3,
      sessions: [["s1", activeState({ contract: { original: "Ship the sidebar" }, touchedAt: 5 })]],
    };
    writeFileSync(file, JSON.stringify(snapshot));

    const model = readSidebarModel({ worktree, env });
    assert.equal(model.goal, "Ship the sidebar");
    assert.equal(model.required, 5);

    // Unknown worktree → no file → null, never throws.
    assert.equal(readSidebarModel({ worktree: "/nope", env }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// New config fields
// ---------------------------------------------------------------------------

test("new toggles default on and coerce from options/env", () => {
  assert.equal(DEFAULT_CONFIG.toastOnReview, true);
  assert.equal(DEFAULT_CONFIG.sidebarBanner, true);
  assert.equal(DEFAULT_CONFIG.sidebarColor, "#FFD700");

  const c = resolveConfig({ toastOnReview: false, sidebarColor: "#00FF00" }, {});
  assert.equal(c.toastOnReview, false);
  assert.equal(c.sidebarColor, "#00FF00");

  const e = resolveConfig(undefined, { GOAL_GUARD_SIDEBAR_BANNER: "off", GOAL_GUARD_SIDEBAR_COLOR: "#123456" });
  assert.equal(e.sidebarBanner, false);
  assert.equal(e.sidebarColor, "#123456");
});

// ---------------------------------------------------------------------------
// New destructive bins surfaced by the external benchmark
// ---------------------------------------------------------------------------

test("analyzer now blocks mkfs.<fstype>, srm, and mkswap", () => {
  for (const cmd of [
    "mkfs.ext4 /dev/sdb1",
    "mkfs.erofs image.erofs root/",
    "srm secret.key",
    "srm -r path/to/dir",
    "sudo mkswap /dev/sdXY",
  ]) {
    assert.equal(analyzeCommand(cmd).destructive, true, cmd);
  }
});
