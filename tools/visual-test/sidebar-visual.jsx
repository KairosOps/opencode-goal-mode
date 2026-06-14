/**
 * Visual + behavioral test for the real goal-sidebar.tsx TUI component.
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

const sidebarMod = await import(join(REPO, "plugins/goal-sidebar.tsx"));
const tui = sidebarMod.tui || sidebarMod.default?.tui; // entry exports `default { id, tui }`
const { stateBaseDir, projectKey } = await import(join(REPO, "plugins/goal-guard/persistence.js"));
const { createState } = await import(join(REPO, "plugins/goal-guard/state.js"));

const YELLOW = [255, 215, 0]; // running
const RED = [255, 85, 85]; // done
const GREEN = [0, 255, 0]; // custom

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
async function render({ worktree, sessionId = "s1", options, width = 44, height = 10 }) {
  const { api, getSlot } = mockApi(worktree);
  await tui(api, options);
  const slot = getSlot();
  if (typeof slot !== "function") return { frame: "", spans: [], t: null, registered: false };
  const t = await testRender(() => slot({}, { session_id: sessionId }), { width, height });
  await t.renderOnce();
  return { frame: t.captureCharFrame(), spans: t.renderer.currentRenderBuffer.getSpanLines(), t, registered: true };
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
    writeSnapshot("/proj/withgoal", [["s1", session({ contract: { title: "Ship the OAuth refactor", original: "the user wants us to finish migrating the oauth flow and delete the legacy code path entirely" }, touchedAt: 9 })]]);
    const { frame, spans } = await render({ worktree: "/proj/withgoal" });
    banner("Goal RUNNING (rainbow first display, AI title)"); show(frame);
    check("shows the AI title, not the long original", frame.includes("Ship the OAuth refactor") && !frame.includes("legacy code path"));
    check("shows the GOAL label", frame.includes("GOAL"));
    check("GOAL label is on its OWN line (not joined to the goal title)", frame.split("\n").some((l) => l.trim() === "GOAL") && !/GOAL +Ship the OAuth/.test(frame));
    check("NO orb (◆)", !frame.includes("◆"));
    check("does NOT show 'No goal'", !frame.includes("No goal"));
    check("GOAL label starts rainbow red (first-display)", sameColor(spanFor(spans, "GOAL")?.rgba, [255, 85, 85]));
    check("goal title is rainbow orange on the next line (first-display)", sameColor(spanFor(spans, "Ship the OAuth refactor")?.rgba, [255, 170, 0]));
    check("GOAL label is bold", spanFor(spans, "GOAL")?.attr === 1);
    check("status line shows gates · in progress and NO 'changes pending'", /\d\/\d gates · in progress/.test(frame) && !frame.includes("changes pending"), frame);
  }
  {
    writeSnapshot("/proj/nogoal", [["s1", session({ touchedAt: 3 })]]);
    const { frame, registered } = await render({ worktree: "/proj/nogoal" });
    banner("Task running, NO goal (native todo untouched)"); show(frame);
    check("renders nothing so native todo can remain", registered === true && !frame.includes("No goal") && !frame.includes("GOAL"));
  }
  {
    writeSnapshot("/proj/mixed", [
      ["goal-session", session({ goalText: "Visible only in Goal", touchedAt: 9 })],
      ["build-session", Object.assign(createState("2026-01-01T00:00:00.000Z"), { active: false, touchedAt: 10 })],
    ]);
    const { api, getSlot } = mockApi("/proj/mixed");
    await tui(api, { sidebarRainbowMs: 0 });
    const slot = getSlot();
    const t = await testRender(() => slot({}, { session_id: "build-session" }), { width: 44, height: 10 });
    await t.renderOnce();
    const frame = t.captureCharFrame();
    banner("Mixed worktree, Build session"); show(frame);
    check("registered Goal slot does not render for Build session", !frame.includes("Visible only in Goal") && !frame.includes("GOAL"));
    const noProps = slot({}, {});
    check("slot invocation without session id returns nothing", noProps === undefined);
  }
  {
    // Two ACTIVE goal sessions in the SAME worktree must not bleed into each other.
    writeSnapshot("/proj/two-goals", [
      ["sess-alpha", session({ contract: { title: "Goal Alpha", original: "alpha" }, touchedAt: 5 })],
      ["sess-beta", session({ contract: { title: "Goal Beta", original: "beta" }, touchedAt: 99 })],
    ]);
    const { api, getSlot } = mockApi("/proj/two-goals");
    await tui(api, { sidebarRainbowMs: 0 });
    const slot = getSlot();
    const renderSession = async (sid) => {
      const t = await testRender(() => slot({}, { session_id: sid }), { width: 44, height: 10 });
      await t.renderOnce();
      return t.captureCharFrame();
    };
    const alpha = await renderSession("sess-alpha");
    const beta = await renderSession("sess-beta");
    banner("Two active goals, same worktree (per-session isolation)");
    console.log("[sess-alpha]"); show(alpha);
    console.log("[sess-beta]"); show(beta);
    check("sess-alpha shows only Goal Alpha", alpha.includes("Goal Alpha") && !alpha.includes("Goal Beta"));
    check("sess-beta shows only Goal Beta (not the most-recently-touched global)", beta.includes("Goal Beta") && !beta.includes("Goal Alpha"));
  }
  {
    const { frame, registered } = await render({ worktree: "/proj/never-touched" });
    banner("No guard state at all (native todo untouched)"); show(frame);
    check("no Goal content is rendered for non-Goal sessions", registered === true && !frame.includes("No goal") && !frame.includes("GOAL"));
  }
  {
    const passing = {};
    for (const g of ["goal-prompt-auditor", "goal-reviewer", "goal-diff-reviewer", "goal-verifier", "goal-final-auditor"]) passing[g] = { verdict: "PASS", seq: 40 };
    writeSnapshot("/proj/done", [["s1", session({ goalText: "Fix the parser bug", latestVerdict: passing, lastEditSeq: 1, reviewCycles: 2, touchedAt: 9 })]]);
    const { frame, spans } = await render({ worktree: "/proj/done" });
    banner("Goal DONE (red)"); show(frame);
    check("shows the goal (no orb)", frame.includes("Fix the parser bug") && !frame.includes("◆"));
    check("done goal is RED", sameColor(spanFor(spans, "Fix the parser bug")?.rgba, RED), JSON.stringify(spanFor(spans, "Fix the parser bug")?.rgba));
    check("done shows gates + 'completed' status", /5\/5 gates/.test(frame) && /completed · 2 review cycles/.test(frame.replace(/\s+/g,' ')), frame.replace(/\s+/g,' '));
  }
  {
    writeSnapshot("/proj/green", [["s1", session({ goalText: "Custom colour goal", touchedAt: 9 })]]);
    const { frame, spans } = await render({ worktree: "/proj/green", options: { sidebarColor: "#00FF00", sidebarRainbowMs: 0 } });
    banner("Custom colour (#00FF00)"); show(frame);
    check("GOAL label uses the custom colour (goal title stays its own colour)", sameColor(spanFor(spans, "GOAL")?.rgba, GREEN));
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
    t?.resize(10, 4); await t?.renderOnce();
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
