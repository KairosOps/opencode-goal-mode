/**
 * Visual + behavioral test for the real goal-sidebar.js TUI component.
 *
 * Renders the actual shipped slot component HEADLESSLY with @opentui/solid's
 * testRender, prints each frame so the rendering is visible, and asserts both the
 * text content and the exact foreground colours / bold attributes via the
 * renderer's span buffer. This is how the experimental sidebar is visually
 * verified without a live OpenCode TUI.
 *
 * Requires Bun and the OpenTUI stack (peers provided by OpenCode at runtime, not
 * package deps). From the repo root:
 *
 *   npm install --no-save @opentui/solid@0.4.1 @opentui/core@0.4.1 solid-js@1.9.12
 *   npm run test:visual        # → bun tools/visual-test/sidebar-visual.jsx
 *
 * If the OpenTUI stack is not installed it prints a SKIP and exits 0, so it never
 * breaks a normal `npm test` / CI run (it is not part of node --test discovery).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let testRender;
try {
  ({ testRender } = await import("@opentui/solid"));
} catch {
  console.log("SKIP: @opentui/solid not installed. Run:\n" +
    "  npm install --no-save @opentui/solid@0.4.1 @opentui/core@0.4.1 solid-js@1.9.12\n" +
    "  npm run test:visual   (needs Bun)");
  process.exit(0);
}

const REPO = new URL("../../", import.meta.url).pathname;

const XDG = mkdtempSync(join(tmpdir(), "goal-sidebar-visual-"));
process.env.XDG_STATE_HOME = XDG;

const { tui } = await import(join(REPO, "plugins/goal-sidebar.js"));
const { stateBaseDir, projectKey } = await import(join(REPO, "plugins/goal-guard/persistence.js"));
const { createState } = await import(join(REPO, "plugins/goal-guard/state.js"));

const YELLOW = [255, 215, 0];
const GREY = [128, 128, 128];
const GREEN = [0, 255, 0];

function writeSnapshot(worktree, sessions) {
  const dir = stateBaseDir(process.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${projectKey(worktree)}.json`), JSON.stringify({ version: 1, seq: 50, touchCounter: 5, sessions }));
}
function session(over) {
  return Object.assign(createState("2026-01-01T00:00:00.000Z"), { active: true }, over);
}
function mockApi(worktree) {
  let captured = null;
  const api = {
    slots: { register: (p) => ((captured = p), "reg-id") },
    state: { path: { worktree, directory: worktree } },
    event: { on: () => () => {} },
    lifecycle: { onDispose: () => () => {} },
    theme: { current: {} },
  };
  return { api, getSlot: () => captured?.slots?.sidebar_content };
}
async function render({ worktree, sessionId = "s1", options, width = 44, height = 5 }) {
  const { api, getSlot } = mockApi(worktree);
  await tui(api, options);
  const slot = getSlot();
  if (typeof slot !== "function") throw new Error("sidebar_content slot was not registered");
  const t = await testRender(() => slot({}, { session_id: sessionId }), { width, height });
  await t.renderOnce();
  return { frame: t.captureCharFrame(), spans: t.renderer.currentRenderBuffer.getSpanLines(), t };
}
function spanFor(spans, substr) {
  for (const line of spans || []) for (const s of line.spans || []) {
    if (s.text && s.text.includes(substr)) {
      const b = s.fg?.buffer || {};
      return { rgba: [b[0], b[1], b[2]], attr: s.attributes };
    }
  }
  return null;
}
const sameColor = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed += 1; console.log(`  ✔ ${name}`); }
  else { failed += 1; console.log(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const banner = (t) => console.log(`\n=== ${t} ===`);
const show = (f) => console.log(f.replace(/ +$/gm, "").replace(/\n+$/, ""));

try {
  {
    writeSnapshot("/proj/withgoal", [["s1", session({ contract: { original: "Ship the OAuth refactor" }, touchedAt: 9 })]]);
    const { frame, spans } = await render({ worktree: "/proj/withgoal" });
    banner("Goal set"); show(frame);
    check("shows the goal text", frame.includes("Ship the OAuth refactor"));
    check("shows the GOAL label", frame.includes("GOAL"));
    check("does NOT show 'No goal'", !frame.includes("No goal"));
    check("goal text is shining yellow", sameColor(spanFor(spans, "Ship the OAuth refactor")?.rgba, YELLOW));
    check("GOAL label is bold", spanFor(spans, "GOAL")?.attr === 1);
    check("shows a gate count", /\d\/\d gates/.test(frame));
  }
  {
    writeSnapshot("/proj/nogoal", [["s1", session({ touchedAt: 3 })]]);
    const { frame, spans } = await render({ worktree: "/proj/nogoal" });
    banner("Running task, no goal"); show(frame);
    check("shows 'No goal'", frame.includes("No goal"));
    check("nothing else (no glyph/gates)", !frame.includes("◆") && !frame.includes("gates"));
    check("'No goal' is grey", sameColor(spanFor(spans, "No goal")?.rgba, GREY));
    check("'No goal' is not bold", spanFor(spans, "No goal")?.attr === 0);
  }
  {
    const { frame, spans } = await render({ worktree: "/proj/never-touched" });
    banner("No guard state at all"); show(frame);
    check("grey 'No goal' fallback", frame.includes("No goal") && sameColor(spanFor(spans, "No goal")?.rgba, GREY));
  }
  {
    const passing = {};
    for (const g of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) passing[g] = { verdict: "PASS", seq: 40 };
    writeSnapshot("/proj/ready", [["s1", session({ goalText: "Fix the parser bug", latestVerdict: passing, lastEditSeq: 1, touchedAt: 9 })]]);
    const { frame } = await render({ worktree: "/proj/ready" });
    banner("All gates pass (ready)"); show(frame);
    check("status shows 'ready'", /5\/5 gates · ready/.test(frame), frame.split("\n")[1]);
  }
  {
    writeSnapshot("/proj/green", [["s1", session({ goalText: "Custom colour goal", touchedAt: 9 })]]);
    const { frame, spans } = await render({ worktree: "/proj/green", options: { sidebarColor: "#00FF00" } });
    banner("Custom colour (#00FF00)"); show(frame);
    check("goal uses the custom colour", sameColor(spanFor(spans, "Custom colour goal")?.rgba, GREEN));
  }
  {
    writeSnapshot("/proj/long", [["s1", session({ goalText: "X".repeat(200), touchedAt: 9 })]]);
    const { frame } = await render({ worktree: "/proj/long", width: 60 });
    banner("Long goal (truncation)"); show(frame);
    check("truncated with …", frame.includes("…"));
  }
  {
    const { getSlot, api } = mockApi("/proj/disabled");
    await tui(api, { sidebarBanner: false });
    check("disabled: no slot registered", getSlot() === undefined);
  }
  {
    let threw = false;
    try { await tui({ state: { path: { worktree: "/x" } } }, {}); } catch { threw = true; }
    check("no slot API: no-op without throwing", threw === false);
  }
  {
    writeSnapshot("/proj/narrow", [["s1", session({ goalText: "Narrow", touchedAt: 9 })]]);
    const { t, frame } = await render({ worktree: "/proj/narrow", width: 16, height: 4 });
    t.resize(10, 4); await t.renderOnce();
    banner("Narrow resize"); show(frame);
    check("narrow render produced output", frame.length > 0);
  }
} catch (err) {
  console.error("\nHARNESS ERROR:", err?.stack || err);
  failed += 1;
} finally {
  rmSync(XDG, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "✅" : "❌"} sidebar visual test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
