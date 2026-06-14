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

test("shortGoalLabel prefers the AI-generated contract.title over original/goalText", () => {
  const st = activeState({
    contract: { title: "Rate-limit the login endpoint", original: "please add some kind of rate limiting to the /login route and prove it" },
    goalText: "please add some kind of rate limiting to the /login route and prove it",
  });
  assert.equal(shortGoalLabel(st), "Rate-limit the login endpoint");
});

test("sidebarView surfaces the AI title as the goal", () => {
  const st = activeState({ contract: { title: "Migrate auth to JWT", original: "x" }, goalText: "x" });
  assert.equal(sidebarView(st, DEFAULT_CONFIG).goal, "Migrate auth to JWT");
});

// ---------------------------------------------------------------------------
// sidebarView
// ---------------------------------------------------------------------------

test("sidebarView reports state 'none' for an inactive or goal-less session", () => {
  assert.equal(sidebarView(createState(), DEFAULT_CONFIG).state, "none");
  assert.equal(sidebarView(activeState(), DEFAULT_CONFIG).state, "none");
  // Never null — the sidebar always has something to render ("No goal available").
  assert.ok(sidebarView(undefined, DEFAULT_CONFIG));
  assert.equal(sidebarView(undefined, DEFAULT_CONFIG).state, "none");
});

test("sidebarView state 'running' (yellow) with stacked gates + status lines", () => {
  const st = activeState({ goalText: "Fix the parser", dirty: true });
  const v = sidebarView(st, DEFAULT_CONFIG);
  assert.equal(v.state, "running");
  assert.equal(v.goal, "Fix the parser");
  assert.equal(v.required, 5); // BASE_GATES
  assert.equal(v.passing, 0);
  assert.equal(v.gates, "0/5 gates");
  assert.equal(v.status, "in progress · changes pending");
  assert.equal(v.todoTitle, "Goal todos");
  assert.ok(v.todos.some((item) => item.text.includes("Rerun verification")));
});

test("sidebarView builds structured Goal todos from acceptance criteria and evidence", () => {
  const st = activeState({
    contract: { title: "Ship installer", acceptanceCriteria: ["README explains install", "Installer dry-run works"] },
    evidence: [{ command: "npm test", result: "passed", criteria: ["README explains install"], seq: 2 }],
    lastEditSeq: 1,
  });
  const v = sidebarView(st, DEFAULT_CONFIG);
  assert.deepEqual(v.todos.slice(0, 2), [
    { status: "done", text: "README explains install" },
    { status: "todo", text: "Installer dry-run works" },
  ]);
});

// ---------------------------------------------------------------------------
// sidebar-data: pickSession + readSidebarModel
// ---------------------------------------------------------------------------

test("pickSession is strictly session-scoped (no global fallback)", () => {
  const snapshot = {
    sessions: [
      ["old", activeState({ goalText: "old goal", touchedAt: 1 })],
      ["new", activeState({ goalText: "new goal", touchedAt: 9 })],
      ["idle", Object.assign(createState(), { goalText: "inactive", touchedAt: 99 })],
    ],
  };
  // Each session sees only its OWN goal — never the most-recently-touched one.
  assert.equal(pickSession(snapshot, "old").goalText, "old goal");
  assert.equal(pickSession(snapshot, "new").goalText, "new goal");
  // No session id → render nothing (no global "latest goal" leak).
  assert.equal(pickSession(snapshot, undefined), null);
  // An explicit inactive/non-Goal or unknown session must not fall back to another Goal.
  assert.equal(pickSession(snapshot, "idle"), null);
  assert.equal(pickSession(snapshot, "missing"), null);
});

test("readSidebarModel is strictly session-scoped in mixed Goal/Build snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-sidebar-mixed-"));
  try {
    const env = { XDG_STATE_HOME: dir };
    const worktree = "/mixed/project";
    const file = sidebarStateFile(worktree, env);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessions: [
          ["goal-session", activeState({ contract: { title: "Real Goal" }, touchedAt: 9 })],
          ["build-session", Object.assign(createState(), { active: false, touchedAt: 10 })],
        ],
      }),
    );

    assert.equal(readSidebarModel({ worktree, sessionId: "goal-session", env }).goal, "Real Goal");
    assert.equal(readSidebarModel({ worktree, sessionId: "build-session", env }).state, "none");
    assert.equal(readSidebarModel({ worktree, sessionId: "unknown-session", env }).state, "none");
    // No session id → render nothing. There is no global "latest goal" fallback that
    // a Build/other session in the same worktree could inherit.
    assert.equal(readSidebarModel({ worktree, env }).state, "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

    const model = readSidebarModel({ worktree, sessionId: "s1", env });
    assert.equal(model.state, "running");
    assert.equal(model.goal, "Ship the sidebar");

    // Unknown worktree → no file → state:"none" (renders nothing), never throws.
    assert.equal(readSidebarModel({ worktree: "/nope", sessionId: "s1", env }).state, "none");
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
  assert.equal(DEFAULT_CONFIG.sidebarDoneColor, "#FF5555");
  assert.equal(DEFAULT_CONFIG.sidebarMutedColor, "#808080");
  assert.equal(DEFAULT_CONFIG.sidebarRainbowMs, 4500);

  const c = resolveConfig({ toastOnReview: false, sidebarColor: "#00FF00", sidebarDoneColor: "#FF0000", sidebarMutedColor: "#111111" }, {});
  assert.equal(c.toastOnReview, false);
  assert.equal(c.sidebarColor, "#00FF00");
  assert.equal(c.sidebarDoneColor, "#FF0000");
  assert.equal(c.sidebarMutedColor, "#111111");

  const e = resolveConfig(undefined, {
    GOAL_GUARD_SIDEBAR_BANNER: "off",
    GOAL_GUARD_SIDEBAR_COLOR: "#123456",
    GOAL_GUARD_SIDEBAR_DONE_COLOR: "#abcdef",
    GOAL_GUARD_SIDEBAR_MUTED_COLOR: "#654321",
    GOAL_GUARD_SIDEBAR_RAINBOW_MS: "1000",
  });
  assert.equal(e.sidebarBanner, false);
  assert.equal(e.sidebarColor, "#123456");
  assert.equal(e.sidebarDoneColor, "#abcdef");
  assert.equal(e.sidebarMutedColor, "#654321");
  assert.equal(e.sidebarRainbowMs, 1000);
});

// ---------------------------------------------------------------------------
// Robustness: a running task with no goal, and malformed/partial state
// ---------------------------------------------------------------------------

test("active session with no goal text → state 'none' (TUI renders nothing)", () => {
  const running = activeState(); // active but no contract/goalText
  assert.equal(sidebarView(running, DEFAULT_CONFIG).state, "none");
});

test("readSidebarModel never throws on malformed/partial snapshots", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-sidebar-bad-"));
  try {
    const env = { XDG_STATE_HOME: dir };
    const worktree = "/p";
    const file = sidebarStateFile(worktree, env);
    mkdirSync(join(file, ".."), { recursive: true });

    for (const bad of ["not json{", "{}", '{"sessions":null}', '{"sessions":[["k",null]]}', '{"sessions":[[1,2,3]]}', "[]"]) {
      writeFileSync(file, bad);
      const m = readSidebarModel({ worktree, env });
      assert.ok(m && m.state === "none", `bad input handled: ${bad}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pickSession tolerates malformed entries and missing fields", () => {
  assert.equal(pickSession(null, "a"), null);
  assert.equal(pickSession({}, "a"), null);
  assert.equal(pickSession({ sessions: "x" }, "a"), null);
  assert.equal(pickSession({ sessions: [["k", null], [1, 2, 3], ["a", { active: false }]] }, "a"), null);
  const ok = pickSession({ sessions: [["a", activeState({ goalText: "g", touchedAt: 1 })]] }, "a");
  assert.equal(ok.goalText, "g");
});

test("sidebarView state 'done' (red) when every gate passes and the tree is clean", () => {
  const st = activeState({
    goalText: "Add auth tokens",
    latestVerdict: {
      "goal-prompt-auditor": { verdict: "PASS", seq: 9 },
      "goal-reviewer": { verdict: "PASS", seq: 9 },
      "goal-diff-reviewer": { verdict: "PASS", seq: 9 },
      "goal-verifier": { verdict: "PASS", seq: 9 },
      "goal-final-auditor": { verdict: "PASS", seq: 9 },
      "goal-security-reviewer": { verdict: "PASS", seq: 9 }, // contextual: "auth tokens"
    },
    stickyGates: ["goal-security-reviewer"],
    lastEditSeq: 1,
    reviewCycles: 2,
    dirty: false,
  });
  const v = sidebarView(st, DEFAULT_CONFIG);
  assert.equal(v.state, "done");
  assert.equal(v.gates, "6/6 gates");
  assert.equal(v.status, "completed · 2 review cycles");
  assert.ok(v.todos.every((item) => item.status === "done"));
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
